/**
 * Search provider stats must not surface rows without a live provider connection.
 *
 * Rows with a NULL provider, the '-' sentinel, or a provider with no row in
 * `provider_connections` (deleted connection) must be excluded from the
 * per-provider aggregates and from the recent search entries.
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

let _idSeq = 0;
function insertSearchLog(row: Record<string, unknown>) {
  const db = core.getDbInstance();
  const full = {
    method: "POST",
    path: "/v1/search",
    status: 200,
    model: "search",
    requested_model: null,
    provider: "brave",
    account: null,
    connection_id: null,
    duration: 100,
    tokens_in: 0,
    tokens_out: 0,
    cache_source: "upstream",
    source_format: null,
    target_format: null,
    api_key_id: null,
    api_key_name: null,
    combo_name: null,
    combo_step_id: null,
    combo_execution_key: null,
    error_summary: null,
    detail_state: "none",
    artifact_relpath: null,
    artifact_size_bytes: null,
    artifact_sha256: null,
    has_request_body: 0,
    has_response_body: 0,
    has_pipeline_details: 0,
    request_summary: null,
    request_type: "search",
    ...row,
    id: row.id ?? `log-ghost-${++_idSeq}`,
    timestamp: row.timestamp ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO call_logs (
      id, timestamp, method, path, status, model, requested_model, provider, account,
      connection_id, duration, tokens_in, tokens_out, cache_source, source_format, target_format,
      api_key_id, api_key_name, combo_name, combo_step_id, combo_execution_key,
      error_summary, detail_state, artifact_relpath, artifact_size_bytes, artifact_sha256,
      has_request_body, has_response_body, has_pipeline_details, request_summary, request_type
    ) VALUES (
      @id, @timestamp, @method, @path, @status, @model, @requested_model, @provider, @account,
      @connection_id, @duration, @tokens_in, @tokens_out, @cache_source, @source_format, @target_format,
      @api_key_id, @api_key_name, @combo_name, @combo_step_id, @combo_execution_key,
      @error_summary, @detail_state, @artifact_relpath, @artifact_size_bytes, @artifact_sha256,
      @has_request_body, @has_response_body, @has_pipeline_details, @request_summary, @request_type
    )`
  ).run(full);
}

test.before(() => {
  core.resetDbInstance();
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO provider_connections (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)`
    )
    .run("conn-ghost-brave", "brave", now, now);

  insertSearchLog({ provider: "brave", status: 200, duration: 50 });
  insertSearchLog({ provider: "brave", status: 200, duration: 150 });
  insertSearchLog({ provider: "-", status: 200, duration: 80 });
  insertSearchLog({ provider: "ghost-no-conn", status: 200, duration: 80 });
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, duration,
      tokens_in, tokens_out, cache_source, request_type, detail_state, has_request_body, has_response_body, has_pipeline_details)
      VALUES (?, ?, 'POST', '/v1/search', 200, 'search', NULL, 80, 0, 0, 'upstream', 'search', 'none', 0, 0, 0)`
    )
    .run(`log-ghost-null-${++_idSeq}`, new Date().toISOString());
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("search provider stats exclude rows without a live connection", () => {
  const rows = mod.getSearchProviderStats();
  assert.ok(!rows.some((r) => r.provider === null), "null provider excluded");
  assert.ok(!rows.some((r) => r.provider === "-"), "sentinel provider excluded");
  assert.ok(
    !rows.some((r) => r.provider === "ghost-no-conn"),
    "provider without connection excluded"
  );
  const brave = rows.find((r) => r.provider === "brave");
  assert.ok(brave, "live provider row present");
  assert.equal(brave.requests, 2);
  assert.equal(brave.avg_latency_ms, 100);
});

test("search provider counts exclude rows without a live connection", () => {
  const rows = mod.getSearchProviderCounts();
  assert.ok(!rows.some((r) => r.provider === null), "null provider excluded");
  assert.ok(!rows.some((r) => r.provider === "-"), "sentinel provider excluded");
  assert.ok(
    !rows.some((r) => r.provider === "ghost-no-conn"),
    "provider without connection excluded"
  );
  const brave = rows.find((r) => r.provider === "brave");
  assert.ok(brave, "live provider row present");
  assert.equal(brave.cnt, 2);
  if (rows.length >= 2) {
    assert.ok(rows[0].cnt >= rows[rows.length - 1].cnt, "ordered by cnt desc");
  }
});

test("recent search logs exclude rows without a live connection", () => {
  const rows = mod.getRecentSearchLogs();
  assert.ok(!rows.some((r) => r.provider === null), "null provider excluded");
  assert.ok(!rows.some((r) => r.provider === "-"), "sentinel provider excluded");
  assert.ok(
    !rows.some((r) => r.provider === "ghost-no-conn"),
    "provider without connection excluded"
  );
  assert.ok(
    rows.some((r) => r.provider === "brave"),
    "live provider row present"
  );
});
