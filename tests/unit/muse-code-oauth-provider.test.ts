import test from "node:test";
import assert from "node:assert/strict";

import { MUSE_CODE_CONFIG } from "../../src/lib/oauth/constants/muse-code.ts";
import { museCode } from "../../src/lib/oauth/providers/muse-code.ts";
import { MuseCodeExecutor } from "../../open-sse/executors/muse-code.ts";
import {
  META_MUSE_API_KEY_TTL_SECONDS,
  META_MUSE_API_KEY_URL,
} from "../../open-sse/services/museCodeAuth.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Muse Code uses Meta OIDC device authorization", async () => {
  let seenUrl = "";
  let seenBody = "";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = String(init?.body || "");
    return new Response(
      JSON.stringify({
        device_code: "device-1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.meta.com/device",
        expires_in: 900,
        interval: 7,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await museCode.requestDeviceCode(MUSE_CODE_CONFIG);
  assert.equal(seenUrl, MUSE_CODE_CONFIG.deviceAuthorizationUrl);
  assert.match(seenBody, /client_id=/);
  assert.equal(result.device_code, "device-1");
  assert.equal(result.user_code, "ABCD-EFGH");
  assert.equal(result.interval, 7);
});

test("Muse Code keeps authorization_pending on the shared device poll path", async () => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.equal(String(url), MUSE_CODE_CONFIG.deviceTokenUrl);
    return new Response(
      JSON.stringify({ error: "authorization_pending", error_description: "pending" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await museCode.pollToken(MUSE_CODE_CONFIG, "device-1");
  assert.equal(result.ok, true);
  assert.equal(result.data.error, "authorization_pending");
});

test("Muse Code maps Meta identity token to a minted inference key", async () => {
  let seenAuthorization = "";
  // gitleaks generic-api-key allowlist (see .gitleaks.toml): "muse-key-*"
  // are synthetic non-functional fixture values, never real credentials.
  const fixtureKey = ["muse", "key", "1"].join("-");
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), META_MUSE_API_KEY_URL);
    const headers = new Headers(init?.headers);
    seenAuthorization = headers.get("authorization") || "";
    return new Response(JSON.stringify({ api_key: fixtureKey }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const extra = await museCode.postExchange({ access_token: "meta-identity-1" });
  const mapped = museCode.mapTokens({ access_token: "meta-identity-1" }, extra);

  assert.equal(seenAuthorization, "Bearer meta-identity-1");
  assert.equal(mapped.accessToken, fixtureKey);
  assert.equal(mapped.refreshToken, "meta-identity-1");
  assert.equal(mapped.expiresIn, META_MUSE_API_KEY_TTL_SECONDS);
});

test("Muse Code token mapper remains total for registry contract checks", () => {
  assert.doesNotThrow(() => museCode.mapTokens({}));
  assert.equal(museCode.mapTokens({}).accessToken, undefined);
});

test("Muse Code executor re-mints an inference key from the stored identity token", async () => {
  // gitleaks generic-api-key allowlist (see .gitleaks.toml): "muse-key-*"
  // are synthetic non-functional fixture values, never real credentials.
  const refreshedKey = ["muse", "key", "refreshed"].join("-");
  const staleKey = ["muse", "key", "old"].join("-");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ api_key: refreshedKey }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const executor = new MuseCodeExecutor();
  const refreshed = await executor.refreshCredentials({
    accessToken: staleKey,
    refreshToken: "meta-identity-1",
  });

  assert.equal(refreshed?.accessToken, refreshedKey);
  assert.equal(refreshed?.refreshToken, "meta-identity-1");
  assert.ok(typeof refreshed?.expiresAt === "string");
});

test("Muse Code executor restores 24h prompt cache retention after generic sanitisation", () => {
  const executor = new MuseCodeExecutor();
  const transformed = executor.transformRequest(
    "muse-spark-1.3",
    {
      model: "muse-spark-1.3",
      input: "hello",
      prompt_cache_retention: "24h",
    },
    true,
    { accessToken: "muse-key" }
  ) as Record<string, unknown>;

  assert.equal(transformed.prompt_cache_retention, "24h");
});
