import test from "node:test";
import assert from "node:assert/strict";

const { checkFallbackError } = await import("../../open-sse/services/accountFallback.ts");
const { resolveTerminalConnectionStatus } =
  await import("../../src/sse/services/authTerminalStatus.ts");
const { classifyProviderError, PROVIDER_ERROR_TYPES } =
  await import("../../open-sse/services/errorClassifier.ts");

test("bare Mistral 401 is not asserted as a permanent auth failure", () => {
  const r = checkFallbackError(
    401,
    '{"detail":"Unauthorized"}',
    0,
    null,
    "mistral",
    null,
    null,
    null
  );
  assert.notEqual(r.reason, "auth_error");
  assert.ok(!r.permanent);
  assert.equal(r.shouldFallback, true);
  assert.ok(r.cooldownMs > 0);
});

test("Mistral 401 with explicit auth signals stays auth_error", () => {
  for (const body of ["Invalid API key", "token invalid", "revoked", "access denied"]) {
    const r = checkFallbackError(401, body, 0, null, "mistral", null, null, null);
    assert.equal(r.reason, "auth_error", body);
  }
});

test("operator 401 rule keeps winning over the ambiguous-401 bypass", async () => {
  const { setOperatorProviderErrorRules } =
    await import("../../open-sse/config/providerErrorRules.ts");
  setOperatorProviderErrorRules({
    mistral: [{ status: 401, match: "unauthorized", scope: "connection", cooldownMs: 99999 }],
  });
  try {
    const r = checkFallbackError(
      401,
      '{"detail":"Unauthorized"}',
      0,
      null,
      "mistral",
      null,
      null,
      null
    );
    assert.equal(r.reason, "quota_exhausted");
    assert.equal(r.cooldownMs, 99999);
  } finally {
    setOperatorProviderErrorRules({});
  }
});

test("non-Mistral bare 401 stays auth_error", () => {
  const r = checkFallbackError(
    401,
    '{"detail":"Unauthorized"}',
    0,
    null,
    "openai",
    null,
    null,
    null
  );
  assert.equal(r.reason, "auth_error");
});

test("bare Mistral 401 does not resolve a terminal expired status", () => {
  const r = checkFallbackError(
    401,
    '{"detail":"Unauthorized"}',
    0,
    null,
    "mistral",
    null,
    null,
    null
  );
  const type = classifyProviderError(401, '{"detail":"Unauthorized"}', "mistral");
  const terminal = resolveTerminalConnectionStatus(
    401,
    r,
    type,
    "mistral",
    false,
    '{"detail":"Unauthorized"}'
  );
  assert.equal(terminal, null);
});

test("Mistral 401 with explicit auth signal still resolves expired", () => {
  const r = checkFallbackError(401, "Invalid API key", 0, null, "mistral", null, null, null);
  assert.equal(r.reason, "auth_error");
  assert.equal(
    classifyProviderError(401, "Invalid API key", "mistral"),
    PROVIDER_ERROR_TYPES.UNAUTHORIZED
  );
  const terminal = resolveTerminalConnectionStatus(
    401,
    r,
    PROVIDER_ERROR_TYPES.UNAUTHORIZED,
    "mistral",
    false,
    "Invalid API key"
  );
  assert.equal(terminal, "expired");
});
