import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDataDir = mkdtempSync(join(tmpdir(), "omniroute-reasoning-isolation-"));
process.env.DATA_DIR = testDataDir;
process.env.API_KEY_SECRET = "reasoning-isolation-test-secret";
process.env.APP_LOG_TO_FILE = "false";

const {
  buildReasoningCacheKey,
  cacheReasoningFromAssistantMessage,
  clearReasoningCacheAll,
  getReasoningCacheServiceStats,
  lookupReasoning,
} = await import("../../open-sse/services/reasoningCache.ts");
const { setReasoningCache } = await import("../../src/lib/db/reasoningCache.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

after(() => {
  resetDbInstance();
  rmSync(testDataDir, { recursive: true, force: true });
});
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { NON_ANTHROPIC_THINKING_PLACEHOLDER } =
  await import("../../open-sse/translator/helpers/claudeHelper.ts");

const owner = "authenticated-key-a";
const other = "authenticated-key-b";
const callId = "shared-upstream-call-id";

function capture(apiKeyId: string | undefined, reasoning: string, provider = "deepseek") {
  return cacheReasoningFromAssistantMessage(
    {
      role: "assistant",
      reasoning_content: reasoning,
      tool_calls: [{ id: callId }],
    },
    provider,
    "deepseek-chat",
    { apiKeyId }
  );
}

function replay(apiKeyId?: string, provider = "deepseek", extraBody = {}) {
  const translated = translateRequest(
    "openai",
    "openai",
    "deepseek-chat",
    {
      ...extraBody,
      messages: [
        { role: "user", content: "use a tool" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: callId, type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: callId, content: "done" },
      ],
    },
    false,
    null,
    provider,
    null,
    { reasoningCacheApiKeyId: apiKeyId }
  );
  return translated.messages[1].reasoning_content;
}

test("capture and actual translation isolate identical tool IDs between authenticated clients", () => {
  clearReasoningCacheAll();
  assert.equal(capture(owner, "client A private reasoning"), 1);
  assert.equal(replay(other), NON_ANTHROPIC_THINKING_PLACEHOLDER);
  assert.equal(capture(other, "client B private reasoning"), 1);
  assert.equal(replay(owner), "client A private reasoning");
  assert.equal(replay(other), "client B private reasoning");
});

test("replay never crosses provider boundaries for the same authenticated key", () => {
  clearReasoningCacheAll();
  capture(owner, "deepseek private reasoning");
  assert.equal(replay(owner, "siliconflow"), NON_ANTHROPIC_THINKING_PLACEHOLDER);
  assert.equal(replay(owner), "deepseek private reasoning");
});

test("anonymous requests cannot capture or replay, including spoofed body identity", () => {
  clearReasoningCacheAll();
  assert.equal(capture(undefined, "anonymous private reasoning"), 0);
  assert.equal(getReasoningCacheServiceStats().dbEntries, 0);
  capture(owner, "authenticated private reasoning");
  const spoof = {
    apiKeyId: owner,
    reasoningCacheApiKeyId: owner,
    _reasoningCacheApiKeyId: owner,
    signatureNamespace: owner,
  };
  assert.equal(replay(undefined, "deepseek", spoof), NON_ANTHROPIC_THINKING_PLACEHOLDER);
  assert.equal(replay(other, "deepseek", spoof), NON_ANTHROPIC_THINKING_PLACEHOLDER);
  assert.equal(lookupReasoning(callId), null);
});

test("SQLite fallback is scoped and never loads old unscoped cache entries", () => {
  clearReasoningCacheAll();
  setReasoningCache(callId, "deepseek", "deepseek-chat", "legacy secret");
  assert.equal(replay(owner), NON_ANTHROPIC_THINKING_PLACEHOLDER);
  const scopedKey = buildReasoningCacheKey(callId, owner, "deepseek")!;
  setReasoningCache(scopedKey, "deepseek", "deepseek-chat", "persisted A secret");
  assert.equal(replay(other), NON_ANTHROPIC_THINKING_PLACEHOLDER);
  assert.equal(replay(owner), "persisted A secret");
  assert.equal(lookupReasoning(scopedKey, other, "deepseek"), null);
});

test("plain assistant request-ID replay is also isolated", () => {
  clearReasoningCacheAll();
  cacheReasoningFromAssistantMessage(
    { role: "assistant", reasoning_content: "plain private reasoning" },
    "deepseek",
    "deepseek-chat",
    { apiKeyId: owner, requestId: "shared-request", messageIndex: 0 }
  );
  for (const [apiKeyId, expected] of [
    [other, NON_ANTHROPIC_THINKING_PLACEHOLDER],
    [owner, "plain private reasoning"],
  ]) {
    const result = translateRequest(
      "openai",
      "openai",
      "deepseek-chat",
      {
        request_id: "shared-request",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "continue" },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheApiKeyId: apiKeyId }
    );
    assert.equal(result.messages[1].reasoning_content, expected);
  }
});

test("Claude-shape replay isolates both missing and empty thinking blocks", () => {
  clearReasoningCacheAll();
  capture(owner, "kimi private reasoning", "kimi-coding");
  for (const emptyThinking of [false, true]) {
    for (const [apiKeyId, expected] of [
      [other, NON_ANTHROPIC_THINKING_PLACEHOLDER],
      [owner, "kimi private reasoning"],
    ]) {
      const result = translateRequest(
        "claude",
        "claude",
        "kimi-k2.5",
        {
          thinking: { type: "enabled", budget_tokens: 2000 },
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [
                ...(emptyThinking ? [{ type: "thinking", thinking: "" }] : []),
                { type: "tool_use", id: callId, name: "read_file", input: {} },
              ],
            },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: callId, content: "done" }],
            },
          ],
        },
        false,
        null,
        "kimi-coding",
        null,
        { reasoningCacheApiKeyId: apiKeyId }
      );
      const thinking = result.messages[1].content.find((block) => block.type === "thinking");
      assert.equal(thinking?.thinking, expected);
    }
  }
});
