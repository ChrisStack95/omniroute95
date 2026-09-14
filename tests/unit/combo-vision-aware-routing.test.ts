/** Known vision incompatibility is rejected; absent metadata remains unknown. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Deterministic, isolated storage so capability resolution sees NO synced data
// and exercises the registry/spec/heuristic path only.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-vision-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { filterTargetsByRequestCompatibility } = await import("../../open-sse/services/combo.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// --- Part A: capability resolution -----------------------------------------

test("Pixtral resolves supportsVision=true via model-id heuristic (no synced data)", () => {
  assert.equal(getResolvedModelCapabilities("mistral/pixtral-12b-latest").supportsVision, true);
});

test("a text-only Mistral model is NOT a vision false-positive", () => {
  assert.notEqual(
    getResolvedModelCapabilities("mistral/ministral-14b-latest").supportsVision,
    true
  );
});

// --- Part B: combo routing --------------------------------------------------

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

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

const imageBody = {
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" },
        },
      ],
    },
  ],
};

test("image request retains confirmed and unknown vision targets", () => {
  const out = filterTargetsByRequestCompatibility(
    [target("mistral/pixtral-12b-latest"), target("mistral/ministral-14b-latest")],
    imageBody,
    noopLog
  );
  const ids = out.map((t) => t.modelStr);
  assert.ok(ids.includes("mistral/pixtral-12b-latest"), "vision target must be kept");
  const capability = getResolvedModelCapabilities("mistral/ministral-14b-latest").supportsVision;
  assert.equal(ids.includes("mistral/ministral-14b-latest"), capability !== false);
});

test("image request rejects known false even without a confirmed-vision target", () => {
  const out = filterTargetsByRequestCompatibility(
    [target("mistral/ministral-14b-latest"), target("groq/llama-3.1-8b-instant")],
    imageBody,
    noopLog
  );
  assert.deepEqual(
    out.map((t) => t.modelStr),
    ["mistral/ministral-14b-latest", "groq/llama-3.1-8b-instant"].filter(
      (model) => getResolvedModelCapabilities(model).supportsVision !== false
    )
  );
});

test("text-only request: targets are untouched by the vision filter", () => {
  const out = filterTargetsByRequestCompatibility(
    [target("mistral/ministral-14b-latest")],
    { messages: [{ role: "user", content: "hello" }] },
    noopLog
  );
  assert.equal(out.length, 1);
});

test("large output request: unknown maxOutputTokens does not filter a target", () => {
  const out = filterTargetsByRequestCompatibility(
    [target("openai-compatible-local/custom-large-output-model"), target("openai/gpt-4o-mini")],
    { messages: [{ role: "user", content: "hello" }], max_tokens: 32000 },
    noopLog
  );
  const ids = out.map((t) => t.modelStr);

  assert.deepEqual(ids, ["openai-compatible-local/custom-large-output-model"]);
});
