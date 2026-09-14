import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Context estimates order eligible targets without removing runtime fallbacks.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-context-filter-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");
const { filterTargetsByRequestCompatibility } = await import("../../open-sse/services/combo.ts");

test.after(() => {
  core.resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test.beforeEach(() => {
  clearModelsDevCapabilities();
});

function capabilityEntry(limitContext: number | null) {
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
  };
}

function target(modelStr: string) {
  return {
    kind: "model" as const,
    stepId: modelStr,
    executionKey: modelStr,
    modelStr,
    provider: modelStr.includes("/") ? modelStr.split("/")[0] : modelStr,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  };
}

function largeContextBody() {
  return {
    messages: [{ role: "user", content: "x".repeat(80_000) }],
  };
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

test("known compatible context target wins over unknown-context targets", () => {
  saveModelsDevCapabilities({
    "unit-known-context": {
      tiny: capabilityEntry(8_000),
      million: capabilityEntry(1_000_000),
    },
  });

  const out = filterTargetsByRequestCompatibility(
    [
      target("unit-unknown-context/mystery-a"),
      target("unit-known-context/tiny"),
      target("unit-known-context/million"),
      target("unit-unknown-context/mystery-b"),
    ],
    largeContextBody(),
    noopLog
  );

  assert.deepEqual(
    out.map((entry) => entry.modelStr),
    [
      "unit-known-context/million",
      "unit-unknown-context/mystery-a",
      "unit-known-context/tiny",
      "unit-unknown-context/mystery-b",
    ]
  );
});

test("strategy order is preserved when no known context window is too small", () => {
  saveModelsDevCapabilities({
    "unit-known-context": {
      million: capabilityEntry(1_000_000),
    },
  });

  const out = filterTargetsByRequestCompatibility(
    [target("unit-unknown-context/mystery-a"), target("unit-known-context/million")],
    { messages: [{ role: "user", content: "hello" }] },
    noopLog
  );

  assert.deepEqual(
    out.map((entry) => entry.modelStr),
    ["unit-unknown-context/mystery-a", "unit-known-context/million"]
  );
});

test("unknown and known-small targets keep strategy order when none are known to fit", () => {
  saveModelsDevCapabilities({
    "unit-known-context": {
      tiny: capabilityEntry(8_000),
    },
  });

  const out = filterTargetsByRequestCompatibility(
    [
      target("unit-unknown-context/mystery-a"),
      target("unit-known-context/tiny"),
      target("unit-unknown-context/mystery-b"),
    ],
    largeContextBody(),
    noopLog
  );

  assert.deepEqual(
    out.map((entry) => entry.modelStr),
    ["unit-unknown-context/mystery-a", "unit-known-context/tiny", "unit-unknown-context/mystery-b"]
  );
});

test("all known-too-small context targets remain eligible for upstream evaluation", () => {
  saveModelsDevCapabilities({
    "unit-known-context": {
      tiny: capabilityEntry(8_000),
      small: capabilityEntry(16_000),
    },
  });

  const out = filterTargetsByRequestCompatibility(
    [target("unit-known-context/tiny"), target("unit-known-context/small")],
    largeContextBody(),
    noopLog
  );

  assert.deepEqual(
    out.map((entry) => entry.modelStr),
    ["unit-known-context/tiny", "unit-known-context/small"]
  );
});

test("unknown tools and vision metadata survive while explicit false capabilities are rejected", () => {
  saveModelsDevCapabilities({
    "unit-known-context": {
      blind: capabilityEntry(1_000_000),
      noTools: { ...capabilityEntry(1_000_000), tool_call: false, attachment: true },
      capable: { ...capabilityEntry(1_000_000), attachment: true },
    },
  });
  const out = filterTargetsByRequestCompatibility(
    [
      target("unit-known-context/blind"),
      target("unit-known-context/noTools"),
      target("unit-unknown-context/mystery"),
      target("unit-known-context/capable"),
    ],
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
        },
      ],
      tools: [{ type: "function", function: { name: "describe" } }],
    },
    noopLog
  );
  assert.deepEqual(
    out.map((entry) => entry.modelStr),
    ["unit-unknown-context/mystery", "unit-known-context/capable"]
  );
});

for (const scenario of [
  {
    name: "input cap excludes the output reserve",
    input: 256_000,
    output: 32_000,
    inputCap: 272_000,
    window: 400_000,
    fits: true,
  },
  {
    name: "input cap still constrains input inside a larger total window",
    input: 280_000,
    output: 32_000,
    inputCap: 272_000,
    window: 400_000,
    fits: false,
  },
  {
    name: "total window constrains input plus output even when input fits",
    input: 256_000,
    output: 64_000,
    inputCap: 272_000,
    window: 300_000,
    fits: false,
  },
]) {
  test(scenario.name, () => {
    saveModelsDevCapabilities({
      "unit-input-cap": {
        model: {
          ...capabilityEntry(scenario.window),
          limit_input: scenario.inputCap,
          limit_output: 128_000,
        },
        tiny: { ...capabilityEntry(1), limit_output: 128_000 },
      },
    });
    const unknown = target("unit-unknown-context/mystery");
    const known = target("unit-input-cap/model");
    const tiny = target("unit-input-cap/tiny");
    const out = filterTargetsByRequestCompatibility(
      [unknown, known, tiny],
      {
        messages: [{ role: "user", content: "x".repeat(scenario.input * 4) }],
        max_output_tokens: scenario.output,
      },
      noopLog
    );
    assert.deepEqual(out, scenario.fits ? [known, unknown, tiny] : [unknown, known, tiny]);
  });
}

test("context preference never restores hard-rejected targets around a sole small survivor", () => {
  saveModelsDevCapabilities({
    "unit-hard-context": {
      small: capabilityEntry(100),
      noTools: { ...capabilityEntry(1_000_000), tool_call: false },
      noOutput: { ...capabilityEntry(1_000_000), limit_output: 1 },
      noStructured: { ...capabilityEntry(1_000_000), structured_output: false },
    },
  });
  const out = filterTargetsByRequestCompatibility(
    ["noTools", "small", "noOutput", "noStructured"].map((name) =>
      target(`unit-hard-context/${name}`)
    ),
    {
      ...largeContextBody(),
      tools: [{ type: "function", function: { name: "lookup" } }],
      max_output_tokens: 1000,
      response_format: { type: "json_object" },
    },
    noopLog
  );
  assert.deepEqual(
    out.map((entry) => entry.modelStr),
    ["unit-hard-context/small"]
  );
});

test("context overrides replace stale input and total metadata, with exact effort precedence", async () => {
  const { setModelContextOverride, removeModelContextOverride } =
    await import("../../src/lib/db/modelContextOverrides.ts");
  saveModelsDevCapabilities({
    "unit-override": {
      "model-high": capabilityEntry(100),
      model: capabilityEntry(100),
      tiny: capabilityEntry(1),
    },
  });
  const unknown = target("unit-unknown-context/mystery");
  const known = target("unit-override/model-high");
  const tiny = target("unit-override/tiny");
  const filter = () =>
    filterTargetsByRequestCompatibility([unknown, known, tiny], largeContextBody(), noopLog);
  try {
    assert.deepEqual(filter(), [unknown, known, tiny]);
    setModelContextOverride("unit-override", "model", 1_000_000);
    assert.deepEqual(
      filter(),
      [known, unknown, tiny],
      "base override must supersede stale input and total caps"
    );
    setModelContextOverride("unit-override", "model-high", 100);
    assert.deepEqual(
      filter(),
      [unknown, known, tiny],
      "explicit effort override wins but does not reject the target"
    );
  } finally {
    removeModelContextOverride("unit-override", "model");
    removeModelContextOverride("unit-override", "model-high");
  }
});
