import assert from "node:assert/strict";
import test from "node:test";

import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/helpers/geminiHelper.ts";
import { buildGeminiTools } from "../../open-sse/translator/helpers/geminiToolsSanitizer.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

const keywordNames = [
  "const",
  "additionalProperties",
  "properties",
  "type",
  "enum",
  "required",
  "items",
  "allOf",
  "anyOf",
  "oneOf",
  "pattern",
  "minLength",
];

function keywordSchema(names = keywordNames) {
  return {
    type: "object",
    properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
    required: [...names],
  };
}

// #13059: v3.8.48 lacks the newer type-injection phase, but the existing const
// and additionalProperties passes already corrupt keyword-named tool arguments.
for (const name of ["const", "additionalProperties"]) {
  test(`preserves a required tool argument named ${name}`, () => {
    const schema = keywordSchema([name]);
    assert.deepEqual(cleanJSONSchemaForAntigravity(schema), schema);
  });
}

test("preserves all keyword-named arguments and does not mutate the caller's schema", () => {
  const schema = keywordSchema();
  const original = structuredClone(schema);
  assert.deepEqual(cleanJSONSchemaForAntigravity(schema), original);
  assert.deepEqual(schema, original);
});

test("preserves keyword-named arguments inside object and array schemas", () => {
  const schema = {
    type: "object",
    properties: {
      nested: keywordSchema(),
      rows: { type: "array", items: keywordSchema() },
    },
    required: ["nested", "rows"],
  };
  assert.deepEqual(cleanJSONSchemaForAntigravity(schema), schema);
});

test("still normalizes actual constraints within keyword-named arguments", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      const: { const: "fixed" },
      enum: { type: "integer", enum: [1, 2] },
      additionalProperties: {
        type: "object",
        properties: { const: { type: ["string", "null"], minLength: 2 } },
        additionalProperties: true,
        required: ["const", "absent"],
      },
    },
    required: ["const", "enum", "additionalProperties", "absent"],
  };
  assert.deepEqual(cleanJSONSchemaForAntigravity(schema), {
    type: "object",
    properties: {
      const: { type: "string", enum: ["fixed"] },
      // The frozen cleaner drops numeric enum constraints, retaining the numeric type.
      enum: { type: "integer" },
      additionalProperties: {
        type: "object",
        properties: { const: { type: "string" } },
        required: ["const"],
      },
    },
    required: ["const", "enum", "additionalProperties"],
  });
});

test("retains keyword arguments after composition flattening and local ref expansion", () => {
  const schema = {
    type: "object",
    $defs: { entry: keywordSchema() },
    properties: {
      composed: {
        type: "object",
        allOf: [keywordSchema(["const"]), keywordSchema(["additionalProperties"])],
      },
      choice: { anyOf: [{ type: "null" }, keywordSchema()] },
      exclusive: { oneOf: [keywordSchema()] },
      referenced: { $ref: "#/$defs/entry" },
    },
  };
  assert.deepEqual(cleanJSONSchemaForAntigravity(schema), {
    type: "object",
    properties: {
      composed: keywordSchema(["const", "additionalProperties"]),
      choice: keywordSchema(),
      exclusive: keywordSchema(),
      referenced: keywordSchema(),
    },
  });
});

test("still inserts required placeholders into truly empty object schemas", () => {
  const result = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { additionalProperties: { type: "object", properties: {} } },
  });
  assert.deepEqual(result, {
    type: "object",
    properties: {
      additionalProperties: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Brief explanation of why you are calling this tool",
          },
        },
        required: ["reason"],
      },
    },
  });
});

test("buildGeminiTools preserves required argument names in functionDeclarations", () => {
  const schema = keywordSchema();
  const tools = [{ type: "function", function: { name: "inspect", parameters: schema } }];
  assert.deepEqual(buildGeminiTools(tools)?.[0]?.functionDeclarations?.[0]?.parameters, schema);
});

for (const stream of [false, true]) {
  test(`OpenAI request translation preserves tool and response schemas (stream=${stream})`, () => {
    const schema = keywordSchema();
    const result = openaiToGeminiRequest(
      "gemini-2.5-pro",
      {
        messages: [{ role: "user", content: "Inspect this object" }],
        tools: [{ type: "function", function: { name: "inspect", parameters: schema } }],
        response_format: { type: "json_schema", json_schema: { name: "result", schema } },
      },
      stream
    );
    assert.deepEqual(result.tools?.[0]?.functionDeclarations?.[0]?.parameters, schema);
    assert.deepEqual(result.generationConfig?.responseSchema, schema);
  });

  test(`Anthropic request translation preserves tool input schemas (stream=${stream})`, () => {
    const schema = keywordSchema();
    const result = claudeToGeminiRequest(
      "gemini-2.5-pro",
      {
        messages: [{ role: "user", content: "Inspect this object" }],
        tools: [{ name: "inspect", description: "Inspect fields", input_schema: schema }],
      },
      stream
    );
    assert.deepEqual(result.tools?.[0]?.functionDeclarations?.[0]?.parameters, schema);
  });
}
