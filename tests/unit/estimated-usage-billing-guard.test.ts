// RED characterization for f1-estimated-billing: estimated usage must not be
// billed like real usage. Fully estimated usage is skipped; partially
// estimated usage (provider-reported output + grafted input estimate) is
// billed on the real portion only. Covers the streaming cost hook, the
// quota-share call sites, the graft helper, and the graft stream site.
import { test } from "node:test";
import assert from "node:assert/strict";

const { recordStreamingCost } = await import(
  "../../open-sse/handlers/chatCore/streamingCost.ts"
);
const {
  isEstimatedUsage,
  isPartiallyEstimatedUsage,
  stripEstimatedPromptTokens,
  withGraftedPromptTokens,
} = await import("../../open-sse/utils/usageTracking.ts");
const {
  selectBillingUsage,
  shouldSkipQuotaShare,
} = await import("../../open-sse/utils/billingDecision.ts");

function costSpies(costValue: number) {
  const calls: Array<{ provider: string; model: string; usage: unknown }> = [];
  const recorded: Array<{ apiKeyId: string; cost: number }> = [];
  return {
    calls,
    recorded,
    calculateCost: async (provider: string, model: string, usage: unknown) => {
      calls.push({ provider, model, usage });
      return costValue;
    },
    recordCost: (apiKeyId: string, cost: number) => {
      recorded.push({ apiKeyId, cost });
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// R1: streaming cost hook must skip fully estimated usage.
test("R1 RED: recordStreamingCost skips fully estimated usage", async () => {
  const s = costSpies(0.5);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-x",
    streamUsage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, estimated: true },
    calculateCost: s.calculateCost,
    recordCost: s.recordCost,
  });
  await waitFor(() => s.recorded.length > 0 || s.calls.length > 0);
  assert.equal(s.calls.length, 0, "calculateCost must not run on estimated usage");
  assert.equal(s.recorded.length, 0, "recordCost must not run on estimated usage");
});

// R2: graft helper marks the grafted input and totals graft + real output.
// Fixture mirrors the real Ollama wire: total_tokens 0.
test("R2 RED: withGraftedPromptTokens flags graft, total = graft + completion", () => {
  const out = withGraftedPromptTokens(
    { prompt_tokens: 0, completion_tokens: 10, total_tokens: 0 },
    7
  ) as Record<string, unknown>;
  assert.equal(out.prompt_tokens, 7);
  assert.equal(out.completion_tokens, 10);
  assert.equal(out.total_tokens, 17);
  assert.equal(out.estimated_prompt_tokens, true);
  assert.equal(out.estimated, undefined);
});

// R3: streaming cost hook bills only the real portion of partial usage.
test("R3 RED: recordStreamingCost bills partial usage without grafted input", async () => {
  const s = costSpies(0.2);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-x",
    streamUsage: {
      prompt_tokens: 7,
      completion_tokens: 10,
      total_tokens: 17,
      estimated_prompt_tokens: true,
    },
    calculateCost: s.calculateCost,
    recordCost: s.recordCost,
  });
  await waitFor(() => s.recorded.length > 0);
  assert.equal(s.calls.length, 1);
  assert.equal((s.calls[0].usage as Record<string, unknown>).prompt_tokens, 0);
  assert.equal((s.calls[0].usage as Record<string, unknown>).completion_tokens, 10);
});

// R4: billing-usage selector skips estimated, cleans partial, passes real through.
test("R4 RED: selectBillingUsage skips estimated and cleans partial", () => {
  assert.equal(
    selectBillingUsage({ prompt_tokens: 5, completion_tokens: 3, estimated: true }),
    null
  );
  const partial = selectBillingUsage({
    prompt_tokens: 7,
    completion_tokens: 10,
    total_tokens: 17,
    estimated_prompt_tokens: true,
  }) as Record<string, unknown>;
  assert.equal(partial.prompt_tokens, 0);
  assert.equal(partial.completion_tokens, 10);
  const real = selectBillingUsage({ prompt_tokens: 5, completion_tokens: 3 });
  assert.deepEqual(real, { prompt_tokens: 5, completion_tokens: 3 });
});

// R5: quota-share hook decision skips fully estimated usage only.
test("R5 RED: shouldSkipQuotaShare is true for fully estimated usage only", () => {
  assert.equal(shouldSkipQuotaShare({ prompt_tokens: 5, estimated: true }), true);
  assert.equal(
    shouldSkipQuotaShare({
      prompt_tokens: 7,
      completion_tokens: 10,
      estimated_prompt_tokens: true,
    }),
    false
  );
  assert.equal(shouldSkipQuotaShare({ prompt_tokens: 5, completion_tokens: 3 }), false);
  assert.equal(shouldSkipQuotaShare(null), false);
});

// R5b: quota-share payload decision mirrors the call sites (caller-only guard).
test("R5b RED: selectBillingUsage feeds quota-share with skipped or cleaned usage", () => {
  const estimated = { prompt_tokens: 12, completion_tokens: 5, estimated: true };
  assert.equal(shouldSkipQuotaShare(estimated), true);
  const cleaned = selectBillingUsage({
    prompt_tokens: 7,
    completion_tokens: 10,
    total_tokens: 17,
    estimated_prompt_tokens: true,
  }) as Record<string, unknown>;
  assert.equal(cleaned.prompt_tokens, 0);
  assert.equal(cleaned.total_tokens, 10);
});

// R6: graft stream site forwards the provider chunk verbatim on the wire and
// hands a flagged, grafted copy to the billing object (real output only billed).
test("R6 RED: Ollama zero-prompt chunk bills grafted input as flagged, wire stays raw", async () => {
  const { createSSEStream } = await import("../../open-sse/utils/stream.ts");
  const { FORMATS } = await import("../../open-sse/translator/formats.ts");
  const body = { messages: [{ role: "user", content: "Write a 500-line research report" }] };
  // Long leading content so the empty-choices usage chunk grafts at chunk time
  // (not via the tail processor): the wire then carries the provider chunk plus
  // the flagged graft, and the billing object bills real output only.
  const longLead = "background context ".repeat(30);
  let billed: unknown = null;
  const stream = createSSEStream({
    mode: "passthrough" as const,
    body,
    sourceFormat: FORMATS.OPENAI,
    clientResponseFormat: FORMATS.OPENAI,
    provider: "ollamacloud",
    model: "minimax-m3",
    onComplete: (payload: { usage: unknown }) => {
      billed = payload.usage;
    },
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  const enc = new TextEncoder();
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "minimax-m3", choices: [{ index: 0, delta: { content: longLead }, finish_reason: null }] })}\n\n`
    )
  );
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "minimax-m3", choices: [], usage: { prompt_tokens: 0, completion_tokens: 10, total_tokens: 0 } })}\n\n`
    )
  );
  await writer.write(enc.encode("data: [DONE]\n\n"));
  await writer.close();
  const text = await readAll;
  const usageBlocks = text
    .split("\n\n")
    .filter((b) => b.includes('"usage"'))
    .map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim()));
  assert.ok(usageBlocks.length >= 1, "client bytes must carry the usage block");
  const wire = usageBlocks[usageBlocks.length - 1].usage as Record<string, unknown>;
  assert.ok(
    Number(wire.prompt_tokens) > 0,
    `client bytes carry the repaired input count, got ${String(wire.prompt_tokens)}`
  );
  assert.equal(Number(wire.completion_tokens), 10);
  // Wire change assumed per OP1: the repaired input estimate ships to the
  // client flagged, so billed and wire stay consistent.
  assert.equal(wire.estimated_prompt_tokens, true);
  const billedRec = billed as Record<string, unknown>;
  assert.ok(Number(billedRec.prompt_tokens) > 0, "billing object carries the graft");
  assert.equal(billedRec.completion_tokens, 10);
  assert.equal(billedRec.estimated_prompt_tokens, true);
  const billable = selectBillingUsage(billed) as Record<string, unknown>;
  assert.equal(billable.prompt_tokens, 0);
  assert.equal(billable.completion_tokens, 10);
});

// R7 anchor (passes RED and GREEN): real usage bills in full on both paths.
test("R7 anchor: real usage bills in full (cost + quota-share payload)", async () => {
  const s = costSpies(0.5);
  const real = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-x",
    streamUsage: real,
    calculateCost: s.calculateCost,
    recordCost: s.recordCost,
  });
  await waitFor(() => s.recorded.length > 0);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].usage, real);
  assert.deepEqual(selectBillingUsage(real), real);
  assert.equal(shouldSkipQuotaShare(real), false);
  assert.equal(isEstimatedUsage(real), false);
  assert.equal(isPartiallyEstimatedUsage(real), false);
});

// R7b: helper predicates and strip keep real fields on both formats.
test("R7b: predicates order (fully estimated wins) and Claude-format strip", () => {
  assert.equal(isEstimatedUsage({ estimated: true }), true);
  assert.equal(
    isPartiallyEstimatedUsage({ estimated: true, estimated_prompt_tokens: true }),
    false
  );
  assert.equal(isPartiallyEstimatedUsage({ estimated_prompt_tokens: true }), true);
  const stripped = stripEstimatedPromptTokens({
    input_tokens: 9,
    output_tokens: 4,
    total_tokens: 13,
    estimated_prompt_tokens: true,
  }) as Record<string, unknown>;
  assert.equal(stripped.input_tokens, 0);
  assert.equal(stripped.prompt_tokens, 0);
  assert.equal(stripped.output_tokens, 4);
  assert.equal(stripped.total_tokens, 4);
});

// M1 RED: zero-input repairs flag the graft on every format, and the strip
// zeroes the repaired input while billing real output only.
test("M1 RED: Claude zero-input repair flags partial estimate", async () => {
  const { sanitizeProviderUsageForRequest } =
    await import("../../open-sse/utils/usageTracking.ts");
  const { FORMATS } = await import("../../open-sse/translator/formats.ts");
  const body = {
    model: "m",
    messages: [{ role: "user", content: "Write a 500-line research report" }],
  };
  const repaired = sanitizeProviderUsageForRequest(
    { input_tokens: 0, output_tokens: 6 },
    body,
    FORMATS.CLAUDE
  ) as Record<string, unknown>;
  assert.ok(Number(repaired.input_tokens) > 0, "input must be repaired");
  assert.equal(repaired.estimated_prompt_tokens, true);
  assert.equal(isPartiallyEstimatedUsage(repaired), true);
  const billable = selectBillingUsage(repaired) as Record<string, unknown>;
  assert.equal(billable.input_tokens, 0);
  assert.equal(billable.output_tokens, 6);
});

// M1 RED: same rule for the Gemini usage shape.
test("M1 RED: Gemini zero-input repair flags partial estimate", async () => {
  const { sanitizeProviderUsageForRequest } =
    await import("../../open-sse/utils/usageTracking.ts");
  const { FORMATS } = await import("../../open-sse/translator/formats.ts");
  const body = {
    model: "m",
    messages: [{ role: "user", content: "Write a 500-line research report" }],
  };
  const repaired = sanitizeProviderUsageForRequest(
    { promptTokenCount: 0, candidatesTokenCount: 6, totalTokenCount: 6 },
    body,
    FORMATS.GEMINI
  ) as Record<string, unknown>;
  assert.ok(Number(repaired.promptTokenCount) > 0, "input must be repaired");
  assert.equal(repaired.estimated_prompt_tokens, true);
  assert.equal(isPartiallyEstimatedUsage(repaired), true);
  const billable = selectBillingUsage(repaired) as Record<string, unknown>;
  assert.equal(billable.promptTokenCount, 0);
  assert.equal(billable.totalTokenCount, 6);
});

// M1-bis RED: non-streaming extraction keeps estimate flags (all branches).
test("M1-bis RED: extractUsageFromResponse keeps estimate flags", async () => {
  const { extractUsageFromResponse } = await import(
    "../../open-sse/handlers/usageExtractor.ts"
  );
  const openai = extractUsageFromResponse(
    { usage: { prompt_tokens: 7, completion_tokens: 3, estimated_prompt_tokens: true } },
    "openai"
  ) as Record<string, unknown>;
  assert.equal(openai.estimated_prompt_tokens, true);
  assert.equal(isPartiallyEstimatedUsage(openai), true);
  const claude = extractUsageFromResponse(
    { usage: { input_tokens: 9, output_tokens: 4, estimated_prompt_tokens: true } },
    "claude"
  ) as Record<string, unknown>;
  assert.equal(claude.estimated_prompt_tokens, true);
  const responses = extractUsageFromResponse(
    { response: { usage: { input_tokens: 5, output_tokens: 2, estimated: true } } },
    "openai"
  ) as Record<string, unknown>;
  assert.equal(responses.estimated, true);
  assert.equal(isEstimatedUsage(responses), true);
  const gemini = extractUsageFromResponse(
    { usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, estimated_prompt_tokens: true } },
    "gemini"
  ) as Record<string, unknown>;
  assert.equal(gemini.estimated_prompt_tokens, true);
  // Real usage stays flag-free.
  const real = extractUsageFromResponse(
    { usage: { prompt_tokens: 5, completion_tokens: 3 } },
    "openai"
  ) as Record<string, unknown>;
  assert.equal(real.estimated_prompt_tokens, undefined);
  assert.equal(isPartiallyEstimatedUsage(real), false);
});

// M1-bis RED: streaming message_start keeps the flag.
test("M1-bis RED: extractUsage message_start keeps estimate flags", async () => {
  const { extractUsage } = await import("../../open-sse/utils/usageTracking.ts");
  const out = extractUsage({
    type: "message_start",
    message: {
      usage: { input_tokens: 9, output_tokens: 1, estimated_prompt_tokens: true },
    },
  }) as Record<string, unknown>;
  assert.equal(out.estimated_prompt_tokens, true);
  assert.equal(isPartiallyEstimatedUsage(out), true);
});

// M1-bis RED: flag copier is a no-op on real usage, copies both markers.
test("M1-bis RED: copyEstimateFlags copies both markers, ignores real usage", async () => {
  const { copyEstimateFlags } = await import("../../open-sse/utils/usageTracking.ts");
  assert.deepEqual(copyEstimateFlags({ prompt_tokens: 1 }, {}), {});
  assert.deepEqual(
    copyEstimateFlags({ estimated: true, estimated_prompt_tokens: true }, {}),
    { estimated: true, estimated_prompt_tokens: true }
  );
});
