import test from "node:test";
import assert from "node:assert/strict";

process.env.LIVE_STT_TOKEN_SECRET = "test-live-stt-session-secret-0123456789abcdef";
process.env.LIVE_STT_SESSION_TTL_SECONDS = "60";

const { createLiveSttSession, consumeLiveSttSession, resetLiveSttSessionsForTests } =
  await import("../../src/lib/liveStt/session.ts");

test.afterEach(() => resetLiveSttSessionsForTests());

test("live STT session is origin-bound and one-time", async () => {
  const input = {
    apiKeyId: "key-1",
    connectionId: "connection-1",
    origin: "https://router.example.test",
    language: "ru-RU",
    model: "general" as const,
  };
  const session = await createLiveSttSession(input);

  const consumed = await consumeLiveSttSession(session.token, input.origin);
  assert.equal(consumed.connectionId, input.connectionId);
  assert.equal(consumed.apiKeyId, input.apiKeyId);
  assert.equal(consumed.language, input.language);
  assert.equal(consumed.model, input.model);

  await assert.rejects(() => consumeLiveSttSession(session.token, input.origin));
});

test("live STT session rejects an origin mismatch without consuming the token", async () => {
  const session = await createLiveSttSession({
    apiKeyId: null,
    connectionId: "connection-1",
    origin: "https://router.example.test",
    language: "ru-RU",
    model: "callcenter",
  });

  await assert.rejects(() => consumeLiveSttSession(session.token, "https://attacker.example.test"));
  const consumed = await consumeLiveSttSession(session.token, "https://router.example.test");
  assert.equal(consumed.model, "callcenter");
});

test("live STT session does not fall back to the dashboard JWT secret", async () => {
  const liveSttSecret = process.env.LIVE_STT_TOKEN_SECRET;
  process.env.LIVE_STT_TOKEN_SECRET = "";
  process.env.JWT_SECRET = "dashboard-jwt-secret-0123456789abcdef";

  try {
    await assert.rejects(() =>
      createLiveSttSession({
        apiKeyId: null,
        connectionId: "connection-1",
        origin: "https://router.example.test",
        language: "ru-RU",
        model: "general",
      })
    );
  } finally {
    process.env.LIVE_STT_TOKEN_SECRET = liveSttSecret;
  }
});
