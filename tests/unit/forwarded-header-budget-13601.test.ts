import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildStreamingResponseHeaders, resetDroppedHeaderWarnFingerprints } =
  await import("../../open-sse/handlers/chatCore/responseHeaders.ts");

const meta = {} as Parameters<typeof buildStreamingResponseHeaders>[1];
const quietLogger = { warn: () => {}, debug: () => {} } as unknown as Parameters<
  typeof buildStreamingResponseHeaders
>[2];

function overBudgetHeaders(): Headers {
  // NOTE: WHATWG Headers iterates in lexicographic name order, so the filler
  // names are chosen to sort BEFORE the billing header — the billing header
  // lands last by position and loses the greedy fill at default priority.
  const init: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    init[`x-a-filler-${String(i).padStart(2, "0")}`] = "v".repeat(40);
  }
  init["x-billing-credits-remaining"] = "42";
  return new Headers(init);
}

describe("billing-class header promotion (#13601 D2)", () => {
  it("forwards the billing diagnostic and drops filler under a full budget", () => {
    resetDroppedHeaderWarnFingerprints();
    const out = buildStreamingResponseHeaders(overBudgetHeaders(), meta, quietLogger);
    assert.equal(
      out["x-billing-credits-remaining"],
      "42",
      "billing diagnostic must beat filler under a full budget"
    );
    assert.ok(
      !("x-a-filler-19" in out),
      "with the billing header promoted, the last filler must drop instead"
    );
  });

  it("pre-existing priority-0/1/2 headers still beat the new billing rule", () => {
    resetDroppedHeaderWarnFingerprints();
    const init: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      init[`x-a-filler-${String(i).padStart(2, "0")}`] = "v".repeat(40);
    }
    init["x-request-id"] = "req-1";
    init["retry-after"] = "30";
    init["x-ratelimit-remaining"] = "99";
    init["x-billing-credits-remaining"] = "42";
    const out = buildStreamingResponseHeaders(new Headers(init), meta, quietLogger);
    assert.equal(out["x-request-id"], "req-1", "priority-0 must survive");
    assert.equal(out["retry-after"], "30", "priority-1 must survive");
    assert.equal(out["x-ratelimit-remaining"], "99", "pre-existing priority-2 must survive");
    assert.equal(out["x-billing-credits-remaining"], "42", "new billing priority-2 must survive");
    assert.ok(!("x-a-filler-19" in out), "filler must drop instead of any priority header");
  });
});
