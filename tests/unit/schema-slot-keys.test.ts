import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeClaudeToolSchemas,
  stripInvalidSchemaConstructs,
} from "../../open-sse/translator/helpers/schemaCoercion.ts";

// Schema-valued positions supported by the existing sanitizer.
// A placeholder in any of them has to become the permissive {}: forwarding the
// string is invalid JSON Schema and is the 400 this sanitizer exists to prevent.
const SCHEMA_SLOTS = [
  "items",
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "additionalItems",
  "contentSchema",
  "unevaluatedItems",
];

// Produced by logTruncation.ts once a schema is deeper than the log depth limit.
const PLACEHOLDERS = ["[MaxDepth]", "[Truncated]", "[Circular]", "[Object]", "[Array]"];

function strip(schema: unknown) {
  return stripInvalidSchemaConstructs(schema) as Record<string, unknown>;
}

for (const key of SCHEMA_SLOTS) {
  test(`a placeholder in ${key} becomes a permissive schema`, () => {
    for (const placeholder of PLACEHOLDERS) {
      const out = strip({ type: "object", [key]: placeholder });
      assert.deepEqual(out[key], {}, `${key} kept ${placeholder}`);
    }
  });
}

test("a boolean schema is preserved, not widened", () => {
  // `contentSchema: false` and `unevaluatedItems: false` are valid and
  // restrictive; turning either into {} would invite the model to invent data.
  for (const key of ["contentSchema", "unevaluatedItems"]) {
    assert.equal(strip({ [key]: false })[key], false);
    assert.equal(strip({ [key]: true })[key], true);
  }
});

test("a nested subschema is still walked", () => {
  const out = strip({
    contentSchema: { type: "object", properties: { a: { enum: "[MaxDepth]" } } },
    unevaluatedItems: { items: "[MaxDepth]" },
  });
  const content = out.contentSchema as Record<string, Record<string, unknown>>;
  assert.deepEqual(content.properties.a, {}, "an invalid enum is dropped, leaving {}");
  assert.deepEqual(out.unevaluatedItems, { items: {} });
});

test("a string that is not a placeholder is left alone", () => {
  // Only the placeholder shape is coerced. Anything else stays exactly as it
  // arrived, so a schema this sanitizer does not understand is forwarded rather
  // than rewritten.
  for (const key of ["contentSchema", "unevaluatedItems"]) {
    assert.equal(strip({ [key]: "text/plain" })[key], "text/plain");
  }
});

test("a property named like a slot keyword is not treated as one", () => {
  // Property names live in their own space: a tool whose parameter is called
  // contentSchema must keep its description string.
  const out = strip({
    type: "object",
    properties: { contentSchema: "[MaxDepth]", unevaluatedItems: { type: "string" } },
  });
  const properties = out.properties as Record<string, unknown>;
  assert.deepEqual(
    properties.contentSchema,
    {},
    "a placeholder property value is still a schema slot"
  );
  assert.deepEqual(properties.unevaluatedItems, { type: "string" });
});

test("Claude tool sanitization repairs nested slots without changing annotations or constraints", () => {
  const tools = [
    {
      name: "inspect_payload",
      description: "[MaxDepth]",
      input_schema: {
        type: "object",
        properties: {
          payload: { type: "string", contentSchema: " [Truncated] ", description: "[Object]" },
          values: {
            type: "array",
            prefixItems: [{ type: "integer" }],
            unevaluatedItems: "[Circular]",
          },
          contentSchema: { type: "string", enum: ["[MaxDepth]", "literal"] },
          unevaluatedItems: false,
        },
        required: ["payload", "values"],
        additionalProperties: false,
        $defs: { encoded: { contentSchema: "[Array]", unevaluatedItems: false } },
      },
    },
  ];
  const original = structuredClone(tools);
  const expected = structuredClone(tools) as unknown as Array<{
    input_schema: Record<string, unknown>;
  }>;
  const properties = expected[0].input_schema.properties as Record<string, Record<string, unknown>>;
  properties.payload.contentSchema = {};
  properties.values.unevaluatedItems = {};
  (
    expected[0].input_schema.$defs as Record<string, Record<string, unknown>>
  ).encoded.contentSchema = {};
  assert.deepEqual(sanitizeClaudeToolSchemas(tools), expected);
  assert.deepEqual(tools, original, "the caller's schema must remain intact");
});
