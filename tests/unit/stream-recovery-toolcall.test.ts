import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRecoverableStream,
  TruncatedStreamError,
  scanOpenAiSseText,
  type StreamRecoveryTrace,
} from "../../open-sse/services/streamRecovery.ts";

const enc = new TextEncoder();

// Deliver the SSE chunk on the first read, then error on the second read so the
// holdback window has committed (post-commit truncation) before the cut.
function makeStream(sse: string): ReadableStream<Uint8Array> {
  let n = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      n += 1;
      if (n === 1) {
        c.enqueue(enc.encode(sse));
        return;
      }
      c.error(new TruncatedStreamError());
    },
  });
}

// A clock that jumps past HOLDBACK_MS on the second read so the very first pushed
// chunk commits the holdback window immediately (post-commit truncation path).
function jumpingClock(): () => number {
  let t = 0;
  return () => (t += 1000);
}

describe("scanOpenAiSseText: terminal vs in-flight tool call", () => {
  it("tool_calls without finish_reason → inFlight true, terminal false", () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup"}}]}}]}\n\n';
    const r = scanOpenAiSseText(sse);
    assert.equal(r.sawToolCall, true);
    assert.equal(r.sawToolCallInFlight, true);
    assert.equal(r.terminal, false);
  });

  it("complete tool_calls + finish_reason + [DONE] → terminal true, inFlight false", () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n' +
      "data: [DONE]\n\n";
    const r = scanOpenAiSseText(sse);
    assert.equal(r.sawToolCall, true);
    assert.equal(r.terminal, true);
    assert.equal(r.sawToolCallInFlight, false);
  });

  it("plain text → no tool call", () => {
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n';
    const r = scanOpenAiSseText(sse);
    assert.equal(r.sawToolCall, false);
    assert.equal(r.sawToolCallInFlight, false);
    assert.equal(r.terminal, false);
  });

  it("complete tool_calls WITHOUT [DONE] → terminal false, inFlight false (the actual fix)", () => {
    // This is the case the original plan promised to unblock: the tool call itself is
    // done (finish_reason: "tool_calls"), but the overall stream/turn has not sent its
    // own terminal marker yet — a truncation right here is recoverable.
    const sse =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const r = scanOpenAiSseText(sse);
    assert.equal(r.sawToolCall, true);
    assert.equal(r.sawToolCallInFlight, false);
    assert.equal(r.terminal, false);
  });
});

describe("stream recovery does not duplicate an in-flight tool call", () => {
  it("truncation with an in-flight tool call → no continuation", async () => {
    let continued = false;
    const sse =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]}}]}\n\n';
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => {
        continued = true;
        return null;
      },
    });
    const reader = wrapped.getReader();
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
      }
    } catch {
      // the in-flight tool call makes the stream close without continuing
    }
    assert.equal(continued, false);
  });

  it("truncation right after a completed tool call → continuation attempted (the real 91% gain)", async () => {
    // Text was emitted, THEN the tool call completed (finish_reason: "tool_calls"), THEN
    // the connection drops before a [DONE]/other terminal marker. Before this fix, the
    // blunt `emittedToolCall` guard blocked recovery here even though the call itself is
    // done and only trailing prose was lost — this is the exact case the plan promised
    // to unblock and the pre-fix table proved was a no-op.
    let continued = false;
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"Let me check that. "}}]}\n' +
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f","arguments":"{}"}}]}}]}\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => {
        continued = true;
        return null;
      },
    });
    const reader = wrapped.getReader();
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
      }
    } catch {
      // no-op
    }
    assert.equal(continued, true);
  });

  it("truncation of plain text → continuation attempted", async () => {
    let continued = false;
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hello "}}]}\n\n';
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => {
        continued = true;
        return null;
      },
    });
    const reader = wrapped.getReader();
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
      }
    } catch {
      // no-op
    }
    assert.equal(continued, true);
  });

  it("naive removal of the tool-call guard would duplicate a partial tool call", () => {
    // The blunt `sawToolCall` flag is true for BOTH a complete tool call and a
    // partial (in-flight) one. The new `sawToolCallInFlight` flag is the only
    // signal that tells them apart: a naive guard keyed on `sawToolCall` would
    // block the complete call AND let the partial one through to the
    // continuation, where trimContinuationOverlap (text-only) cannot de-duplicate
    // the replayed tool_calls arguments.
    const ssePartial =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\""}}]}}]}\n\n';
    const sseFull =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const scanPartial = scanOpenAiSseText(ssePartial);
    const scanFull = scanOpenAiSseText(sseFull);
    // The blunt flag cannot distinguish them.
    assert.equal(scanPartial.sawToolCall, true);
    assert.equal(scanFull.sawToolCall, true);
    // The in-flight flag can — and that is what keeps canContinue false only for
    // the partial tool call, so the continuation never replays it.
    assert.equal(scanPartial.sawToolCallInFlight, true);
    assert.equal(scanFull.sawToolCallInFlight, false);
  });
});

describe("order-aware in-flight tool-call detection behind off-by-default flag", () => {
  const ORDER_FIX_FLAG = "STREAM_RECOVERY_TOOLCALL_ORDER_FIX";
  const ORIGINAL_ORDER_FIX_FLAG = process.env[ORDER_FIX_FLAG];

  function enableOrderFix() {
    process.env[ORDER_FIX_FLAG] = "true";
  }

  function restoreOrderFixFlag() {
    if (ORIGINAL_ORDER_FIX_FLAG === undefined) delete process.env[ORDER_FIX_FLAG];
    else process.env[ORDER_FIX_FLAG] = ORIGINAL_ORDER_FIX_FLAG;
  }

  // Scan-level order neighbors (flag on): the batch shape decides, not the booleans.
  it("scan of a finished call followed by a new in-flight call stays in flight", () => {
    enableOrderFix();
    try {
      const sse =
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_2","function":{"name":"lookup"}}]}}]}\n\n';
      const r = scanOpenAiSseText(sse, true);
      assert.strictEqual(r.sawToolCallInFlight, true);
    } finally {
      restoreOrderFixFlag();
    }
  });

  it("scan of an in-flight call settled by a later finish leaves nothing in flight", () => {
    enableOrderFix();
    try {
      const sse =
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup"}}]}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
      const r = scanOpenAiSseText(sse, true);
      assert.strictEqual(r.sawToolCallInFlight, false);
    } finally {
      restoreOrderFixFlag();
    }
  });

  it("scan keeps the release result with the order fix off", () => {
    restoreOrderFixFlag();
    try {
      const sse =
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_2","function":{"name":"lookup"}}]}}]}\n\n';
      const r = scanOpenAiSseText(sse);
      assert.strictEqual(r.sawToolCallInFlight, false);
    } finally {
      restoreOrderFixFlag();
    }
  });

  it("truncation after a coalesced complete call plus a new partial call never resumes the partial arguments", async () => {
    enableOrderFix();
    try {
      let continued = false;
      const sse =
        'data: {"choices":[{"index":0,"delta":{"content":"Let me check that. "}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f","arguments":"{}"}}]}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c2","function":{"name":"f"}}]}}]}\n\n';
      const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
        finalize: () => {},
        now: jumpingClock(),
        continueStream: async () => {
          continued = true;
          return null;
        },
      });
      const reader = wrapped.getReader();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
        }
      } catch {
        // no-op
      }
      assert.strictEqual(continued, false);
    } finally {
      restoreOrderFixFlag();
    }
  });

  it("truncation of trailing text after a settled tool call resumes from the same upstream", async () => {
    // Each chunk below ends with \n\n, so emit() scans them as separate batches:
    // first batch [vol] latches on, second batch [finish] re-arms, then the cut
    // drops only trailing prose and the continuation resumes it from the same
    // upstream connection.
    enableOrderFix();
    try {
      function makeTwoChunkStream(first: string, second: string): ReadableStream<Uint8Array> {
        let n = 0;
        return new ReadableStream<Uint8Array>({
          pull(c) {
            n += 1;
            if (n === 1) {
              c.enqueue(enc.encode(first));
              return;
            }
            if (n === 2) {
              c.enqueue(enc.encode(second));
              return;
            }
            c.error(new TruncatedStreamError());
          },
        });
      }
      let continued = false;
      const first =
        'data: {"choices":[{"index":0,"delta":{"content":"Let me check that. "}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]}}]}\n\n';
      const second = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
      const wrapped = createRecoverableStream(makeTwoChunkStream(first, second), async () => null, {
        finalize: () => {},
        now: jumpingClock(),
        continueStream: async () => {
          continued = true;
          return null;
        },
      });
      const reader = wrapped.getReader();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
        }
      } catch {
        // no-op
      }
      assert.strictEqual(continued, true);
    } finally {
      restoreOrderFixFlag();
    }
  });

  it("scan of a multi-choice payload without indexes stays explicit on both sides", () => {
    // A tool_calls delta without an index on a multi-choice payload opens no
    // pending slot, and an index-less finish settles nothing (fail-closed): the
    // pending call from the indexed choice survives, so the batch stays in flight.
    enableOrderFix();
    try {
      const sse =
        'data: {"choices":[{"index":1,"delta":{"tool_calls":[{"id":"call_9","function":{"name":"lookup"}}]}},{"delta":{"tool_calls":[{"id":"call_x","function":{"name":"lookup"}}]}}]}\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"},{"index":0,"delta":{}}]}\n\n';
      const r = scanOpenAiSseText(sse, true);
      assert.strictEqual(r.sawToolCall, true);
      assert.strictEqual(r.sawToolCallInFlight, true);
    } finally {
      restoreOrderFixFlag();
    }
  });

  it("stays on the release behavior with the flag off for both truncations", async () => {
    // Bit-for-bit release check: the same two shapes played with the
    // flag off keep the release outcome — the coalesced batch resumes (order-blind
    // scan sees no in-flight call, latch never set) while the split batches stay
    // refused (first batch latches on, sticky latch never re-armed) — instead of
    // merely covering the off path.
    restoreOrderFixFlag();
    try {
      async function runToContinued(stream: ReadableStream<Uint8Array>): Promise<boolean> {
        let continued = false;
        const wrapped = createRecoverableStream(stream, async () => null, {
          finalize: () => {},
          now: jumpingClock(),
          continueStream: async () => {
            continued = true;
            return null;
          },
        });
        const reader = wrapped.getReader();
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
          }
        } catch {
          // no-op
        }
        return continued;
      }
      const coalesced =
        'data: {"choices":[{"index":0,"delta":{"content":"Let me check that. "}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f","arguments":"{}"}}]}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c2","function":{"name":"f"}}]}}]}\n\n';
      function makeTwoChunkStream(first: string, second: string): ReadableStream<Uint8Array> {
        let n = 0;
        return new ReadableStream<Uint8Array>({
          pull(c) {
            n += 1;
            if (n === 1) {
              c.enqueue(enc.encode(first));
              return;
            }
            if (n === 2) {
              c.enqueue(enc.encode(second));
              return;
            }
            c.error(new TruncatedStreamError());
          },
        });
      }
      const first =
        'data: {"choices":[{"index":0,"delta":{"content":"Let me check that. "}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]}}]}\n\n';
      const second = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
      assert.strictEqual(await runToContinued(makeStream(coalesced)), true);
      assert.strictEqual(await runToContinued(makeTwoChunkStream(first, second)), false);
    } finally {
      restoreOrderFixFlag();
    }
  });
});

describe("recovery trace seam", () => {
  it("resolveOrderFixFlag forces order-aware re-arm where flag-off stays latched", async () => {
    const ORDER_FIX_FLAG = "STREAM_RECOVERY_TOOLCALL_ORDER_FIX";
    const saved = process.env[ORDER_FIX_FLAG];
    delete process.env[ORDER_FIX_FLAG];
    async function runToContinued(
      stream: ReadableStream<Uint8Array>,
      resolveOrderFixFlag?: () => boolean
    ): Promise<boolean> {
      let continued = false;
      const wrapped = createRecoverableStream(stream, async () => null, {
        finalize: () => {},
        now: jumpingClock(),
        continueStream: async () => {
          continued = true;
          return null;
        },
        ...(resolveOrderFixFlag ? { resolveOrderFixFlag } : {}),
      });
      const reader = wrapped.getReader();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
        }
      } catch {
        // no-op
      }
      return continued;
    }
    function makeTwoChunkStream(first: string, second: string): ReadableStream<Uint8Array> {
      let n = 0;
      return new ReadableStream<Uint8Array>({
        pull(c) {
          n += 1;
          if (n === 1) {
            c.enqueue(enc.encode(first));
            return;
          }
          if (n === 2) {
            c.enqueue(enc.encode(second));
            return;
          }
          c.error(new TruncatedStreamError());
        },
      });
    }
    const first =
      'data: {"choices":[{"index":0,"delta":{"content":"Let me check that. "}}]}\n' +
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]}}]}\n\n';
    const second = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    try {
      assert.strictEqual(await runToContinued(makeTwoChunkStream(first, second)), false);
      assert.strictEqual(await runToContinued(makeTwoChunkStream(first, second), () => true), true);
    } finally {
      if (saved === undefined) delete process.env[ORDER_FIX_FLAG];
      else process.env[ORDER_FIX_FLAG] = saved;
    }
  });

  it("a throwing flag seam logs fail-closed exactly once across many batches", async () => {
    const ORDER_FIX_FLAG = "STREAM_RECOVERY_TOOLCALL_ORDER_FIX";
    const saved = process.env[ORDER_FIX_FLAG];
    delete process.env[ORDER_FIX_FLAG];
    const originalError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = ((...args: unknown[]) => {
      errorCalls.push(args);
    }) as typeof console.error;
    try {
      let logged = 0;
      const batches: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        batches.push(`data: {"choices":[{"index":0,"delta":{"content":"chunk${i} "}}]}\n\n`);
      }
      let n = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          n += 1;
          if (n <= batches.length) {
            c.enqueue(enc.encode(batches[n - 1]));
            return;
          }
          c.error(new TruncatedStreamError());
        },
      });
      const wrapped = createRecoverableStream(stream, async () => null, {
        finalize: () => {},
        now: jumpingClock(),
        continueStream: async () => null,
        resolveOrderFixFlag: () => {
          logged += 1;
          throw new Error("db down");
        },
      });
      const reader = wrapped.getReader();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
        }
      } catch {
        // no-op: continuation returns null on the truncated tail
      }
      assert.strictEqual(logged, 3);
      assert.strictEqual(errorCalls.length, 1);
      assert.match(String(errorCalls[0][0]), /fail-closed/);
    } finally {
      console.error = originalError;
      if (saved === undefined) delete process.env[ORDER_FIX_FLAG];
      else process.env[ORDER_FIX_FLAG] = saved;
    }
  });

  it("a null continuation provider traces no-stream with a matching attempt", async () => {
    const traces: StreamRecoveryTrace[] = [];
    const attempts: number[] = [];
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hello "}}]}\n\n';
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => null,
      onContinue: (attempt) => {
        attempts.push(attempt);
      },
      onRecoveryTrace: (trace) => {
        traces.push(trace);
      },
    });
    const reader = wrapped.getReader();
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
      }
    } catch {
      // no-op: the null continuation falls back to the close path
    }
    assert.deepStrictEqual(attempts, [1]);
    assert.strictEqual(traces.length, 2);
    assert.strictEqual(traces[0].kind, "continue-attempt");
    assert.strictEqual(traces[0].attempt, 1);
    assert.strictEqual(traces[1].kind, "continue-outcome");
    assert.strictEqual(traces[1].attempt, 1);
    assert.strictEqual(traces[1].outcome, "no-stream");
  });
});

describe("recovery trace outcomes", () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value) out += decoder.decode(r.value, { stream: true });
      }
    } catch {
      // truncations surface as closes on the recovered path
    }
    return out;
  }

  it("a resumed continuation traces suffix with the pasted char count", async () => {
    const traces: StreamRecoveryTrace[] = [];
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hello brave new "}}]}\n\n';
    const contSse =
      'data: {"choices":[{"index":0,"delta":{"content":"hello brave new world"}}]}\n' +
      "data: [DONE]\n\n";
    const contStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(contSse));
        c.close();
      },
    });
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => contStream,
      onRecoveryTrace: (trace) => {
        traces.push(trace);
      },
    });
    const out = await drain(wrapped);
    assert.match(out, /world/);
    const outcomes = traces.filter((t) => t.kind === "continue-outcome");
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0].outcome, "suffix");
    assert.strictEqual(outcomes[0].suffixChars, "world".length);
    assert.strictEqual(outcomes[0].attempt, 1);
  });

  it("a cleanly finished continuation traces terminal (order-blind scan)", async () => {
    // The continuation scan stays order-blind (no orderAware), so a terminal
    // outcome may reflect the release semantics even with the flag on.
    const traces: StreamRecoveryTrace[] = [];
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hello "}}]}\n\n';
    const contSse = "data: [DONE]\n\n";
    const contStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(contSse));
        c.close();
      },
    });
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => contStream,
      onRecoveryTrace: (trace) => {
        traces.push(trace);
      },
    });
    await drain(wrapped);
    const outcomes = traces.filter((t) => t.kind === "continue-outcome");
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0].outcome, "terminal");
    assert.strictEqual(outcomes[0].attempt, 1);
  });

  it("a refused retryable cut traces latch, a nominal done stays silent", async () => {
    const refused: StreamRecoveryTrace[] = [];
    const inFlight =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]}}]}\n\n';
    const wrappedRefused = createRecoverableStream(makeStream(inFlight), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => null,
      onRecoveryTrace: (trace) => {
        refused.push(trace);
      },
    });
    await drain(wrappedRefused);
    const refusedOutcomes = refused.filter((t) => t.kind === "continue-outcome");
    assert.strictEqual(refusedOutcomes.length, 1);
    assert.strictEqual(refusedOutcomes[0].outcome, "refused");
    assert.strictEqual(refusedOutcomes[0].refusedReason, "latch");

    const silent: StreamRecoveryTrace[] = [];
    let n = 0;
    const nominal = new ReadableStream<Uint8Array>({
      pull(c) {
        n += 1;
        if (n === 1) {
          c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
          return;
        }
        if (n === 2) {
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          return;
        }
        c.close();
      },
    });
    const wrappedNominal = createRecoverableStream(nominal, async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => null,
      onRecoveryTrace: (trace) => {
        silent.push(trace);
      },
    });
    await drain(wrappedNominal);
    assert.strictEqual(silent.filter((t) => t.kind === "continue-outcome").length, 0);
  });

  it("a low-overlap resume then a good one traces an ordered pair", async () => {
    const traces: StreamRecoveryTrace[] = [];
    const attempts: number[] = [];
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hello brave new "}}]}\n\n';
    const badSse = 'data: {"choices":[{"index":0,"delta":{"content":"zzz"}}]}\n\n';
    const goodSse =
      'data: {"choices":[{"index":0,"delta":{"content":"hello brave new world"}}]}\n' +
      "data: [DONE]\n\n";
    let calls = 0;
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => {
        calls += 1;
        const body = calls === 1 ? badSse : goodSse;
        return new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(body));
            c.close();
          },
        });
      },
      onContinue: (attempt) => {
        attempts.push(attempt);
      },
      onRecoveryTrace: (trace) => {
        traces.push(trace);
      },
    });
    const out = await drain(wrapped);
    assert.match(out, /world/);
    const outcomes = traces.filter((t) => t.kind === "continue-outcome");
    assert.strictEqual(outcomes.length, 2);
    assert.strictEqual(outcomes[0].attempt, 1);
    assert.strictEqual(outcomes[0].outcome, "overlap-reject");
    assert.strictEqual(typeof outcomes[0].overlapChars, "number");
    assert.strictEqual(outcomes[1].attempt, 2);
    assert.strictEqual(outcomes[1].outcome, "suffix");
    assert.deepStrictEqual(attempts, [1, 2]);
  });

  it("a tool call in flight traces a latch set", async () => {
    const traces: StreamRecoveryTrace[] = [];
    const sse =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]}}]}\n\n';
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => null,
      onRecoveryTrace: (trace) => {
        traces.push(trace);
      },
    });
    await drain(wrapped);
    const latches = traces.filter((t) => t.kind === "latch");
    assert.strictEqual(latches.length, 1);
    assert.strictEqual(latches[0].latchBefore, false);
    assert.strictEqual(latches[0].latchAfter, true);
    assert.strictEqual(latches[0].attempt, 0);
  });

  it("a settled batch with the seam on traces a latch re-arm", async () => {
    const traces: StreamRecoveryTrace[] = [];
    let n = 0;
    const first =
      'data: {"choices":[{"index":0,"delta":{"content":"Let me check that. "}}]}\n' +
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]}}]}\n\n';
    const second = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        n += 1;
        if (n === 1) {
          c.enqueue(enc.encode(first));
          return;
        }
        if (n === 2) {
          c.enqueue(enc.encode(second));
          return;
        }
        c.error(new TruncatedStreamError());
      },
    });
    const wrapped = createRecoverableStream(stream, async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => null,
      resolveOrderFixFlag: () => true,
      onRecoveryTrace: (trace) => {
        traces.push(trace);
      },
    });
    await drain(wrapped);
    const latches = traces.filter((t) => t.kind === "latch");
    assert.strictEqual(latches.length, 2);
    assert.deepStrictEqual(
      latches.map((l) => [l.latchBefore, l.latchAfter]),
      [
        [false, true],
        [true, false],
      ]
    );
  });

  it("a latched cut with no budget left still reports latch first", async () => {
    const traces: StreamRecoveryTrace[] = [];
    const sse =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]}}]}\n\n';
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      maxContinuations: 0,
      continueStream: async () => null,
      onRecoveryTrace: (trace) => {
        traces.push(trace);
      },
    });
    await drain(wrapped);
    const outcomes = traces.filter((t) => t.kind === "continue-outcome");
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0].outcome, "refused");
    assert.strictEqual(outcomes[0].refusedReason, "latch");
  });

  it("a starved budget alone reports budget, a foreign body alone reports format", async () => {
    const budgetTraces: StreamRecoveryTrace[] = [];
    const text = 'data: {"choices":[{"index":0,"delta":{"content":"hello "}}]}\n\n';
    const wrappedBudget = createRecoverableStream(makeStream(text), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      maxContinuations: 0,
      continueStream: async () => null,
      onRecoveryTrace: (trace) => {
        budgetTraces.push(trace);
      },
    });
    await drain(wrappedBudget);
    const budgetOutcomes = budgetTraces.filter((t) => t.kind === "continue-outcome");
    assert.strictEqual(budgetOutcomes.length, 1);
    assert.strictEqual(budgetOutcomes[0].refusedReason, "budget");

    const formatTraces: StreamRecoveryTrace[] = [];
    const foreign = 'event: content_block_delta\ndata: {"text":"hi"}\n\n';
    const wrappedFormat = createRecoverableStream(makeStream(foreign), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => null,
      onRecoveryTrace: (trace) => {
        formatTraces.push(trace);
      },
    });
    await drain(wrappedFormat);
    const formatOutcomes = formatTraces.filter((t) => t.kind === "continue-outcome");
    assert.strictEqual(formatOutcomes.length, 1);
    assert.strictEqual(formatOutcomes[0].refusedReason, "format");
  });

  it("wiring the trace hook leaves onContinue counts untouched", async () => {
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hello brave new "}}]}\n\n';
    const goodSse =
      'data: {"choices":[{"index":0,"delta":{"content":"hello brave new world"}}]}\n' +
      "data: [DONE]\n\n";
    async function run(withTrace: boolean): Promise<{ attempts: number[]; out: string }> {
      const attempts: number[] = [];
      const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
        finalize: () => {},
        now: jumpingClock(),
        continueStream: async () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(goodSse));
              c.close();
            },
          }),
        onContinue: (attempt) => {
          attempts.push(attempt);
        },
        ...(withTrace
          ? {
              onRecoveryTrace: () => {},
            }
          : {}),
      });
      return { attempts, out: await drain(wrapped) };
    }
    const plain = await run(false);
    const traced = await run(true);
    assert.deepStrictEqual(traced.attempts, plain.attempts);
    assert.strictEqual(traced.out, plain.out);
    assert.deepStrictEqual(traced.attempts, [1]);
  });

  it("every trace attempt joins to an onContinue attempt on two resumes", async () => {
    async function runCase(
      emitted: string,
      continuation: string
    ): Promise<{ attempts: number[]; traces: StreamRecoveryTrace[] }> {
      const attempts: number[] = [];
      const traces: StreamRecoveryTrace[] = [];
      const wrapped = createRecoverableStream(makeStream(emitted), async () => null, {
        finalize: () => {},
        now: jumpingClock(),
        continueStream: async () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(continuation));
              c.close();
            },
          }),
        onContinue: (attempt) => {
          attempts.push(attempt);
        },
        onRecoveryTrace: (trace) => {
          traces.push(trace);
        },
      });
      await drain(wrapped);
      return { attempts, traces };
    }
    const r1 = await runCase(
      'data: {"choices":[{"index":0,"delta":{"content":"hello brave new "}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"hello brave new world"}}]}\n' +
        "data: [DONE]\n\n"
    );
    const r2 = await runCase(
      'data: {"choices":[{"index":0,"delta":{"content":"report so far "}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"f","arguments":"{}"}}]}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"content":"report so far and more"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"report so far and more detail"}}]}\n' +
        "data: [DONE]\n\n"
    );
    for (const { attempts, traces } of [r1, r2]) {
      const joined = traces.filter(
        (t) => t.kind === "continue-attempt" || t.kind === "continue-outcome"
      );
      assert.ok(joined.length > 0);
      for (const t of joined) {
        assert.ok(attempts.includes(t.attempt), `attempt ${t.attempt} has no onContinue`);
      }
      for (const a of attempts) {
        assert.ok(
          joined.some((t) => t.attempt === a),
          `onContinue ${a} has no trace`
        );
      }
    }
  });
});

describe("empty-retry bound (F5)", () => {
  const F5_ROLE = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
  const reasoning = (s: string) =>
    `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(s)}}}]}\n\n`;
  const FINISH_STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
  const FINISH_STOP_CONTENT = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n';
  const DONE = "data: [DONE]\n\n";

  function reasoningOnlyInitial(): ReadableStream<Uint8Array> {
    return makeStream(
      F5_ROLE + reasoning("the model thinks through the problem here...") + FINISH_STOP
    );
  }

  function emptyNonTerminalStream(onBytes: (n: number) => void) {
    // Empty, non-terminal: role only, no text, no stop/DONE/toolcall marker.
    const body = F5_ROLE;
    onBytes(enc.encode(body).length);
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(body));
        c.close();
      },
    });
  }

  async function drainEmptyBound(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value) out += decoder.decode(r.value, { stream: true });
      }
    } catch {
      // truncations surface as closes on the recovered path
    }
    return out;
  }

  // Drain via the async-iterator protocol: forces the wrapped stream through a
  // different read path than the manual getReader() loop, catching cases where
  // a fix only works on one consumption pattern.

  it("reasoning-only stop with empty continuations burns the whole budget pre-fix (bound guard)", async () => {
    // Reasoning-only stop (finish_reason "stop", text empty, reasoning
    // non-empty) with a post-commit cutoff and no [DONE]: every continuation
    // comes back empty and non-terminal. Would fail pre-fix (calls === 4,
    // replayed read-only 2026-09-14 on 152d95108: PREFIX-CALLS=4); post-fix the
    // bound stops the chain after one spent request.
    let calls = 0;
    let bytes = 0;
    const wrapped = createRecoverableStream(
      reasoningOnlyInitial(),
      async () => null,
      {
        finalize: () => {},
        now: jumpingClock(),
        continueStream: async () => {
          calls += 1;
          return emptyNonTerminalStream((n) => {
            bytes += n;
          });
        },
      }
    );
    const out = await drainEmptyBound(wrapped);
    assert.equal(calls, 1, "empty bound stops the chain after one spent request");
    assert.ok(bytes > 0, "wasted upstream bytes are counted");
    assert.match(out, /\[DONE\]/, "client still closes cleanly after the bound trips");
  });

  it("stops after a single empty continuation and traces empty-retry at attempt 1", async () => {
    // Same reasoning-only setup as the bound guard above, with the trace and
    // onContinue hooks wired: the first continuation comes back empty and
    // non-terminal, and the lock closes right after that single spent request.
    let calls = 0;
    let bytes = 0;
    const traces: StreamRecoveryTrace[] = [];
    const attempts: number[] = [];
    const wrapped = createRecoverableStream(
      reasoningOnlyInitial(),
      async () => null,
      {
        finalize: () => {},
        now: jumpingClock(),
        continueStream: async () => {
          calls += 1;
          return emptyNonTerminalStream((n) => {
            bytes += n;
          });
        },
        onContinue: (attempt) => {
          attempts.push(attempt);
        },
        onRecoveryTrace: (trace) => {
          traces.push(trace);
        },
      }
    );
    const out = await drainEmptyBound(wrapped);
    assert.equal(calls, 1, "the second empty retry closes without a new upstream request");
    assert.match(out, /\[DONE\]/, "client closes cleanly");
    assert.deepStrictEqual(attempts, [1]);
    const attemptLine = traces.find((t) => t.kind === "continue-attempt");
    const outcome = traces.find(
      (t) => t.kind === "continue-outcome" && t.refusedReason === "empty-retry"
    );
    assert.ok(attemptLine, "the spent attempt is traced");
    assert.ok(outcome, "the stopped loop is traced as empty-retry");
    assert.equal(attemptLine.attempt, 1);
    assert.equal(outcome.attempt, 1, "the lock spends no request so it joins attempt 1");
    assert.ok(bytes > 0 && bytes < 4 * enc.encode(F5_ROLE).length, "about one quarter of RED bytes");
  });

  it("an empty terminal continuation still closes after exactly one request", async () => {
    let calls = 0;
    const wrapped = createRecoverableStream(reasoningOnlyInitial(), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => {
        calls += 1;
        return new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(F5_ROLE + FINISH_STOP_CONTENT + DONE));
            c.close();
          },
        });
      },
    });
    const out = await drainEmptyBound(wrapped);
    assert.equal(calls, 1);
    assert.match(out, /\[DONE\]/);
  });

  it("single-choice reasoning-only parity: flag on/off are byte-identical", async () => {
    async function runParity(flag: boolean): Promise<{ calls: number; out: string }> {
      const wrapped = createRecoverableStream(
        reasoningOnlyInitial(),
        async () => null,
        {
          finalize: () => {},
          now: jumpingClock(),
          continueStream: async () => {
            (globalThis as unknown as { __parityCalls?: number }).__parityCalls =
              (((globalThis as unknown as { __parityCalls?: number }).__parityCalls ?? 0) + 1);
            return emptyNonTerminalStream(() => {});
          },
          resolveOrderFixFlag: () => flag,
        }
      );
      const out = await drainEmptyBound(wrapped);
      const calls =
        (globalThis as unknown as { __parityCalls?: number }).__parityCalls ?? 0;
      delete (globalThis as unknown as { __parityCalls?: number }).__parityCalls;
      return { calls, out };
    }
    const off = await runParity(false);
    const on = await runParity(true);
    assert.equal(off.calls, 1);
    assert.equal(on.calls, 1);
    assert.equal(on.out, off.out, "flag-off parity holds on the single-choice empty path");
  });

  it("negative exhaustiveness: the four legacy refused reasons stay distinct", () => {
    const reasons: Array<StreamRecoveryTrace["refusedReason"]> = [
      "latch",
      "budget",
      "format",
      "terminal",
    ];
    assert.equal(new Set(reasons).size, 4);
    for (const reason of reasons) {
      assert.notEqual(reason, "empty-retry");
    }
  });

  it("nominal budget intact: a real-text truncation still resumes (non-empty chain)", async () => {
    // Same truncation shape as the guards above, but the continuation carries
    // real text: the empty bound must not trip and the suffix is stitched.
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hello brave new "}}]}\n\n';
    const goodSse =
      'data: {"choices":[{"index":0,"delta":{"content":"hello brave new world"}}]}\n' +
      "data: [DONE]\n\n";
    let calls = 0;
    const wrapped = createRecoverableStream(makeStream(sse), async () => null, {
      finalize: () => {},
      now: jumpingClock(),
      continueStream: async () => {
        calls += 1;
        return new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(goodSse));
            c.close();
          },
        });
      },
    });
    const out = await drainEmptyBound(wrapped);
    assert.match(out, /world/);
    assert.equal(calls, 1);
  });
});
