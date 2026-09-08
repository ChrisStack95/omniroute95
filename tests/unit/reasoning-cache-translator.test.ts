/** Translator replay scenarios split from reasoning-cache.test.ts. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import "../_setup/isolateDataDir.ts";

const {
  cacheReasoningFromAssistantMessage,
  cacheReasoning,
  getReasoningCacheServiceStats,
  clearReasoningCacheAll,
} = await import("../../open-sse/services/reasoningCache.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { clearModelsDevCapabilities, saveModelsDevCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");

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
