import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRecoverableStream,
  type StreamRecoveryTrace,
} from "../../open-sse/services/streamRecovery.ts";
import { formatRecoveryTrace } from "../../open-sse/handlers/chatCore/recoveryTraceLogging.ts";

const enc = new TextEncoder();

function steppingClock() {
  let t = 0;
  return () => {
    t += 1000;
    return t;
  };
}

function streamFrom(chunks: string[]) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
        return;
      }
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  return out;
}

const ROLE = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
const content = (s: string) => `data: {"choices":[{"delta":{"content":${JSON.stringify(s)}}}]}\n\n`;

const attempt = (over: Partial<StreamRecoveryTrace>): StreamRecoveryTrace => ({
  kind: "continue-attempt",
  attempt: 1,
  latch: false,
  orderFixOn: false,
  ...over,
});

test("continue-attempt formats attempt, kind and latch without orderFix", () => {
  const line = formatRecoveryTrace(attempt({ kind: "continue-attempt", attempt: 2, latch: true }));
  assert.equal(line, "recovery trace attempt=2 kind=continue-attempt latch=true");
});

test("continue-outcome suffix formats outcome and suffixChars", () => {
  const line = formatRecoveryTrace(
    attempt({ kind: "continue-outcome", attempt: 3, outcome: "suffix", suffixChars: 42 })
  );
  assert.equal(
    line,
    "recovery trace attempt=3 kind=continue-outcome outcome=suffix suffixChars=42"
  );
});

test("continue-outcome formats every emitted outcome", () => {
  const cases: Array<[StreamRecoveryTrace, string]> = [
    [attempt({ kind: "continue-outcome", outcome: "terminal" }), "outcome=terminal"],
    [
      attempt({ kind: "continue-outcome", outcome: "overlap-reject", overlapChars: 5 }),
      "outcome=overlap-reject overlapChars=5",
    ],
    [
      attempt({ kind: "continue-outcome", outcome: "refused", refusedReason: "latch" }),
      "outcome=refused refusedReason=latch",
    ],
    [
      attempt({ kind: "continue-outcome", outcome: "refused", refusedReason: "budget" }),
      "outcome=refused refusedReason=budget",
    ],
    [
      attempt({ kind: "continue-outcome", outcome: "refused", refusedReason: "format" }),
      "outcome=refused refusedReason=format",
    ],
    [attempt({ kind: "continue-outcome", outcome: "no-stream" }), "outcome=no-stream"],
  ];
  for (const [trace, tail] of cases) {
    const line = formatRecoveryTrace(trace);
    assert.ok(
      line.startsWith("recovery trace attempt=1 kind=continue-outcome "),
      `prefix for ${tail}`
    );
    assert.ok(line.endsWith(tail), `tail for ${tail}: ${line}`);
  }
});

test("latch transition keeps orderFix while attempt/outcome lines never carry it", () => {
  const latched = formatRecoveryTrace(
    attempt({ kind: "latch", latchBefore: false, latchAfter: true, orderFixOn: true })
  );
  assert.equal(
    latched,
    "recovery trace attempt=1 kind=latch latchBefore=false latchAfter=true orderFix=true"
  );
  const released = formatRecoveryTrace(
    attempt({ kind: "latch", latchBefore: true, latchAfter: false, orderFixOn: false })
  );
  assert.ok(released.endsWith("orderFix=false"), released);
  for (const trace of [
    attempt({ kind: "continue-attempt", orderFixOn: true }),
    attempt({ kind: "continue-outcome", outcome: "suffix", suffixChars: 1, orderFixOn: true }),
    attempt({ kind: "continue-outcome", outcome: "refused", refusedReason: "budget" }),
  ]) {
    assert.ok(!formatRecoveryTrace(trace).includes("orderFix"), trace.kind);
  }
});

test("formatter never renders undefined or null", () => {
  const traces: StreamRecoveryTrace[] = [
    attempt({ kind: "continue-attempt" }),
    attempt({ kind: "continue-outcome", outcome: "refused" }),
    attempt({ kind: "continue-outcome" }),
    attempt({ kind: "latch" }),
  ];
  for (const trace of traces) {
    const line = formatRecoveryTrace(trace);
    assert.ok(!line.includes("undefined"), line);
    assert.ok(!line.includes("null"), line);
  }
});

test("nominal stream stays silent: zero warn lines through the wired hook", async () => {
  const lines: string[] = [];
  const log = { warn: (tag: string, msg: string) => lines.push(`${tag} ${msg}`) };
  const stream = createRecoverableStream(
    streamFrom([ROLE, content("hi"), "data: [DONE]\n\n"]),
    async () => null,
    {
      finalize: () => {},
      now: steppingClock(),
      continueStream: async () => null,
      onRecoveryTrace: (trace) => log.warn("STREAM_RECOVERY", formatRecoveryTrace(trace)),
    }
  );
  await drain(stream);
  assert.deepEqual(lines, []);
});

test("refused attempt joins onContinue attempt with trace attempt and refused reason", async () => {
  const toolDelta =
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]}}]}\n\n';
  const scenarios = [
    {
      reason: "latch",
      chunks: [ROLE, toolDelta],
      opts: {},
    },
    {
      reason: "budget",
      chunks: [ROLE, content("hello ")],
      opts: { maxContinuations: 0 },
    },
    {
      reason: "format",
      chunks: ['event: content_block_delta\ndata: {"text":"hi"}\n\n'],
      opts: {},
    },
  ] as const;
  for (const { reason, chunks, opts } of scenarios) {
    const lines: string[] = [];
    const log = { warn: (tag: string, msg: string) => lines.push(`${tag} ${msg}`) };
    const stream = createRecoverableStream(streamFrom([...chunks]), async () => null, {
      finalize: () => {},
      now: steppingClock(),
      continueStream: async () => null,
      ...opts,
      onContinue: (n: number) =>
        log.warn("STREAM_RECOVERY", `mid-stream continuation attempt=${n}/4`),
      onRecoveryTrace: (trace) => log.warn("STREAM_RECOVERY", formatRecoveryTrace(trace)),
    });
    await drain(stream);
    const outcome = lines.find((l) => l.includes("kind=continue-outcome"));
    assert.ok(outcome, `refused outcome logged for ${reason}: ${lines.join(" | ")}`);
    assert.ok(outcome.includes(`outcome=refused refusedReason=${reason}`), outcome);
    assert.ok(!lines.some((l) => l.includes("refusedReason=terminal")), lines.join(" | "));
  }
});

test("flag-off bit-identical: order-fix flag changes no response byte", async () => {
  const bodies: string[] = [];
  for (const flag of [false, true]) {
    const stream = createRecoverableStream(
      streamFrom([ROLE, content("hello ")]),
      async () => null,
      {
        finalize: () => {},
        now: steppingClock(),
        maxContinuations: 0,
        continueStream: async () => null,
        resolveOrderFixFlag: () => flag,
        onRecoveryTrace: () => {},
      }
    );
    bodies.push(await drain(stream));
  }
  assert.equal(bodies[0], bodies[1]);
});

test("onContinue line shares the attempt= token with trace lines (R9-iv join)", async () => {
  const lines: string[] = [];
  const log = { warn: (tag: string, msg: string) => lines.push(`${tag} ${msg}`) };
  const stream = createRecoverableStream(
    streamFrom([ROLE, content("Hello there world")]),
    async () => null,
    {
      finalize: () => {},
      now: steppingClock(),
      continueStream: async () =>
        streamFrom([ROLE, content("there world, nice to meet you!"), "data: [DONE]\n\n"]),
      // Same shape as the chatCore.ts onContinue site: attempt= token joinable
      // with the recovery trace lines in a single prod grep.
      onContinue: (n: number) =>
        log.warn("STREAM_RECOVERY", `mid-stream continuation attempt=${n}/4`),
      onRecoveryTrace: (trace) => log.warn("STREAM_RECOVERY", formatRecoveryTrace(trace)),
    }
  );
  const out = await drain(stream);
  assert.ok(out.includes("nice to meet you!"), "suffix stitched for the client");
  const attemptOf = (l: string) => /attempt=(\d+)/.exec(l)?.[1];
  const continued = lines.find((l) => l.includes("mid-stream continuation attempt="));
  assert.ok(continued, lines.join(" | "));
  const attemptLine = lines.find((l) => l.includes("kind=continue-attempt"));
  const outcome = lines.find((l) => l.includes("kind=continue-outcome"));
  assert.ok(attemptLine && outcome, lines.join(" | "));
  assert.equal(attemptOf(continued), attemptOf(attemptLine));
  assert.equal(attemptOf(continued), attemptOf(outcome));
});
