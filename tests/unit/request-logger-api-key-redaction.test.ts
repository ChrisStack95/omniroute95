import test from "node:test";
import assert from "node:assert/strict";

import { createRequestLogger } from "../../open-sse/utils/requestLogger.ts";
import { protectPayloadForLog } from "../../src/lib/logPayloads.ts";

const GEMINI_KEY = "test-gemini-api-key-value-00000";
const AZURE_KEY = "test-azure-api-key-value-00000";
const ELEVENLABS_KEY = "test-elevenlabs-api-key-value-00000";

test("request logger masks every api-key header variant", async () => {
  const logger = await createRequestLogger("openai", "gemini", "gemini-2.5-flash");
  logger.logTargetRequest(
    "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
    {
      "x-goog-api-key": GEMINI_KEY,
      "api-key": AZURE_KEY,
      "xi-api-key": ELEVENLABS_KEY,
      "x-ratelimit-remaining": "99",
    },
    { contents: [] }
  );

  const headers = logger.getPipelinePayloads()?.providerRequest?.headers ?? {};
  const dumped = JSON.stringify(headers);
  assert.equal(dumped.includes(GEMINI_KEY), false);
  assert.equal(dumped.includes(AZURE_KEY), false);
  assert.equal(dumped.includes(ELEVENLABS_KEY), false);
  assert.equal(headers["x-ratelimit-remaining"], "99");
});

test("persisted payload redaction masks api-key header variants", () => {
  const payload = protectPayloadForLog({
    headers: {
      "x-goog-api-key": GEMINI_KEY,
      "api-key": AZURE_KEY,
      "xi-api-key": ELEVENLABS_KEY,
      "Content-Type": "application/json",
    },
  }) as { headers: Record<string, unknown> };

  assert.equal(payload.headers["x-goog-api-key"], "[REDACTED]");
  assert.equal(payload.headers["api-key"], "[REDACTED]");
  assert.equal(payload.headers["xi-api-key"], "[REDACTED]");
  assert.equal(payload.headers["Content-Type"], "application/json");
});
