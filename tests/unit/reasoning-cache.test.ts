import { buildReasoningCacheKey } from "../../open-sse/services/reasoningCache.ts";
/**
 * Unit tests for the Reasoning Replay Cache (Issue #1628).
 *
 * Covers: memory cache, DB fallback, hit/miss counters,
 * provider detection, and cleanup behavior.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-reasoning-"));
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "reasoning-cache-test-secret";

// ──────────── Direct service import ────────────

import {
  cacheReasoningFromAssistantMessage,
  cacheReasoning,
  cacheReasoningByKey,
  cacheReasoningBatch,
  deleteReasoningCacheEntry,
  getReasoningCacheServiceEntries,
  lookupReasoning,
  recordReplay,
  getReasoningCacheServiceStats,
  clearReasoningCacheAll,
  isDeepSeekReasoningModel,
  requiresReasoningReplay,
  cleanupReasoningCache,
} from "../../open-sse/services/reasoningCache.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { ensureToolCallIds } from "../../open-sse/translator/helpers/toolCallHelper.ts";
import { getDbInstance } from "../../src/lib/db/core.ts";
import { getReasoningCache, setReasoningCache } from "../../src/lib/db/reasoningCache.ts";
import { DELETE, GET } from "../../src/app/api/cache/reasoning/route.ts";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { updateSettings } from "../../src/lib/db/settings";
import {
  clearModelsDevCapabilities,
  saveModelsDevCapabilities,
} from "../../src/lib/modelsDevSync.ts";

function buildCapability(overrides = {}) {
  return {
    tool_call: null,
    reasoning: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: "[]",
    modalities_output: "[]",
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    ...overrides,
  };
}

before(async () => {
  await updateSettings({ requireLogin: false });
});

after(async () => {
  await updateSettings({ requireLogin: true });
});

describe("Reasoning Replay Cache — Service Layer", () => {
  before(() => {
    // Start each suite with a clean slate
    clearReasoningCacheAll();
  });

  after(() => {
    clearReasoningCacheAll();
  });

  it("should store and retrieve reasoning by tool_call_id", () => {
    cacheReasoning(
      "call_test_1",
      "deepseek",
      "deepseek-reasoner",
      "The user wants to read the file...",
      "reasoning-test-key"
    );
    const result = lookupReasoning("call_test_1", "reasoning-test-key", "deepseek");
    assert.equal(result, "The user wants to read the file...");
    assert.equal(
      getReasoningCache(buildReasoningCacheKey("call_test_1", "reasoning-test-key", "deepseek")!)
        ?.reasoning,
      "The user wants to read the file..."
    );
  });

  it("should fall back to SQLite when memory misses", () => {
    clearReasoningCacheAll();
    setReasoningCache(
      buildReasoningCacheKey("call_db_only", "reasoning-test-key", "deepseek")!,
      "deepseek",
      "deepseek-reasoner",
      "DB-only reasoning"
    );

    assert.equal(
      lookupReasoning("call_db_only", "reasoning-test-key", "deepseek"),
      "DB-only reasoning"
    );

    const stats = getReasoningCacheServiceStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.memoryEntries, 1);
    assert.equal(stats.dbEntries, 1);
  });

  it("should return null for unknown tool_call_id", () => {
    const result = lookupReasoning("call_nonexistent", "reasoning-test-key", "deepseek");
    assert.equal(result, null);
  });

  it("should return null for empty tool_call_id", () => {
    const result = lookupReasoning("", "reasoning-test-key", "deepseek");
    assert.equal(result, null);
  });

  it("should skip caching when reasoning is empty", () => {
    cacheReasoning("call_empty", "deepseek", "deepseek-chat", "", "reasoning-test-key");
    const result = lookupReasoning("call_empty", "reasoning-test-key", "deepseek");
    assert.equal(result, null);
  });

  it("should cache reasoning for multiple tool_call_ids (batch)", () => {
    cacheReasoningBatch(
      ["call_batch_1", "call_batch_2", "call_batch_3"],
      "deepseek",
      "deepseek-reasoner",
      "Batch reasoning content",
      "reasoning-test-key"
    );
    assert.equal(
      lookupReasoning("call_batch_1", "reasoning-test-key", "deepseek"),
      "Batch reasoning content"
    );
    assert.equal(
      lookupReasoning("call_batch_2", "reasoning-test-key", "deepseek"),
      "Batch reasoning content"
    );
    assert.equal(
      lookupReasoning("call_batch_3", "reasoning-test-key", "deepseek"),
      "Batch reasoning content"
    );
  });

  it("should capture assistant reasoning for all tool_call IDs", () => {
    clearReasoningCacheAll();

    const cached = cacheReasoningFromAssistantMessage(
      {
        role: "assistant",
        reasoning_content: "Captured assistant reasoning",
        tool_calls: [{ id: "call_capture_1" }, { id: "call_capture_2" }],
      },
      "deepseek",
      "deepseek-reasoner",
      { apiKeyId: "reasoning-test-key" }
    );

    assert.equal(cached, 2);
    assert.equal(
      lookupReasoning("call_capture_1", "reasoning-test-key", "deepseek"),
      "Captured assistant reasoning"
    );
    assert.equal(
      lookupReasoning("call_capture_2", "reasoning-test-key", "deepseek"),
      "Captured assistant reasoning"
    );
  });

  it("should keep request message cache keys stable when tool call IDs change", () => {
    clearReasoningCacheAll();

    const requestId = "req_reasoning_stable";
    const messageIndex = 2;
    const cacheKey = `${requestId}:${messageIndex}`;
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_before_normalization",
              type: "function",
              function: { name: "lookup", arguments: { city: "Seoul" } },
            },
          ],
        },
        { role: "tool", content: "Sunny" },
      ],
    };

    cacheReasoning(
      cacheKey,
      "deepseek",
      "deepseek-reasoner",
      "Stable cached reasoning",
      "reasoning-test-key"
    );
    const originalToolCallId = body.messages[0].tool_calls[0].id;

    ensureToolCallIds(body, { use9CharId: true });

    assert.notEqual(body.messages[0].tool_calls[0].id, originalToolCallId);
    assert.equal(
      lookupReasoning(cacheKey, "reasoning-test-key", "deepseek"),
      "Stable cached reasoning"
    );
  });

  it("should capture provider reasoning alias when reasoning_content is absent", () => {
    clearReasoningCacheAll();

    const cached = cacheReasoningFromAssistantMessage(
      {
        role: "assistant",
        reasoning: "Alias reasoning",
        tool_calls: [{ id: "call_capture_alias" }],
      },
      "kimi",
      "kimi-k2.5",
      { apiKeyId: "reasoning-test-key" }
    );

    assert.equal(cached, 1);
    assert.equal(
      lookupReasoning("call_capture_alias", "reasoning-test-key", "kimi"),
      "Alias reasoning"
    );
  });

  it("should cache assistant reasoning without tool calls by request and message index", () => {
    clearReasoningCacheAll();

    const cached = cacheReasoningFromAssistantMessage(
      {
        role: "assistant",
        reasoning_content: "No tool call reasoning",
      },
      "deepseek",
      "deepseek-reasoner",
      { ...{ requestId: "req_no_tools", messageIndex: 3 }, apiKeyId: "reasoning-test-key" }
    );

    assert.equal(cached, 1);
    assert.equal(
      lookupReasoning("request:req_no_tools:message:3", "reasoning-test-key", "deepseek"),
      "No tool call reasoning"
    );
  });

  it("should skip assistant reasoning without tool calls when stable key context is absent", () => {
    clearReasoningCacheAll();

    const cached = cacheReasoningFromAssistantMessage(
      {
        role: "assistant",
        reasoning_content: "Missing key context",
      },
      "deepseek",
      "deepseek-reasoner",
      { apiKeyId: "reasoning-test-key" }
    );

    assert.equal(cached, 0);
    assert.equal(
      lookupReasoning("request:req_missing:message:0", "reasoning-test-key", "deepseek"),
      null
    );
  });

  it("should store arbitrary reasoning cache keys", () => {
    clearReasoningCacheAll();

    cacheReasoningByKey(
      "request:req_direct:message:1",
      "deepseek",
      "deepseek-reasoner",
      "Keyed plan",
      "reasoning-test-key"
    );

    assert.equal(
      lookupReasoning("request:req_direct:message:1", "reasoning-test-key", "deepseek"),
      "Keyed plan"
    );
    assert.equal(
      getReasoningCache(
        buildReasoningCacheKey("request:req_direct:message:1", "reasoning-test-key", "deepseek")!
      )?.reasoning,
      "Keyed plan"
    );
  });

  it("should not overwrite if same tool_call_id is cached again", () => {
    cacheReasoning(
      "call_overwrite",
      "deepseek",
      "deepseek-chat",
      "First reasoning",
      "reasoning-test-key"
    );
    cacheReasoning(
      "call_overwrite",
      "deepseek",
      "deepseek-chat",
      "Updated reasoning",
      "reasoning-test-key"
    );
    // Second write wins (INSERT OR REPLACE)
    const result = lookupReasoning("call_overwrite", "reasoning-test-key", "deepseek");
    assert.equal(result, "Updated reasoning");
  });

  it("should track hits and misses correctly", () => {
    clearReasoningCacheAll();

    cacheReasoning(
      "call_hit_test",
      "deepseek",
      "deepseek-chat",
      "test reasoning",
      "reasoning-test-key"
    );

    lookupReasoning("call_hit_test", "reasoning-test-key", "deepseek"); // hit
    lookupReasoning("call_hit_test", "reasoning-test-key", "deepseek"); // hit
    lookupReasoning("call_miss_test", "reasoning-test-key", "deepseek"); // miss

    const stats = getReasoningCacheServiceStats();
    assert.ok(stats.hits >= 2, `Expected at least 2 hits, got ${stats.hits}`);
    assert.ok(stats.misses >= 1, `Expected at least 1 miss, got ${stats.misses}`);
  });

  it("should track replays", () => {
    clearReasoningCacheAll();

    recordReplay();
    recordReplay();
    recordReplay();

    const stats = getReasoningCacheServiceStats();
    assert.ok(stats.replays >= 3, `Expected at least 3 replays, got ${stats.replays}`);
  });

  it("should report correct stats structure", () => {
    clearReasoningCacheAll();

    cacheReasoning(
      "call_stat_1",
      "deepseek",
      "deepseek-reasoner",
      "Reasoning A",
      "reasoning-test-key"
    );
    cacheReasoning(
      "call_stat_2",
      "kimi",
      "kimi-k2.5",
      "Reasoning B from Kimi",
      "reasoning-test-key"
    );

    const stats = getReasoningCacheServiceStats();

    assert.equal(typeof stats.memoryEntries, "number");
    assert.equal(typeof stats.dbEntries, "number");
    assert.equal(typeof stats.totalEntries, "number");
    assert.equal(typeof stats.totalChars, "number");
    assert.equal(typeof stats.hits, "number");
    assert.equal(typeof stats.misses, "number");
    assert.equal(typeof stats.replays, "number");
    assert.equal(typeof stats.replayRate, "string");
    assert.ok(stats.replayRate.endsWith("%"));
    assert.equal(typeof stats.byProvider, "object");
    assert.equal(typeof stats.byModel, "object");
    assert.equal(stats.dbEntries, 2);
    assert.equal(stats.byProvider.deepseek.entries, 1);
    assert.equal(stats.byProvider.kimi.entries, 1);
  });

  it("should list persisted entries for the dashboard API", () => {
    clearReasoningCacheAll();

    cacheReasoning(
      "call_entry_1",
      "deepseek",
      "deepseek-reasoner",
      "Entry reasoning A",
      "reasoning-test-key"
    );
    cacheReasoning("call_entry_2", "kimi", "kimi-k2.5", "Entry reasoning B", "reasoning-test-key");

    const deepseekEntries = getReasoningCacheServiceEntries({ provider: "deepseek" }) as Array<{
      toolCallId: string;
      expiresAt: string;
    }>;

    assert.equal(deepseekEntries.length, 1);
    assert.equal(
      deepseekEntries[0].toolCallId,
      buildReasoningCacheKey("call_entry_1", "reasoning-test-key", "deepseek")
    );
    assert.doesNotThrow(() => new Date(deepseekEntries[0].expiresAt).toISOString());
  });

  it("should clear all entries", () => {
    cacheReasoning(
      "call_clear_1",
      "deepseek",
      "deepseek-chat",
      "Will be cleared",
      "reasoning-test-key"
    );
    cacheReasoning(
      "call_clear_2",
      "deepseek",
      "deepseek-chat",
      "Also cleared",
      "reasoning-test-key"
    );

    const count = clearReasoningCacheAll();
    assert.ok(count >= 0);

    assert.equal(lookupReasoning("call_clear_1", "reasoning-test-key", "deepseek"), null);
    assert.equal(lookupReasoning("call_clear_2", "reasoning-test-key", "deepseek"), null);
  });

  it("should delete one entry by tool_call_id", () => {
    clearReasoningCacheAll();

    cacheReasoning("call_delete_1", "deepseek", "deepseek-chat", "Delete me", "reasoning-test-key");
    cacheReasoning("call_delete_2", "deepseek", "deepseek-chat", "Keep me", "reasoning-test-key");

    assert.equal(
      deleteReasoningCacheEntry(
        buildReasoningCacheKey("call_delete_1", "reasoning-test-key", "deepseek")!
      ),
      1
    );
    assert.equal(lookupReasoning("call_delete_1", "reasoning-test-key", "deepseek"), null);
    assert.equal(lookupReasoning("call_delete_2", "reasoning-test-key", "deepseek"), "Keep me");
  });

  it("should clear entries by provider only", () => {
    clearReasoningCacheAll();

    cacheReasoning(
      "call_provider_ds",
      "deepseek",
      "deepseek-chat",
      "DeepSeek reasoning",
      "reasoning-test-key"
    );
    cacheReasoning(
      "call_provider_kimi",
      "kimi",
      "kimi-k2.5",
      "Kimi reasoning",
      "reasoning-test-key"
    );

    assert.equal(clearReasoningCacheAll("deepseek"), 1);
    assert.equal(lookupReasoning("call_provider_ds", "reasoning-test-key", "deepseek"), null);
    assert.equal(
      lookupReasoning("call_provider_kimi", "reasoning-test-key", "kimi"),
      "Kimi reasoning"
    );
  });

  it("should cleanup expired reasoning (no-op when nothing expired)", () => {
    cacheReasoning(
      "call_cleanup_test",
      "deepseek",
      "deepseek-chat",
      "Not expired yet",
      "reasoning-test-key"
    );
    const cleaned = cleanupReasoningCache();
    assert.equal(typeof cleaned, "number");
    // Entry should still be available since TTL is 2 hours
    assert.equal(
      lookupReasoning("call_cleanup_test", "reasoning-test-key", "deepseek"),
      "Not expired yet"
    );
  });

  it("should not return expired SQLite entries and cleanup should prune them", () => {
    clearReasoningCacheAll();
    setReasoningCache(
      buildReasoningCacheKey("call_expired", "reasoning-test-key", "deepseek")!,
      "deepseek",
      "deepseek-chat",
      "Expired reasoning",
      -1_000
    );

    assert.equal(lookupReasoning("call_expired", "reasoning-test-key", "deepseek"), null);
    assert.equal(cleanupReasoningCache(), 1);
    assert.equal(getReasoningCacheServiceStats().dbEntries, 0);
  });

  it("should read and prune legacy ISO expires_at rows", () => {
    clearReasoningCacheAll();

    const db = getDbInstance();
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const expiredIso = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      `INSERT INTO reasoning_cache
         (tool_call_id, provider, model, reasoning, char_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`
    ).run(
      buildReasoningCacheKey("call_legacy_iso_active", "reasoning-test-key", "deepseek"),
      "deepseek",
      "deepseek-chat",
      "Legacy ISO reasoning",
      "Legacy ISO reasoning".length,
      futureIso
    );
    db.prepare(
      `INSERT INTO reasoning_cache
         (tool_call_id, provider, model, reasoning, char_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`
    ).run(
      buildReasoningCacheKey("call_legacy_iso_expired", "reasoning-test-key", "deepseek"),
      "deepseek",
      "deepseek-chat",
      "Expired legacy ISO reasoning",
      "Expired legacy ISO reasoning".length,
      expiredIso
    );

    assert.equal(
      lookupReasoning("call_legacy_iso_active", "reasoning-test-key", "deepseek"),
      "Legacy ISO reasoning"
    );
    assert.equal(
      lookupReasoning("call_legacy_iso_expired", "reasoning-test-key", "deepseek"),
      null
    );
    const entries = getReasoningCacheServiceEntries({ provider: "deepseek" }) as Array<{
      toolCallId: string;
      expiresAt: string;
    }>;
    assert.equal(
      entries.some((entry) => entry.expiresAt === futureIso),
      true
    );
    assert.equal(cleanupReasoningCache(), 1);
  });
});

describe("Reasoning Replay Cache — Provider Detection", () => {
  it("should detect deepseek as requiring replay", () => {
    assert.equal(requiresReasoningReplay({ provider: "deepseek", model: "deepseek-chat" }), true);
  });

  it("should detect opencode-go as requiring replay", () => {
    assert.equal(requiresReasoningReplay({ provider: "opencode-go", model: "some-model" }), true);
  });

  it("should not replay legacy deepseek-r1 even under replay providers", () => {
    assert.equal(requiresReasoningReplay({ provider: "siliconflow", model: "deepseek-r1" }), false);
  });

  it("should not replay deepseek-r1 model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "deepseek-r1" }),
      false
    );
  });

  it("should detect deepseek-reasoner model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "deepseek-reasoner" }),
      false
    );
  });

  it("should detect DeepSeek V4 model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "deepseek/v4-pro" }),
      true
    );
  });

  it("should detect DeepSeek V4 thinking mode explicitly", () => {
    assert.equal(
      isDeepSeekReasoningModel({
        provider: "unknown-provider",
        model: "deepseek-v4.flash",
        thinkingEnabled: true,
      }),
      true
    );
  });

  it("should NOT detect DeepSeek V4 when thinking mode is disabled", () => {
    assert.equal(
      isDeepSeekReasoningModel({
        provider: "unknown-provider",
        model: "deepseek-v4.flash",
        thinkingEnabled: false,
      }),
      false
    );
  });

  it("should detect kimi-k2 model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "kimi-k2.5" }),
      true
    );
  });

  it("should detect qwq model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "qwq-32b-preview" }),
      true
    );
  });

  it("should detect qwen-thinking model pattern", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "qwen3-thinking-235b" }),
      true
    );
  });

  it("should detect GLM thinking model pattern", () => {
    assert.equal(requiresReasoningReplay({ provider: "glm", model: "glm-5-thinking" }), true);
  });

  it("should detect xiaomi-mimo provider", () => {
    // MiMo enforces reasoning_content echo on subsequent turns; without
    // replay the upstream returns 400 "Param Incorrect: The reasoning_content
    // in the thinking mode must be passed back to the API."
    assert.equal(
      requiresReasoningReplay({ provider: "xiaomi-mimo", model: "mimo-v2.5-pro" }),
      true
    );
    assert.equal(requiresReasoningReplay({ provider: "XIAOMI-MIMO", model: "mimo-v2.5" }), true);
  });

  it("should detect mimo-v* model pattern under any provider id", () => {
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "mimo-v2.5-pro" }),
      true
    );
    assert.equal(requiresReasoningReplay({ provider: "unknown-provider", model: "mimo-v3" }), true);
    assert.equal(
      requiresReasoningReplay({ provider: "unknown-provider", model: "MimoV2.5-pro" }),
      true
    );
  });

  it("should NOT detect a generic openai model", () => {
    assert.equal(requiresReasoningReplay({ provider: "openai", model: "gpt-4o" }), false);
  });

  it("should NOT detect claude as requiring replay", () => {
    assert.equal(requiresReasoningReplay({ provider: "anthropic", model: "claude-opus-4" }), false);
  });
});

describe("Reasoning Replay Cache — Translator Replay", () => {
  before(() => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
  });

  after(() => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
  });

  function translateWithToolHistory(provider: string, model: string, callId: string) {
    return translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      model,
      {
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: callId, type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: callId, content: "tool result" },
        ],
      },
      false,
      null,
      provider,
      null,
      { reasoningCacheApiKeyId: "reasoning-test-key" }
    );
  }

  it("should inject cached reasoning for DeepSeek instead of empty fallback", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-reasoner": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    cacheReasoning(
      "call_translate_ds",
      "deepseek",
      "deepseek-reasoner",
      "DeepSeek cached plan",
      "reasoning-test-key"
    );

    const translated = translateWithToolHistory(
      "deepseek",
      "deepseek-reasoner",
      "call_translate_ds"
    );

    assert.equal(translated.messages[1].reasoning_content, "DeepSeek cached plan");
    assert.equal(getReasoningCacheServiceStats().replays, 1);
  });

  it("should preserve client-provided reasoning content", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-reasoner": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    cacheReasoning(
      "call_preserve",
      "deepseek",
      "deepseek-reasoner",
      "Cached reasoning",
      "reasoning-test-key"
    );

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-reasoner",
      {
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "Client reasoning",
            tool_calls: [
              {
                id: "call_preserve",
                type: "function",
                function: { name: "tool", arguments: "{}" },
              },
            ],
          },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheApiKeyId: "reasoning-test-key" }
    );

    assert.equal(translated.messages[1].reasoning_content, "Client reasoning");
    assert.equal(getReasoningCacheServiceStats().replays, 0);
  });

  it("should inject cached reasoning for Qwen and GLM thinking models", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      qwen: {
        "qwen3-thinking-235b": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
      glm: {
        "glm-5-thinking": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    cacheReasoning(
      "call_qwen_think",
      "qwen",
      "qwen3-thinking-235b",
      "Qwen cached plan",
      "reasoning-test-key"
    );
    cacheReasoning(
      "call_glm_think",
      "glm",
      "glm-5-thinking",
      "GLM cached plan",
      "reasoning-test-key"
    );

    const qwen = translateWithToolHistory("qwen", "qwen3-thinking-235b", "call_qwen_think");
    const glm = translateWithToolHistory("glm", "glm-5-thinking", "call_glm_think");

    assert.equal(qwen.messages[1].reasoning_content, "Qwen cached plan");
    assert.equal(glm.messages[1].reasoning_content, "GLM cached plan");
    assert.equal(getReasoningCacheServiceStats().replays, 2);
  });

  it("should not inject reasoning_content for generic non-reasoning providers", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    cacheReasoning("call_openai", "openai", "gpt-4o", "Should not replay", "reasoning-test-key");

    const translated = translateWithToolHistory("openai", "gpt-4o", "call_openai");

    assert.equal(translated.messages[1].reasoning_content, undefined);
    assert.equal(getReasoningCacheServiceStats().replays, 0);
  });

  it("should support the full capture then replay flow", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-reasoner": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });

    const captured = cacheReasoningFromAssistantMessage(
      {
        role: "assistant",
        reasoning_content: "Full flow cached plan",
        tool_calls: [{ id: "call_full_flow", type: "function" }],
      },
      "deepseek",
      "deepseek-reasoner",
      { apiKeyId: "reasoning-test-key" }
    );

    const translated = translateWithToolHistory("deepseek", "deepseek-reasoner", "call_full_flow");

    assert.equal(captured, 1);
    assert.equal(translated.messages[1].reasoning_content, "Full flow cached plan");
    assert.equal(getReasoningCacheServiceStats().replays, 1);
  });

  it("should strip reasoning_content when model has no interleaved replay signal", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-reasoner",
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "ok",
            reasoning_content: "should be stripped",
          },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheApiKeyId: "reasoning-test-key" }
    );

    assert.equal(translated.messages[1].reasoning_content, undefined);
  });

  it("should not inject reasoning_content when interleaved field is reasoning_details", () => {
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      testprovider: {
        "test-reasoning-details": buildCapability({
          interleaved_field: "reasoning_details",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    cacheReasoning(
      "call_details",
      "testprovider",
      "test-reasoning-details",
      "cached",
      "reasoning-test-key"
    );

    const translated = translateWithToolHistory(
      "testprovider",
      "test-reasoning-details",
      "call_details"
    );

    assert.equal(translated.messages[1].reasoning_content, undefined);
  });

  it("should replace empty-string reasoning_content with NON_ANTHROPIC_THINKING_PLACEHOLDER on cache miss", async () => {
    // Regression: injectEmptyReasoningContentForToolCalls (schemaCoercion.ts) pre-sets
    // reasoning_content="" before the cache lookup. The old condition
    // `msg.reasoning_content === undefined` never fired on cache miss, leaving the
    // empty string in place. DeepSeek V4+ rejects "" with a 400.
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-v4-flash": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });

    const { NON_ANTHROPIC_THINKING_PLACEHOLDER } =
      await import("../../open-sse/translator/helpers/claudeHelper.ts");

    // No cache entry → cache miss
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-v4-flash",
      {
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "",
            tool_calls: [
              {
                id: "call_empty_rc",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_empty_rc", content: "file contents" },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheApiKeyId: "reasoning-test-key" }
    );

    assert.equal(
      translated.messages[1].reasoning_content,
      NON_ANTHROPIC_THINKING_PLACEHOLDER,
      "empty reasoning_content should be replaced with placeholder on cache miss"
    );
  });

  it("should inject placeholder for a plain (non-tool-call) DeepSeek turn missing reasoning_content (#1682)", async () => {
    // Regression (#1682): a multi-turn text conversation where the prior assistant
    // turn has NO tool calls and the client (e.g. Cursor) stripped reasoning_content
    // from history. DeepSeek V4+ still requires reasoning_content on every assistant
    // message in thinking mode, so without a placeholder the upstream returns 400.
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-v4-pro": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });

    const { NON_ANTHROPIC_THINKING_PLACEHOLDER } =
      await import("../../open-sse/translator/helpers/claudeHelper.ts");

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-v4-pro",
      {
        messages: [
          { role: "user", content: "hi" },
          // Plain assistant turn, no tool_calls, reasoning_content stripped by client.
          { role: "assistant", content: "Hello! How can I help?" },
          { role: "user", content: "tell me more" },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheApiKeyId: "reasoning-test-key" }
    );

    assert.equal(
      translated.messages[1].reasoning_content,
      NON_ANTHROPIC_THINKING_PLACEHOLDER,
      "plain DeepSeek assistant turn missing reasoning_content should get the placeholder"
    );
  });

  it("should replay cached reasoning for a plain (non-tool-call) DeepSeek turn when available (#1682)", () => {
    // When a request_id-keyed cache entry exists for the plain turn, the real
    // reasoning is replayed instead of the placeholder.
    clearReasoningCacheAll();
    clearModelsDevCapabilities();
    saveModelsDevCapabilities({
      deepseek: {
        "deepseek-v4-pro": buildCapability({
          interleaved_field: "reasoning_content",
          reasoning: true,
          tool_call: true,
        }),
      },
    });
    // NOTE: the non-tool-call cache key is built as `getAssistantMessageCacheKey(result, 0)`
    // — the message index is hardcoded to 0 in the translator, so the key is always
    // `request:<id>:message:0` regardless of the assistant message's actual position.
    cacheReasoning(
      "request:req-plain-1:message:0",
      "deepseek",
      "deepseek-v4-pro",
      "Real cached plain-turn reasoning",
      "reasoning-test-key"
    );

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "deepseek-v4-pro",
      {
        request_id: "req-plain-1",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hello! How can I help?" },
          { role: "user", content: "tell me more" },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheApiKeyId: "reasoning-test-key" }
    );

    assert.equal(
      translated.messages[1].reasoning_content,
      "Real cached plain-turn reasoning",
      "plain DeepSeek assistant turn should replay the real cached reasoning when present"
    );
    assert.equal(getReasoningCacheServiceStats().replays, 1);
  });
});

describe("Reasoning Replay Cache — API Route", () => {
  let managementApiKey: string;

  before(() => {
    clearReasoningCacheAll();
  });

  before(async () => {
    const created = await createApiKey("reasoning-cache-route-test", "machine-reasoning", [
      "manage",
    ]);
    managementApiKey = created.key;
  });

  after(() => {
    clearReasoningCacheAll();
  });

  function authedRequest(url: string): Request {
    return new Request(url, {
      headers: { authorization: `Bearer ${managementApiKey}` },
    });
  }

  it("should return stats and entries from GET", async () => {
    clearReasoningCacheAll();
    cacheReasoning(
      "call_api_get",
      "deepseek",
      "deepseek-reasoner",
      "API visible reasoning",
      "reasoning-test-key"
    );

    const response = await GET(
      authedRequest("http://localhost/api/cache/reasoning?provider=deepseek") as never
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.stats.dbEntries, 1);
    assert.equal(body.entries.length, 1);
    assert.equal(
      body.entries[0].toolCallId,
      buildReasoningCacheKey("call_api_get", "reasoning-test-key", "deepseek")
    );
  });

  it("should delete a single entry by toolCallId", async () => {
    clearReasoningCacheAll();
    cacheReasoning(
      "call_api_delete_1",
      "deepseek",
      "deepseek-reasoner",
      "Delete API",
      "reasoning-test-key"
    );
    cacheReasoning(
      "call_api_delete_2",
      "deepseek",
      "deepseek-reasoner",
      "Keep API",
      "reasoning-test-key"
    );

    const response = await DELETE(
      authedRequest(
        "http://localhost/api/cache/reasoning?toolCallId=" +
          buildReasoningCacheKey("call_api_delete_1", "reasoning-test-key", "deepseek")
      ) as never
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.scope, "toolCallId");
    assert.equal(body.cleared, 1);
    assert.equal(lookupReasoning("call_api_delete_1", "reasoning-test-key", "deepseek"), null);
    assert.equal(
      lookupReasoning("call_api_delete_2", "reasoning-test-key", "deepseek"),
      "Keep API"
    );
  });

  it("should delete entries by provider", async () => {
    clearReasoningCacheAll();
    cacheReasoning(
      "call_api_provider_ds",
      "deepseek",
      "deepseek-reasoner",
      "Delete provider",
      "reasoning-test-key"
    );
    cacheReasoning(
      "call_api_provider_kimi",
      "kimi",
      "kimi-k2.5",
      "Keep provider",
      "reasoning-test-key"
    );

    const response = await DELETE(
      authedRequest("http://localhost/api/cache/reasoning?provider=deepseek") as never
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.scope, "provider");
    assert.equal(body.cleared, 1);
    assert.equal(lookupReasoning("call_api_provider_ds", "reasoning-test-key", "deepseek"), null);
    assert.equal(
      lookupReasoning("call_api_provider_kimi", "reasoning-test-key", "kimi"),
      "Keep provider"
    );
  });
});
