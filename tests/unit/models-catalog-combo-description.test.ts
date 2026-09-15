/**
 * Combos advertise their own description in `GET /v1/models`.
 *
 * A combo's description is stored in its record and returned by
 * `GET /api/combos`, but the catalog row built in
 * `src/app/api/v1/models/catalog.ts` never copied it, so no client could see it.
 *
 * Claude Code's gateway model discovery reads exactly `id`, `display_name` and
 * `description` from each entry in the `/v1/models` `data` array and renders the
 * description in the `/model` picker; an entry without one reads "From gateway"
 * instead. Other OpenAI-compatible clients surface it too. See
 * https://code.claude.com/docs/en/llm-gateway-protocol.md#model-discovery
 *
 * Rules:
 *   R1 The combo row emits `description` when the combo has one.
 *   R2 It is omitted entirely when the combo has none, rather than sent empty.
 *   R3 The value is read defensively — a non-string description cannot leak through.
 *   R4 `comboMetadata` still spreads last, so it keeps precedence over the literal.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// catalog.ts contains a NUL byte, so read it explicitly as UTF-8 text rather
// than relying on tools that sniff it as binary.
const catalog = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/v1/models/catalog.ts"),
  "utf8"
);

test("R1/R2: the combo row emits description only when the combo has one", () => {
  assert.ok(
    catalog.includes("...(comboDescription ? { description: comboDescription } : {})"),
    "the combo row must spread description conditionally, so a combo without one is unchanged"
  );
});

test("R3: the description is narrowed to a trimmed string before use", () => {
  assert.match(
    catalog,
    /const comboDescription\s*=\s*\n?\s*typeof combo\.description === "string" \? combo\.description\.trim\(\) : "";/,
    "ComboRecord is Record<string, unknown>, so the value must be typeof-narrowed and trimmed — " +
      "a non-string must collapse to the empty string and be omitted"
  );
});

test("R4: comboMetadata still spreads after the literal fields", () => {
  const rowStart = catalog.indexOf("listedIds.add(combo.name);");
  assert.ok(rowStart > -1, "combo row builder must exist");
  const row = catalog.slice(rowStart, rowStart + 900);
  const descIndex = row.indexOf("description: comboDescription");
  const metaIndex = row.indexOf("...comboMetadata");
  assert.ok(descIndex > -1 && metaIndex > -1, "both spreads must be present in the row");
  assert.ok(
    metaIndex > descIndex,
    "comboMetadata must spread last so context/capability metadata keeps precedence"
  );
});
