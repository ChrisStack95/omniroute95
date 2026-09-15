import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { isTransientEmbeddingErrorReason, embedWithTransientRetry } =
  await import("../../src/lib/memory/store.ts");

describe("transient embed-failure reason gate (#13601 D3)", () => {
  it("treats retryable transport reasons as transient", () => {
    assert.equal(isTransientEmbeddingErrorReason("rate_limited"), true);
    assert.equal(isTransientEmbeddingErrorReason("timeout"), true);
    assert.equal(isTransientEmbeddingErrorReason("request_failed"), true);
  });

  it("treats deterministic/unknown reasons as non-transient", () => {
    assert.equal(isTransientEmbeddingErrorReason("no_key"), false);
    assert.equal(isTransientEmbeddingErrorReason("model_load_failed"), false);
    assert.equal(isTransientEmbeddingErrorReason("unknown"), false);
  });
});

describe("embedWithTransientRetry (#13601 D3)", () => {
  const settings = {} as never;
  const okVector = () => ({
    vector: new Float32Array([1, 2, 3]),
    source: "static",
    model: "potion-base-8M",
    dimensions: 3,
    latencyMs: 1,
    cached: false,
  });
  const errOf = (reason: string) => ({
    source: "static" as const,
    model: null,
    reason,
    message: reason,
  });

  it("transient-then-success retries once and returns the vector", async () => {
    let calls = 0;
    const embedFn = async () => (++calls === 1 ? errOf("timeout") : okVector());
    const result = await embedWithTransientRetry(embedFn as never, "hi", settings, 0);
    assert.equal(calls, 2);
    assert.ok("vector" in (result as object));
  });

  it("persistent transient failure returns the error after exactly 2 attempts", async () => {
    let calls = 0;
    const embedFn = async () => {
      calls++;
      return errOf("rate_limited");
    };
    const result = await embedWithTransientRetry(embedFn as never, "hi", settings, 1);
    assert.equal(calls, 2);
    assert.ok(!("vector" in (result as object)));
  });

  it("non-transient failure returns immediately without retry", async () => {
    let calls = 0;
    const embedFn = async () => {
      calls++;
      return errOf("no_key");
    };
    const result = await embedWithTransientRetry(embedFn as never, "hi", settings, 0);
    assert.equal(calls, 1);
    assert.ok(!("vector" in (result as object)));
  });
});
