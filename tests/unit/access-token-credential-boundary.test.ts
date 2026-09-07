import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-credential-boundary-"));
process.env.DATA_DIR = dataDir;
process.env.INITIAL_PASSWORD = "fixture-password";
process.env.JWT_SECRET = "fixture-session-secret";
process.env.API_KEY_SECRET = "fixture-api-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.ALLOW_API_KEY_REVEAL = "true";

const core = await import("../../src/lib/db/core.ts");
const accessTokens = await import("../../src/lib/db/accessTokens.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const settings = await import("../../src/lib/db/settings.ts");
const keysRoute = await import("../../src/app/api/keys/route.ts");
const keyRoute = await import("../../src/app/api/keys/[id]/route.ts");
const revealRoute = await import("../../src/app/api/keys/[id]/reveal/route.ts");
const cliKeysRoute = await import("../../src/app/api/cli-tools/keys/route.ts");
const { managementPolicy } = await import("../../src/server/authz/policies/management.ts");
const { classifyRoute } = await import("../../src/server/authz/classify.ts");

await settings.updateSettings({ requireLogin: true, cloudEnabled: false });
const writeToken = accessTokens.createAccessToken({ name: "write", scope: "write" }).secret;
const readToken = accessTokens.createAccessToken({ name: "read", scope: "read" }).secret;
const adminToken = accessTokens.createAccessToken({ name: "admin", scope: "admin" }).secret;
const existing = await apiKeys.createApiKey("existing", "fixture-machine", ["self:usage"]);
const session = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" })
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));

function request(method: string, pathname: string, credential: string, body?: unknown) {
  return new Request(`https://audit.invalid${pathname}`, {
    method,
    headers: {
      ...(credential === "session"
        ? { cookie: `auth_token=${session}` }
        : { authorization: `Bearer ${credential}` }),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const credential of [readToken, writeToken]) {
  const scope = credential === readToken ? "read" : "write";
  test(`${scope} cannot create or promote a management credential`, async () => {
    const before = (await apiKeys.getApiKeys()).length;
    const req = request("POST", "/api/keys", credential, { name: "escalated", scopes: ["manage"] });
    const policy = await managementPolicy.evaluate({
      request: req,
      classification: classifyRoute("/api/keys", "POST"),
      requestId: "fixture",
    });
    assert.equal(policy.allow, false);
    assert.equal((await keysRoute.POST(req)).status, 403);
    assert.equal((await apiKeys.getApiKeys()).length, before);
    const patch = await keyRoute.PATCH(
      request("PATCH", `/api/keys/${existing.id}`, credential, { scopes: ["admin"] }),
      { params: Promise.resolve({ id: existing.id }) }
    );
    assert.equal(patch.status, 403);
    assert.deepEqual((await apiKeys.getApiKeyById(existing.id))?.scopes, ["self:usage"]);
  });

  test(`${scope} cannot reveal credentials through either handler`, async () => {
    assert.equal(
      (await cliKeysRoute.GET(request("GET", "/api/cli-tools/keys", credential))).status,
      403
    );
    assert.equal(
      (
        await revealRoute.GET(request("GET", `/api/keys/${existing.id}/reveal`, credential), {
          params: Promise.resolve({ id: existing.id }),
        })
      ).status,
      403
    );
    // Ordinary masked key inventory remains inspectable.
    const inventory = await keysRoute.GET(request("GET", "/api/keys", credential));
    assert.equal(inventory.status, 200);
    assert.equal(
      (await inventory.json()).keys.some((key: { key: string }) => key.key === existing.key),
      false
    );
  });
}

for (const credential of [adminToken, "session"]) {
  test(`${credential === "session" ? "dashboard" : "admin"} retains credential management`, async () => {
    const created = await keysRoute.POST(
      request("POST", "/api/keys", credential, { name: "authorized", scopes: ["manage"] })
    );
    assert.equal(created.status, 201);
    const key = await created.json();
    const patch = await keyRoute.PATCH(
      request("PATCH", `/api/keys/${key.id}`, credential, { scopes: ["admin"] }),
      { params: Promise.resolve({ id: key.id }) }
    );
    assert.equal(patch.status, 200);
    const reveal = await revealRoute.GET(request("GET", `/api/keys/${key.id}/reveal`, credential), {
      params: Promise.resolve({ id: key.id }),
    });
    assert.equal(reveal.status, 200);
    assert.equal((await reveal.json()).key, key.key);
    const raw = await cliKeysRoute.GET(request("GET", "/api/cli-tools/keys", credential));
    assert.equal(raw.status, 200);
    assert.equal(
      (await raw.json()).keys.some((item: { rawKey: string }) => item.rawKey === key.key),
      true
    );
  });
}

test("basePath deployments cannot downgrade credential routes to default scopes", async () => {
  const original = process.env.OMNIROUTE_BASE_PATH;
  process.env.OMNIROUTE_BASE_PATH = "/omni";
  try {
    assert.equal(
      (
        await keysRoute.POST(
          request("POST", "/omni/api/keys", writeToken, {
            name: "basepath-escalation",
            scopes: ["manage"],
          })
        )
      ).status,
      403
    );
    assert.equal(
      (await cliKeysRoute.GET(request("GET", "/omni/api/cli-tools/keys", readToken))).status,
      403
    );
    assert.equal(
      (
        await revealRoute.GET(request("GET", `/omni/api/keys/${existing.id}/reveal`, readToken), {
          params: Promise.resolve({ id: existing.id }),
        })
      ).status,
      403
    );
  } finally {
    if (original === undefined) delete process.env.OMNIROUTE_BASE_PATH;
    else process.env.OMNIROUTE_BASE_PATH = original;
  }
});

test("provider list and detail mask secrets for restricted tokens despite reveal enabled", async () => {
  const providers = await import("../../src/lib/db/providers.ts");
  const providerRoute = await import("../../src/app/api/providers/route.ts");
  const detailRoute = await import("../../src/app/api/providers/[id]/route.ts");
  const secret = "fixture-provider-key-secret-value";
  const connection = await providers.createProviderConnection({
    provider: "openai",
    name: "fixture",
    authType: "apikey",
    apiKey: secret,
  });
  for (const credential of [readToken, writeToken, adminToken, "session"]) {
    const list = await providerRoute.GET(request("GET", "/api/providers", credential));
    assert.equal(list.status, 200);
    const listed = (await list.json()).connections.find(
      (row: { id: string }) => row.id === connection.id
    );
    const detail = await detailRoute.GET(
      request("GET", `/api/providers/${connection.id}`, credential),
      {
        params: Promise.resolve({ id: connection.id }),
      }
    );
    assert.equal(detail.status, 200);
    const detailed = await detail.json();
    const expected =
      credential === adminToken || credential === "session" ? secret : "fixture-****alue";
    assert.equal(listed.apiKey, expected);
    assert.equal(detailed.connection.apiKey, expected);
  }
});

test("restricted CLI config handlers reject before reading local credentials", async () => {
  const codex = await import("../../src/app/api/cli-tools/codex-settings/route.ts");
  for (const credential of [readToken, writeToken]) {
    assert.equal(
      (await codex.GET(request("GET", "/api/cli-tools/codex-settings", credential))).status,
      403
    );
  }
});

test("write token cannot mint a sync credential", async () => {
  const sync = await import("../../src/app/api/sync/tokens/route.ts");
  assert.equal(
    (await sync.POST(request("POST", "/api/sync/tokens", writeToken, { name: "escalate" }))).status,
    403
  );
});

test("restricted tokens cannot read raw database exports or replace stored credentials", async () => {
  const { NextRequest } = await import("next/server");
  const database = await import("../../src/app/api/settings/database/route.ts");
  const backupExport = await import("../../src/app/api/db-backups/export/route.ts");
  const backupImport = await import("../../src/app/api/db-backups/import/route.ts");
  const jsonExport = await import("../../src/app/api/settings/export-json/route.ts");
  const jsonImport = await import("../../src/app/api/settings/import-json/route.ts");
  for (const credential of [readToken, writeToken]) {
    assert.equal(
      (await database.GET(new NextRequest(request("GET", "/api/settings/database", credential))))
        .status,
      401
    );
    assert.equal(
      (await backupExport.GET(request("GET", "/api/db-backups/export", credential))).status,
      401
    );
    assert.equal(
      (await backupImport.POST(request("POST", "/api/db-backups/import", credential))).status,
      401
    );
    assert.equal(
      (await jsonExport.GET(request("GET", "/api/settings/export-json", credential))).status,
      401
    );
    assert.equal(
      (await jsonImport.POST(request("POST", "/api/settings/import-json", credential, {}))).status,
      401
    );
  }
});
