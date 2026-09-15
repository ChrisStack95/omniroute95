/**
 * Search stats must not surface "ghost" rows, and must not hide real traffic.
 *
 * Hidden: rows with a NULL provider, the '-' sentinel, or a keyed provider whose
 * provider_connections row is gone (deleted connection).
 * Kept: keyed providers with a live connection (directly or through a registry
 * credential fallback such as perplexity-search → perplexity) and keyless
 * providers (`authType: "none"` — duckduckgo-free, searxng-search, anonymous
 * context7), which are served without any provider_connections row.
 * Totals and per-provider rows use the same guard, so they always agree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-db-search-ghost-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const mod = await import("../../src/lib/db/callLogStats.ts");
const { SEARCH_PROVIDERS, SEARCH_CREDENTIAL_FALLBACKS } =
  await import("../../open-sse/config/searchRegistry.ts");
const analyticsRoute = await import("../../src/app/api/v1/search/analytics/route.ts");

const KEYLESS_IDS = Object.values(SEARCH_PROVIDERS)
  .filter((provider) => provider.authType === "none")
  .map((provider) => provider.id);

let idSeq = 0;
function insertSearchLog(provider: string | null, fields: Record<string, unknown> = {}) {
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, duration,
        tokens_in, tokens_out, cache_source, request_type, detail_state, error_summary,
        request_summary, has_request_body, has_response_body, has_pipeline_details)
       VALUES (@id, @timestamp, 'POST', '/v1/search', @status, 'search', @provider, @duration,
        0, 0, 'upstream', 'search', 'none', NULL, @summary, 0, 0, 0)`
    )
    .run({
      id: `log-ghost-${++idSeq}`,
      timestamp: new Date().toISOString(),
      status: 200,
      duration: 100,
      summary: JSON.stringify({ query: `q-${idSeq}` }),
      provider,
      ...fields,
    });
}

function insertConnection(id: string, provider: string) {
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO provider_connections (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)`
    )
    .run(id, provider, now, now);
}

test.before(() => {
  core.resetDbInstance();
  insertConnection("conn-ghost-brave", "brave-search");
  insertConnection("conn-ghost-perplexity-chat", "perplexity");

  insertSearchLog("brave-search", { duration: 50 });
  insertSearchLog("brave-search", { duration: 150, status: 502 });
  insertSearchLog("perplexity-search", { duration: 90 }); // live via credential fallback
  insertSearchLog("duckduckgo-free", { duration: 70 }); // keyless, no connection row
  insertSearchLog("duckduckgo-free", { duration: 30 });
  insertSearchLog("searxng-search", { duration: 40 }); // keyless, no connection row
  insertSearchLog("context7", { duration: 60 }); // anonymous tier, no connection row
  // Ghosts
  insertSearchLog("tavily-search", { duration: 80 }); // connection deleted
  insertSearchLog("-", { duration: 80 });
  insertSearchLog(null, { duration: 80 });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const EXPECTED_COUNTS: Record<string, number> = {
  "brave-search": 2,
  "duckduckgo-free": 2,
  "perplexity-search": 1,
  "searxng-search": 1,
  context7: 1,
};

test("registry fixtures used here are real: keyless ids and the perplexity fallback", () => {
  for (const id of ["duckduckgo-free", "searxng-search", "context7"]) {
    assert.ok(KEYLESS_IDS.includes(id), `${id} is authType none in the search registry`);
  }
  for (const id of ["brave-search", "tavily-search", "perplexity-search"]) {
    assert.equal(SEARCH_PROVIDERS[id]?.authType, "apikey", `${id} is a keyed search provider`);
  }
  assert.equal(SEARCH_CREDENTIAL_FALLBACKS["perplexity-search"], "perplexity");
});

test("getSearchProviderStats keeps live + keyless providers and drops ghosts", () => {
  const rows = mod.getSearchProviderStats();
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.provider, r.requests])), EXPECTED_COUNTS);
  assert.equal(byProvider["brave-search"].avg_latency_ms, 100);
  assert.equal(byProvider["duckduckgo-free"].avg_latency_ms, 50);
});

test("getSearchProviderCounts keeps live + keyless providers, ordered by count", () => {
  const rows = mod.getSearchProviderCounts();
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.provider, r.cnt])), EXPECTED_COUNTS);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].cnt >= rows[i].cnt, "ordered by cnt desc");
  }
});

test("getRecentSearchLogs keeps keyless traffic and drops ghost rows", () => {
  const providers = mod.getRecentSearchLogs().map((r) => r.provider);
  assert.equal(providers.length, 7);
  for (const ghost of ["tavily-search", "-", null]) {
    assert.ok(!providers.includes(ghost as string), `${String(ghost)} excluded`);
  }
  for (const live of Object.keys(EXPECTED_COUNTS)) {
    assert.ok(providers.includes(live), `${live} present`);
  }
});

test("aggregate totals agree with the per-provider breakdown", () => {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const stats = mod.getSearchAggregateStats(todayStart.toISOString());
  const breakdownTotal = mod.getSearchProviderCounts().reduce((sum, r) => sum + r.cnt, 0);
  assert.equal(stats.total, breakdownTotal);
  assert.equal(stats.total, 7);
  assert.equal(stats.today, 7);
  assert.equal(stats.errors, 1);
});

test("GET /api/v1/search/analytics: total equals the sum of byProvider counts", async () => {
  const response = await analyticsRoute.GET(
    new Request("http://localhost/api/v1/search/analytics")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    total: number;
    byProvider: Record<string, { count: number }>;
  };
  const byProviderTotal = Object.values(body.byProvider).reduce((sum, p) => sum + p.count, 0);
  assert.equal(body.total, byProviderTotal);
  assert.equal(body.byProvider["duckduckgo-free"]?.count, 2);
  assert.equal(body.byProvider["tavily-search"], undefined);
});
