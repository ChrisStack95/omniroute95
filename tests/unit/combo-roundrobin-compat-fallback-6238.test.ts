// Known-incompatible targets must not re-enter the fallback pool on an availability failure.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rr-compat-6238-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../open-sse/services/rateLimitSemaphore.ts");

function createLog() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function okResponse(body: unknown = { choices: [{ message: { content: "ok" } }] }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function capabilityEntry(limitContext: unknown, overrides: Record<string, unknown> = {}) {
  return {
    tool_call: true,
    reasoning: false,
    attachment: false,
    structured_output: true,
    temperature: true,
    modalities_input: JSON.stringify(["text"]),
    modalities_output: JSON.stringify(["text"]),
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: false,
    limit_context: limitContext,
    limit_input: limitContext,
    limit_output: 4096,
    interleaved_field: null,
    ...overrides,
  };
}

test.beforeEach(() => {
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllSemaphores();
  clearModelsDevCapabilities();
});

test.after(() => {
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllSemaphores();
  clearModelsDevCapabilities();
  settingsDb.clearAllLKGP();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

test("round-robin returns 503 without dispatching incompatible targets when compatible targets are unavailable", async () => {
  // rr-a is tool-INCAPABLE → the tools-requiring request makes the compat
  // pre-filter reject it. rr-b/rr-c are tool-capable → kept, but both are
  // runtime-unavailable. Only the rejected rr-a is actually healthy.
  saveModelsDevCapabilities({
    openai: {
      "rr-a": capabilityEntry(128000, { tool_call: false }),
      "rr-b": capabilityEntry(128000),
      "rr-c": capabilityEntry(128000),
    },
  });

  const attempted: string[] = [];
  const availabilityChecks: string[] = [];

  const result = await handleComboChat({
    body: {
      messages: [{ role: "user", content: "Use a tool to look something up" }],
      tools: [{ type: "function", function: { name: "lookup_weather" } }],
    },
    combo: {
      name: "rr-compat-fallback-6238",
      strategy: "round-robin",
      models: ["openai/rr-a", "openai/rr-b", "openai/rr-c"],
      config: { maxRetries: 0, concurrencyPerModel: 1, queueTimeoutMs: 1000 },
    },
    handleSingleModel: async (_body, modelStr) => {
      attempted.push(modelStr);
      return okResponse({ choices: [{ message: { content: `served by ${modelStr}` } }] });
    },
    // Only the compat-rejected rr-a is healthy; the compat-kept rr-b/rr-c
    // are all runtime-unavailable.
    isModelAvailable: async (modelStr) => {
      availabilityChecks.push(modelStr);
      return modelStr === "openai/rr-a";
    },
    log: createLog(),
    settings: null,
    relayOptions: null,
    allCombos: null,
  });

  assert.equal(result.status, 503);
  assert.deepEqual(attempted, [], "known-incompatible targets must never be dispatched");
  assert.equal(availabilityChecks.includes("openai/rr-a"), false);
  // Sanity: the compat-kept rr-b/rr-c were probed for availability first.
  assert.ok(
    availabilityChecks.includes("openai/rr-b") || availabilityChecks.includes("openai/rr-c"),
    "compat-kept targets should be probed before the last-resort fallback"
  );
});

for (const strategy of ["priority", "round-robin"]) {
  for (const requirement of ["output", "tools", "vision"]) {
    test(`${strategy} rejects all ${requirement}-incompatible targets with 400 before dispatch`, async () => {
      saveModelsDevCapabilities({
        "unit-compat": {
          small: capabilityEntry(8000, { tool_call: false, attachment: false }),
        },
      });
      const body: Record<string, unknown> = { messages: [{ role: "user", content: "hello" }] };
      if (requirement === "output") body.max_output_tokens = 6000;
      if (requirement === "tools")
        body.tools = [{ type: "function", function: { name: "lookup" } }];
      if (requirement === "vision")
        body.input = [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "https://example.com/image.png" }],
          },
        ];
      let attempts = 0;
      const result = await handleComboChat({
        body,
        combo: {
          name: `all-incompatible-${strategy}-${requirement}`,
          strategy,
          models: ["unit-compat/small"],
          config: { maxRetries: 0 },
        },
        handleSingleModel: async () => {
          attempts++;
          return okResponse();
        },
        log: createLog(),
        settings: {},
        allCombos: [],
      });
      assert.equal(result.status, 400);
      assert.equal((await result.json()).error.code, "no_compatible_target");
      assert.equal(attempts, 0);
    });
  }

  test(`${strategy} keeps tools and native image input intact across same-provider fallback`, async () => {
    saveModelsDevCapabilities({
      "unit-compat": {
        primary: capabilityEntry(128000, { attachment: true }),
        backup: capabilityEntry(128000, { attachment: true }),
        blind: capabilityEntry(128000, { attachment: false }),
      },
    });
    const body = {
      model: "payload-fallback",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe the image using the tool" },
            { type: "input_image", image_url: "https://example.com/image.png", detail: "high" },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "describe",
          parameters: { type: "object", properties: { description: { type: "string" } } },
        },
      ],
      max_output_tokens: 2000,
    };
    const snapshot = structuredClone(body);
    const attempts: string[] = [];
    const result = await handleComboChat({
      body,
      combo: {
        name: `payload-fallback-${strategy}`,
        strategy,
        models: ["unit-compat/blind", "unit-compat/primary", "unit-compat/backup"],
        config: { maxRetries: 0, retryDelayMs: 0 },
      },
      handleSingleModel: async (received, model) => {
        attempts.push(model);
        assert.deepEqual(received.input, snapshot.input);
        assert.deepEqual(received.tools, snapshot.tools);
        assert.equal(received.max_output_tokens, snapshot.max_output_tokens);
        return model.endsWith("primary")
          ? Response.json(
              { error: { code: "empty_response", message: "Empty output" } },
              { status: 502 }
            )
          : okResponse();
      },
      log: createLog(),
      settings: {},
      allCombos: [],
    });
    assert.equal(result.status, 200);
    assert.deepEqual(attempts, ["unit-compat/primary", "unit-compat/backup"]);
    assert.deepEqual(body, snapshot);
  });
}

test("nested execute mode rejects incompatible direct and child targets before provider dispatch", async () => {
  saveModelsDevCapabilities({
    "unit-compat": { noTools: capabilityEntry(128000, { tool_call: false }) },
  });
  const child = {
    name: "incompatible-child",
    strategy: "priority",
    models: ["unit-compat/noTools"],
  };
  const outer = {
    name: "incompatible-parent",
    strategy: "priority",
    models: ["unit-compat/noTools", { kind: "combo-ref", comboName: child.name }],
    config: { nestedComboMode: "execute", maxRetries: 0 },
  };
  let attempts = 0;
  const result = await handleComboChat({
    body: { tools: [{ type: "function", function: { name: "lookup" } }] },
    combo: outer,
    allCombos: [outer, child],
    settings: {},
    log: createLog(),
    handleSingleModel: async () => {
      attempts++;
      return okResponse();
    },
  });
  assert.equal(result.status, 400);
  assert.equal(attempts, 0);
});

test("pipeline dispatches a large intermediate result despite the next model catalog window", async () => {
  saveModelsDevCapabilities({
    "unit-compat": {
      primary: capabilityEntry(128000, { tool_call: false }),
      small: capabilityEntry(8000),
    },
  });
  const attempts: string[] = [];
  const result = await handleComboChat({
    body: {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
    },
    combo: {
      name: "pipeline-compat",
      strategy: "pipeline",
      models: ["unit-compat/primary", "unit-compat/small"],
    },
    allCombos: [],
    settings: {},
    log: createLog(),
    handleSingleModel: async (body, model) => {
      attempts.push(model);
      if (model === "unit-compat/primary") {
        assert.equal(
          body.tools,
          undefined,
          "intermediate pipeline step intentionally strips tools"
        );
        return okResponse({ choices: [{ message: { content: "x".repeat(80000) } }] });
      }
      assert.ok(JSON.stringify(body.messages).includes("x".repeat(80000)));
      assert.ok(body.tools, "final step retains tool requirements");
      return okResponse();
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(attempts, ["unit-compat/primary", "unit-compat/small"]);
});

test("a context-cache pin cannot bypass compatibility after the request gains tools", async () => {
  const { recordSessionModelUsage, clearSessionModelHistoryForCombo } =
    await import("../../src/lib/db/contextHandoffs.ts");
  saveModelsDevCapabilities({
    "unit-compat": {
      noTools: capabilityEntry(128000, { tool_call: false }),
      capable: capabilityEntry(128000),
    },
  });
  const combo = {
    name: "incompatible-pin",
    strategy: "priority",
    context_cache_protection: true,
    models: ["unit-compat/noTools", "unit-compat/capable"],
    config: { maxRetries: 0 },
  };
  recordSessionModelUsage("compat-session", combo.name, "unit-compat/noTools", "unit-compat");
  const connection = await providersDb.createProviderConnection({
    provider: "unit-compat",
    name: "pin regression",
    authType: "apikey",
    apiKey: "test-only-key",
    isActive: true,
    testStatus: "active",
  });
  const attempts: string[] = [];
  try {
    const result = await handleComboChat({
      body: { tools: [{ type: "function", function: { name: "lookup" } }] },
      combo,
      allCombos: [combo],
      relayOptions: { sessionId: "compat-session" },
      settings: {},
      log: createLog(),
      handleSingleModel: async (_body, model) => {
        attempts.push(model);
        return okResponse();
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(attempts, ["unit-compat/capable"]);
  } finally {
    clearSessionModelHistoryForCombo(combo.name);
    await providersDb.deleteProviderConnection(connection.id);
  }
});

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} dispatches despite stale context metadata and falls back without changing input`, async () => {
    saveModelsDevCapabilities({
      "unit-advisory": { primary: capabilityEntry(100), backup: capabilityEntry(100) },
    });
    const body = { messages: [{ role: "user", content: "x".repeat(80_000) }] };
    const attempts: string[] = [];
    const result = await handleComboChat({
      body,
      combo: {
        name: `advisory-${strategy}`,
        strategy,
        models: ["unit-advisory/primary", "unit-advisory/backup"],
        config: { maxRetries: 0 },
      },
      settings: {},
      allCombos: [],
      log: createLog(),
      handleSingleModel: async (attemptBody, model) => {
        assert.deepEqual(attemptBody.messages, body.messages);
        attempts.push(model);
        if (attempts.length === 1)
          return new Response(
            JSON.stringify({
              error: { code: "context_length_exceeded", message: "context length exceeded" },
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        return okResponse();
      },
    });
    assert.equal(result.status, 200);
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts).size, 2);
  });
}

test("a context-cache pin survives an approximate context mismatch", async () => {
  const { recordSessionModelUsage, clearSessionModelHistoryForCombo } =
    await import("../../src/lib/db/contextHandoffs.ts");
  saveModelsDevCapabilities({
    "unit-advisory": { small: capabilityEntry(100), large: capabilityEntry(1_000_000) },
  });
  const combo = {
    name: "advisory-pin",
    strategy: "priority",
    context_cache_protection: true,
    models: ["unit-advisory/large", "unit-advisory/small"],
    config: { maxRetries: 0 },
  };
  recordSessionModelUsage("advisory-session", combo.name, "unit-advisory/small", "unit-advisory");
  const connection = await providersDb.createProviderConnection({
    provider: "unit-advisory",
    name: "pin regression",
    authType: "apikey",
    apiKey: "test-only-key",
    isActive: true,
    testStatus: "active",
  });
  const attempts: string[] = [];
  try {
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "x".repeat(80_000) }] },
      combo,
      allCombos: [combo],
      relayOptions: { sessionId: "advisory-session" },
      settings: {},
      log: createLog(),
      handleSingleModel: async (_body, model) => {
        attempts.push(model);
        return okResponse();
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(attempts, ["unit-advisory/small"]);
  } finally {
    clearSessionModelHistoryForCombo(combo.name);
    await providersDb.deleteProviderConnection(connection.id);
  }
});
