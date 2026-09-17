import test from "node:test";
import assert from "node:assert/strict";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";

test("#12633: openai-responses format on opencode-zen sends x-api-key, not Authorization Bearer", () => {
  const executor = new OpencodeExecutor("opencode-zen");
  executor._requestFormat = "openai-responses";
  const headers = executor.buildHeaders(
    { apiKey: "sk-zen-test" },
    true,
    null,
    "muse-spark-1.2-contributor-free"
  );

  assert.equal(headers["x-api-key"], "sk-zen-test");
  assert.equal(headers["Authorization"], undefined);
});

test("#12633: openai-responses format on the base opencode (oc) provider also sends x-api-key", () => {
  const executor = new OpencodeExecutor("opencode");
  executor._requestFormat = "openai-responses";
  const headers = executor.buildHeaders(
    { apiKey: "sk-oc-test" },
    true,
    null,
    "muse-spark-1.2-contributor-free"
  );

  assert.equal(headers["x-api-key"], "sk-oc-test");
  assert.equal(headers["Authorization"], undefined);
});

test("#12633: openai-responses format on opencode-go (different upstream endpoint) keeps Authorization Bearer", () => {
  const executor = new OpencodeExecutor("opencode-go");
  executor._requestFormat = "openai-responses";
  const headers = executor.buildHeaders(
    { apiKey: "sk-go-test" },
    true,
    null,
    "muse-spark-1.2-contributor"
  );

  assert.equal(headers["Authorization"], "Bearer sk-go-test");
  assert.equal(headers["x-api-key"], undefined);
});

test("#12633: claude format keeps sending x-api-key (unchanged behavior)", () => {
  const executor = new OpencodeExecutor("opencode-zen");
  executor._requestFormat = "claude";
  const headers = executor.buildHeaders({ apiKey: "sk-claude-test" }, true, null, "some-model");

  assert.equal(headers["x-api-key"], "sk-claude-test");
  assert.equal(headers["Authorization"], undefined);
});

test("OpenCode Zen free tier uses the public bearer credential without an API key", () => {
  const executor = new OpencodeExecutor("opencode-zen");
  const headers = executor.buildHeaders(null, true, null, "mimo-v2.5-free");

  assert.equal(headers["Authorization"], "Bearer public");
  assert.equal(headers["x-api-key"], undefined);
});

test("OpenCode Go does not fabricate the public bearer credential", () => {
  const executor = new OpencodeExecutor("opencode-go");
  const headers = executor.buildHeaders(null, true, null, "mimo-v2.5");

  assert.equal(headers["Authorization"], undefined);
  assert.equal(headers["x-api-key"], undefined);
});
