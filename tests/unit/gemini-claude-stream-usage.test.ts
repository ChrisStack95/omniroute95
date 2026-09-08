import test from "node:test";
import assert from "node:assert/strict";
import "../_setup/isolateDataDir.ts";

// Exercise the real SSE pipeline and local accounting without provider requests.
test.mock.method(globalThis, "fetch", async () => {
  throw new Error("Unexpected network request in Gemini usage regression test");
});
const { createSSEStream } = await import("../../open-sse/utils/stream.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { getLoggedInputTokens } = await import("../../src/lib/usage/tokenAccounting.ts");
const { computeCostFromPricing } = await import("../../src/lib/usage/costCalculator.ts");

type Completed = Parameters<NonNullable<Parameters<typeof createSSEStream>[0]["onComplete"]>>[0];

for (const scenario of [
  { name: "uncached", cached: undefined, output: 7, thoughts: 3 },
  { name: "zero cache", cached: 0, output: 7, thoughts: 3 },
  { name: "partial cache", cached: 90, output: 7, thoughts: 3 },
  { name: "full cache and zero output", cached: 100, output: 0, thoughts: 0 },
  { name: "full cache and missing output", cached: 100, output: undefined, thoughts: 0 },
  { name: "wrapped partial cache", cached: 90, output: 7, thoughts: 3, wrapped: true },
  {
    name: "wrapped full cache and zero output",
    cached: 100,
    output: 0,
    thoughts: 0,
    wrapped: true,
  },
]) {
  test(`Gemini -> Claude SSE accounting: ${scenario.name}`, async () => {
    const completed: Completed[] = [];
    const chunks = [
      {
        candidates: [{ content: { parts: [{ text: "hello" }] } }],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: scenario.cached,
          candidatesTokenCount: scenario.output,
          thoughtsTokenCount: scenario.thoughts,
        },
      },
      // Usage must survive a later terminal event with no usage metadata.
      { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] },
    ];
    const upstream = chunks
      .map((chunk) => `data: ${JSON.stringify(scenario.wrapped ? { response: chunk } : chunk)}\n\n`)
      .join("");
    const bytes = new TextEncoder().encode(upstream);
    const input = new ReadableStream({
      start(controller) {
        // Split within JSON fields as a real transport can do.
        for (let offset = 0; offset < bytes.length; offset += 17) {
          controller.enqueue(bytes.slice(offset, offset + 17));
        }
        controller.close();
      },
    });
    const wire = await new Response(
      input.pipeThrough(
        createSSEStream({
          mode: "translate",
          targetFormat: scenario.wrapped ? FORMATS.ANTIGRAVITY : FORMATS.GEMINI,
          sourceFormat: FORMATS.CLAUDE,
          provider: "gemini",
          model: "gemini-2.5-pro",
          body: { messages: [{ role: "user", content: "hi" }] },
          onComplete: (payload) => completed.push(payload),
        })
      )
    ).text();

    const events = wire
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const cached = scenario.cached ?? 0;
    const output = (scenario.output ?? 0) + scenario.thoughts;
    const deltas = events.filter((event) => event.type === "message_delta");
    assert.equal(deltas.length, 1);
    assert.deepEqual(deltas[0].usage, {
      input_tokens: 100 - cached,
      output_tokens: output,
      ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    });
    assert.equal(deltas[0].delta.stop_reason, "end_turn");
    assert.equal(events.filter((event) => event.type === "message_stop").length, 1);
    assert.equal(events.at(-1).type, "message_stop");
    assert.ok(events.some((event) => event.delta?.text === "hello"));

    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, 200);
    const usage = completed[0].usage as Record<string, number>;
    assert.equal(getLoggedInputTokens(usage), 100, "must retain metered usage, not an estimate");
    const responseBody = completed[0].responseBody as { usage: unknown };
    assert.deepEqual(responseBody.usage, {
      prompt_tokens: 100,
      completion_tokens: output,
      total_tokens: 100 + output,
    });
    assert.match(wire, /^: x-omniroute-tokens-in=100$/m);
    assert.match(wire, new RegExp(`^: x-omniroute-tokens-out=${output}$`, "m"));

    // The pricing consumer must subtract cache exactly once from the full prompt.
    const cost = computeCostFromPricing({ input: 2, cached: 0.5, output: 3 }, usage);
    const expectedCost = ((100 - cached) * 2 + cached * 0.5 + output * 3) / 1_000_000;
    assert.ok(Math.abs(cost - expectedCost) < 1e-12, `${cost} != ${expectedCost}`);
  });
}
