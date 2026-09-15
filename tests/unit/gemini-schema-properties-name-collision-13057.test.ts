import test from 'node:test';
import assert from 'node:assert/strict';

const { cleanJSONSchemaForAntigravity } = await import(
  '../../open-sse/translator/helpers/geminiHelper.ts'
);

test('#13057 should not inject type: "object" into properties map when a property is named "properties"', () => {
  const inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string' },
      properties: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['action']
  };

  const cleaned = cleanJSONSchemaForAntigravity(inputSchema) as Record<string, any>;

  assert.equal(cleaned.type, 'object');
  assert.ok(cleaned.properties);
  assert.ok(cleaned.properties.action);
  assert.ok(cleaned.properties.properties);
  // The properties map itself must NOT have a "type" property injected
  assert.equal(cleaned.properties.type, undefined);
  assert.equal(cleaned.properties.properties.type, 'array');
});

test('#13477 should not inject type: "object" into properties map when a property is named "required" (delivery.pin case)', () => {
  const inputSchema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      notify: { type: 'boolean' },
      required: { type: 'boolean' }
    },
    required: ['enabled']
  };

  const cleaned = cleanJSONSchemaForAntigravity(inputSchema) as Record<string, any>;

  assert.equal(cleaned.type, 'object');
  assert.ok(cleaned.properties);
  assert.ok(cleaned.properties.enabled);
  assert.ok(cleaned.properties.notify);
  assert.ok(cleaned.properties.required);
  // The properties map itself must NOT have a "type" property injected
  assert.equal(cleaned.properties.type, undefined);
  assert.equal(cleaned.properties.required.type, 'boolean');
});
