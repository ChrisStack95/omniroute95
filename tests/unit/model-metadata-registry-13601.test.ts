import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichCatalogModelEntry } from "../../src/lib/modelMetadataRegistry.ts";

function entry() {
  return { id: "openai/gpt-4o", owned_by: "openai", root: "gpt-4o" };
}

function snapshotWithOrder(modelKeysInOrder: Array<[string, { input: number; output: number }]>) {
  const models: Record<string, { input: number; output: number }> = {};
  for (const [k, v] of modelKeysInOrder) models[k] = v;
  return { modelsDevPricing: { OpenAI: models } };
}

function enrichWithWarnCapture(snapshot: { modelsDevPricing: Record<string, unknown> }) {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    const enriched = enrichCatalogModelEntry(entry(), undefined, snapshot as never);
    return { enriched, warns };
  } finally {
    console.warn = original;
  }
}

describe("registry collision determinism (#13601 D1)", () => {
  it("resolves identical pricing regardless of colliding-key insertion order", () => {
    const first = enrichWithWarnCapture(
      snapshotWithOrder([
        ["Gpt-4o", { input: 1, output: 1 }],
        ["GPT-4O", { input: 99, output: 99 }],
      ])
    );
    const second = enrichWithWarnCapture(
      snapshotWithOrder([
        ["GPT-4O", { input: 99, output: 99 }],
        ["Gpt-4o", { input: 1, output: 1 }],
      ])
    );
    assert.ok(first.enriched.pricing, "pricing should resolve under first order");
    assert.ok(second.enriched.pricing, "pricing should resolve under second order");
    assert.deepEqual(
      second.enriched.pricing,
      first.enriched.pricing,
      "colliding keys must resolve order-independently"
    );
  });

  it("warn names both colliding keys and which was kept/discarded", () => {
    const { warns } = enrichWithWarnCapture(
      snapshotWithOrder([
        ["Gpt-4o", { input: 1, output: 1 }],
        ["GPT-4O", { input: 99, output: 99 }],
      ])
    );
    const collisionWarns = warns.filter((w) => w.includes("gpt-4o"));
    assert.ok(collisionWarns.length >= 1, `expected a collision warn, got: ${warns.join(" | ")}`);
    const text = collisionWarns.join("\n");
    assert.ok(text.includes("Gpt-4o"), "warn must name the first key");
    assert.ok(text.includes("GPT-4O"), "warn must name the second key");
    assert.ok(/kept|keeping/i.test(text), "warn must say which key was kept");
    assert.ok(/discard/i.test(text), "warn must say which key was discarded");
  });

  it("keeps the UTF-16-smallest key across 3 colliding keys regardless of order", () => {
    // "GPT-4O" < "Gpt-4o" < "gPT-4o" in UTF-16 ("P" 80 < "p" 112, "G" 71 < "g" 103").
    const orders: Array<Array<[string, { input: number; output: number }]>> = [
      [
        ["Gpt-4o", { input: 1, output: 1 }],
        ["GPT-4O", { input: 99, output: 99 }],
        ["gPT-4o", { input: 50, output: 50 }],
      ],
      [
        ["gPT-4o", { input: 50, output: 50 }],
        ["Gpt-4o", { input: 1, output: 1 }],
        ["GPT-4O", { input: 99, output: 99 }],
      ],
    ];
    const results = orders.map((o) => enrichWithWarnCapture(snapshotWithOrder(o)).enriched);
    for (const r of results) assert.ok(r.pricing, "pricing should resolve with 3 colliding keys");
    assert.deepEqual(results[1].pricing, results[0].pricing, "3-key collision must be order-free");
    assert.equal(
      (results[0].pricing as { input: number }).input,
      99,
      "UTF-16-smallest key GPT-4O must win"
    );
  });
});
