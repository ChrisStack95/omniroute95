import test from "node:test";
import assert from "node:assert/strict";

const completed = await import("../../src/lib/usage/completedRequestDetails.ts");

const originalByteBudget = process.env.MAX_COMPLETED_DETAILS_BYTES;

function makeDetail(
  id: string,
  payload: unknown,
  streamChunks: {
    provider?: string[];
    openai?: string[];
    client?: string[];
  } | null = null
) {
  return {
    id,
    model: "fixture-model",
    provider: "fixture-provider",
    connectionId: "fixture-connection",
    startedAt: Date.now(),
    clientRequest: payload,
    providerRequest: payload,
    providerResponse: payload,
    clientResponse: payload,
    streamChunks,
  };
}

test.beforeEach(() => {
  completed.clearCompletedDetails();
  delete process.env.MAX_COMPLETED_DETAILS_BYTES;
});

test.after(() => {
  completed.clearCompletedDetails();
  if (originalByteBudget === undefined) {
    delete process.env.MAX_COMPLETED_DETAILS_BYTES;
  } else {
    process.env.MAX_COMPLETED_DETAILS_BYTES = originalByteBudget;
  }
});

test("#13621 completed cache re-truncates request previews before retaining them", () => {
  const hugeBacking = `prefix-${"x".repeat(4 * 1024 * 1024)}-secret-tail`;
  // Deliberately pass a slice backed by the large source string. The production
  // failure retained this backing allocation even though the visible preview
  // was only ~1.2 KiB.
  const sliced = hugeBacking.slice(7);

  completed.storeCompletedDetail(makeDetail("detached-preview", { prompt: sliced }));

  const stored = completed.getCompletedDetails().get("detached-preview");
  assert.ok(stored);
  const prompt = (stored!.clientRequest as { prompt: string }).prompt;
  assert.ok(prompt.endsWith("..."));
  assert.ok(prompt.length <= 1203);
  assert.equal(prompt.includes("secret-tail"), false);

  const stats = completed.getCompletedDetailCacheStats();
  assert.equal(stats.entries, 1);
  assert.ok(stats.bytes < 32 * 1024, `expected a bounded preview, got ${stats.bytes} bytes`);
});

test("#13621 completed cache enforces a byte budget in addition to the entry-count cap", () => {
  process.env.MAX_COMPLETED_DETAILS_BYTES = String(64 * 1024);

  for (let i = 0; i < 100; i++) {
    completed.storeCompletedDetail(
      makeDetail(`entry-${i}`, {
        prompt: `${i}:${"y".repeat(5000)}`,
      })
    );
  }

  const stats = completed.getCompletedDetailCacheStats();
  assert.ok(stats.bytes <= stats.maxBytes, `${stats.bytes} must stay <= ${stats.maxBytes}`);
  assert.ok(stats.entries < 100, "byte pressure should evict old completed details");
  assert.equal(completed.getCompletedDetails().has("entry-0"), false);
  assert.equal(completed.getCompletedDetails().has("entry-99"), true);
});

test("#13621 replacing one cached id does not double-count retained bytes", () => {
  process.env.MAX_COMPLETED_DETAILS_BYTES = String(64 * 1024);

  completed.storeCompletedDetail(makeDetail("same-id", { prompt: "first" }));
  const first = completed.getCompletedDetailCacheStats();

  completed.storeCompletedDetail(makeDetail("same-id", { prompt: "z".repeat(5000) }));
  const second = completed.getCompletedDetailCacheStats();

  assert.equal(second.entries, 1);
  assert.ok(second.bytes <= second.maxBytes);
  assert.ok(second.bytes < first.bytes + 16 * 1024, "replacement must replace byte accounting");
});

test("#13621 completed stream diagnostics are bounded and materialized", () => {
  const chunks = Array.from({ length: 100 }, (_, i) => `${i}:${"s".repeat(5000)}`);

  completed.storeCompletedDetail(
    makeDetail("stream-bounded", { prompt: "ok" }, { provider: chunks, openai: chunks, client: chunks })
  );

  const stored = completed.getCompletedDetails().get("stream-bounded");
  assert.ok(stored?.streamChunks);
  for (const stage of ["provider", "openai", "client"] as const) {
    const values = stored!.streamChunks?.[stage];
    assert.ok(values);
    assert.equal(values!.length, 65, `${stage} keeps 64 chunks plus a truncation marker`);
    assert.ok(values![0].length <= 1203);
    assert.match(values![64], /^\[TRUNCATED_STREAM_CHUNKS: 36\]$/);
  }
});

test("#13621 an individual diagnostic larger than the configured cache is compacted", () => {
  process.env.MAX_COMPLETED_DETAILS_BYTES = String(64 * 1024);
  const chunks = Array.from({ length: 64 }, () => "q".repeat(5000));

  completed.storeCompletedDetail(
    makeDetail("oversized", { prompt: "q".repeat(5000) }, { provider: chunks })
  );

  const stored = completed.getCompletedDetails().get("oversized");
  assert.ok(stored, "newest detail remains available after compaction");
  assert.equal(stored!.streamChunks, null);
  assert.equal(
    stored!.clientRequest,
    "[omitted: completed detail exceeded cache byte budget]"
  );
  const stats = completed.getCompletedDetailCacheStats();
  assert.ok(stats.bytes <= stats.maxBytes);
});

test("#13621 clearing completed diagnostics resets byte accounting", () => {
  completed.storeCompletedDetail(makeDetail("clear-me", { prompt: "hello" }));
  assert.ok(completed.getCompletedDetailCacheStats().bytes > 0);

  completed.clearCompletedDetails();

  assert.deepEqual(completed.getCompletedDetailCacheStats().entries, 0);
  assert.deepEqual(completed.getCompletedDetailCacheStats().bytes, 0);
});
