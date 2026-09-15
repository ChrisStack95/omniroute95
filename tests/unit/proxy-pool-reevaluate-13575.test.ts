/**
 * TDD — #13575 chat-path proxy resolution freezes the pool pick per connection.
 *
 * `resolveProxyForConnection` (src/lib/db/settings.ts) caches the first pool
 * member per connection key, so the pool strategy from #6365 (round-robin
 * cursor, sticky window) runs once and never again for that connection: every
 * later chat request re-serves the cached member until an unrelated settings /
 * registry / connection-state write bumps a generation and clears the whole
 * cache. The registry-level resolver (`resolveProxyForScopeFromRegistry`) is
 * unaffected — the existing 6365 tests call it directly and keep passing.
 *
 * Fix under test: a per-scope opt-in `reevaluatePerRequest` flag (default off,
 * stored next to the strategy in `proxy_scope_rotation`). When on, each
 * `resolveProxyForConnection` call asks the pool again instead of serving the
 * frozen member; the pool answers with the same member unless the strategy
 * says otherwise. Background callers (token refresh, warmup) pass
 * `{ reevaluatePool: false }` to keep the cached member without consuming
 * rotation turns.
 *
 * Invariants preserved:
 *   - Default (flag off) keeps today's stable member per connection.
 *   - Sticky still holds its member inside the window when re-evaluating.
 *   - Only ALIVE members are handed out; fail-closed (#6246) untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-reevaluate-13575-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

const core = await import("../../src/lib/db/core.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

let proxySeq = 0;
async function makeProxy() {
  proxySeq++;
  const proxy = await proxiesDb.createProxy({
    name: `Reevaluate proxy ${proxySeq}`,
    type: "http",
    host: `10.9.0.${proxySeq}`,
    port: 9100 + proxySeq,
    status: "active",
  });
  assert.ok(proxy?.id);
  return proxy as { id: string; host: string };
}

async function makeConnection(): Promise<string> {
  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apiKey",
    name: `Conn ${Date.now()} ${Math.random()}`,
    apiKey: "sk-test",
  });
  return (conn as { id: string }).id;
}

async function resolveHost(connId: string, options?: { reevaluatePool?: boolean }) {
  const r = await settingsDb.resolveProxyForConnection(connId, undefined, undefined, options);
  return (r as { proxy: { host: string } }).proxy.host;
}

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("default (flag off): a connection keeps its pool member across chat-path requests", async () => {
  await resetStorage();
  const connId = await makeConnection();
  const a = await makeProxy();
  const b = await makeProxy();
  const c = await makeProxy();
  await proxiesDb.addProxyToScopePool("account", connId, a.id);
  await proxiesDb.addProxyToScopePool("account", connId, b.id);
  await proxiesDb.addProxyToScopePool("account", connId, c.id);

  const seen: string[] = [];
  for (let i = 0; i < 6; i++) seen.push(await resolveHost(connId));

  // Stable egress by default — today's behavior, must not change.
  assert.ok(new Set(seen).size === 1, `expected one frozen member, got ${JSON.stringify(seen)}`);
});

test("reevaluate on: round-robin cycles per request through resolveProxyForConnection", async () => {
  await resetStorage();
  const connId = await makeConnection();
  const a = await makeProxy();
  const b = await makeProxy();
  const c = await makeProxy();
  await proxiesDb.addProxyToScopePool("account", connId, a.id);
  await proxiesDb.addProxyToScopePool("account", connId, b.id);
  await proxiesDb.addProxyToScopePool("account", connId, c.id);
  await proxiesDb.setScopeRotationStrategy("account", connId, "round-robin", {
    reevaluatePerRequest: true,
  });

  const seen: string[] = [];
  for (let i = 0; i < 6; i++) seen.push(await resolveHost(connId));

  // Each chat-path request asks the pool again: strict A,B,C,A,B,C cycle.
  assert.deepEqual(seen, [a.host, b.host, c.host, a.host, b.host, c.host]);
});

test("flag is per-scope: other connections stay frozen while one re-evaluates", async () => {
  await resetStorage();
  const connA = await makeConnection();
  const connB = await makeConnection();
  const members = [await makeProxy(), await makeProxy(), await makeProxy()];
  for (const m of members) await proxiesDb.addProxyToScopePool("account", connA, m.id);
  const others = [await makeProxy(), await makeProxy(), await makeProxy()];
  for (const m of others) await proxiesDb.addProxyToScopePool("account", connB, m.id);
  await proxiesDb.setScopeRotationStrategy("account", connA, "round-robin", {
    reevaluatePerRequest: true,
  });

  const frozen: string[] = [];
  for (let i = 0; i < 3; i++) frozen.push(await resolveHost(connB));
  assert.ok(new Set(frozen).size === 1, `connB must stay frozen, got ${JSON.stringify(frozen)}`);

  const cycling = new Set<string>();
  for (let i = 0; i < 3; i++) cycling.add(await resolveHost(connA));
  assert.equal(cycling.size, 3, "connA must cycle through all three members");
});

test("background peek ({ reevaluatePool: false }) keeps the member without consuming turns", async () => {
  await resetStorage();
  const connId = await makeConnection();
  const a = await makeProxy();
  const b = await makeProxy();
  const c = await makeProxy();
  await proxiesDb.addProxyToScopePool("account", connId, a.id);
  await proxiesDb.addProxyToScopePool("account", connId, b.id);
  await proxiesDb.addProxyToScopePool("account", connId, c.id);
  await proxiesDb.setScopeRotationStrategy("account", connId, "round-robin", {
    reevaluatePerRequest: true,
  });

  const first = await resolveHost(connId);
  assert.equal(first, a.host);
  // Background callers (token refresh, warmup) peek: same member, no advance.
  const peek1 = await resolveHost(connId, { reevaluatePool: false });
  const peek2 = await resolveHost(connId, { reevaluatePool: false });
  assert.equal(peek1, b.host);
  assert.equal(peek2, b.host);
  // The next chat-path request continues where the cursor is, not +2 further.
  const next = await resolveHost(connId);
  assert.equal(next, b.host);
});

test("sticky + reevaluate: holds the member inside the window across requests", async () => {
  await resetStorage();
  const connId = await makeConnection();
  const a = await makeProxy();
  const b = await makeProxy();
  await proxiesDb.addProxyToScopePool("account", connId, a.id);
  await proxiesDb.addProxyToScopePool("account", connId, b.id);
  await proxiesDb.setScopeRotationStrategy("account", connId, "sticky", {
    stickyWindowMinutes: 60,
    reevaluatePerRequest: true,
  });

  const seen: string[] = [];
  for (let i = 0; i < 3; i++) seen.push(await resolveHost(connId));
  assert.ok(
    new Set(seen).size === 1,
    `sticky must hold one member in-window, got ${JSON.stringify(seen)}`
  );
});

test("flag persists on the rotation row and defaults to off", async () => {
  await resetStorage();
  const connId = await makeConnection();
  assert.equal(typeof proxiesDb.getScopePoolReevaluate, "function");
  assert.equal(await proxiesDb.getScopePoolReevaluate("account", connId), false);
  await proxiesDb.setScopeRotationStrategy("account", connId, "round-robin", {
    reevaluatePerRequest: true,
  });
  assert.equal(await proxiesDb.getScopePoolReevaluate("account", connId), true);
  // Changing the strategy without the option preserves the flag.
  await proxiesDb.setScopeRotationStrategy("account", connId, "random");
  assert.equal(await proxiesDb.getScopePoolReevaluate("account", connId), true);
  assert.equal(await proxiesDb.getScopeRotationStrategy("account", connId), "random");
});
