import test from "node:test";
import assert from "node:assert/strict";

// A per-process memory of proxies that just failed, shared by pool selection and the
// per-account rotation. One canonical key per entry point, a period that doubles on each
// repeat up to a cap, and a null key that never sets anything aside.

const memory = await import("../../open-sse/utils/proxyRefusalMemory.ts");

const MIN = 60_000;
const START_MS = 1_800_000_000_000;

test.beforeEach(() => {
  memory.__resetProxyRefusalMemoryForTesting();
  delete process.env.PROXY_SKIP_RECENTLY_FAILED;
});

test("an object, its URL and a legacy string give the same key", () => {
  const fromObject = memory.proxyEgressKey({
    type: "http",
    host: "H",
    port: 8080,
    username: "a@b",
    password: "pw",
  });
  assert.equal(fromObject, "http://a@b@h:8080");
  assert.equal(memory.proxyEgressKey("http://a%40b:pw@h:8080"), fromObject);
  assert.equal(memory.proxyEgressKey("http://a%40b:pw@H:8080"), fromObject);
});

test("the password and the family marker are not part of the key, the username is", () => {
  const base = memory.proxyEgressKey("http://a%40b:pw@h:8080");
  assert.equal(memory.proxyEgressKey("http://a%40b:other@h:8080"), base);
  assert.equal(memory.proxyEgressKey("http://a%40b:pw@h:8080?family=ipv6"), base);
  assert.notEqual(memory.proxyEgressKey("http://c:pw@h:8080"), base);
});

test("an IPv6 host gives the same non-null key as an object or a URL", () => {
  const fromObject = memory.proxyEgressKey({ type: "http", host: "::1", port: 8080 });
  assert.equal(fromObject, "http://@::1:8080");
  assert.equal(memory.proxyEgressKey("http://[::1]:8080"), fromObject);
});

test("invalid input, null, undefined and relays give a null key without throwing", () => {
  for (const input of ["not a url", null, undefined, { type: "http" }, 42]) {
    assert.equal(memory.proxyEgressKey(input), null, String(input));
  }
  assert.equal(memory.proxyEgressKey({ type: "vercel", host: "x.vercel.app", port: 443 }), null);
});

test("repeated refusals double the period up to the one-hour cap", () => {
  const key = "http://@h:8080";
  const periods: Array<number | null> = [];
  let now = START_MS;
  for (let i = 0; i < 7; i++) {
    const period = memory.noteProxyRefusal(key, "ip_quota_429", now);
    periods.push(period);
    now += period ?? 0;
  }
  assert.deepEqual(periods, [2 * MIN, 4 * MIN, 8 * MIN, 16 * MIN, 32 * MIN, 60 * MIN, 60 * MIN]);
});

test("a note while the proxy is set aside changes nothing", () => {
  const key = "http://@h:8080";
  assert.equal(memory.noteProxyRefusal(key, "ip_quota_429", START_MS), 2 * MIN);
  assert.equal(memory.noteProxyRefusal(key, "ip_quota_429", START_MS + MIN), null);
  assert.equal(memory.isProxyAvoided(key, START_MS + 2 * MIN - 1), true);
  assert.equal(memory.isProxyAvoided(key, START_MS + 2 * MIN), false);
});

test("recovery ends the period but keeps the streak for a repeat", () => {
  const key = "http://@h:8080";
  memory.noteProxyRefusal(key, "proxy_unreachable", START_MS);
  memory.noteProxyRecovered(key, "proxy_unreachable", START_MS + 10_000);
  assert.equal(memory.isProxyAvoided(key, START_MS + 10_000), false);
  assert.equal(memory.noteProxyRefusal(key, "proxy_unreachable", START_MS + 20_000), 2 * MIN);
});

test("a served response forgets every refusal kind for that key", () => {
  const key = "http://@h:8080";
  memory.noteProxyRefusal(key, "proxy_unreachable", START_MS);
  memory.noteProxyRefusal(key, "ip_quota_429", START_MS);
  memory.noteProxyServed(key);
  assert.equal(memory.isProxyAvoided(key, START_MS + 1), false);
  assert.equal(memory.__proxyRefusalMemorySizeForTesting(), 0);
});

test("an old streak is purged per kind: unreachable 20 min, refusal 2 h", () => {
  const key = "http://@h:8080";
  memory.noteProxyRefusal(key, "proxy_unreachable", START_MS);
  const endUnreachable = START_MS + MIN;
  assert.equal(
    memory.noteProxyRefusal(key, "proxy_unreachable", endUnreachable + 19 * MIN),
    2 * MIN
  );

  memory.__resetProxyRefusalMemoryForTesting();
  memory.noteProxyRefusal(key, "proxy_unreachable", START_MS);
  assert.equal(memory.noteProxyRefusal(key, "proxy_unreachable", endUnreachable + 20 * MIN), MIN);

  memory.__resetProxyRefusalMemoryForTesting();
  memory.noteProxyRefusal(key, "ip_quota_429", START_MS);
  const endRefusal = START_MS + 2 * MIN;
  assert.equal(memory.noteProxyRefusal(key, "ip_quota_429", endRefusal + 119 * MIN), 4 * MIN);
  memory.__resetProxyRefusalMemoryForTesting();
  memory.noteProxyRefusal(key, "ip_quota_429", START_MS);
  assert.equal(memory.noteProxyRefusal(key, "ip_quota_429", endRefusal + 120 * MIN), 2 * MIN);
});

test("a null key never writes and is never set aside", () => {
  assert.equal(memory.noteProxyRefusal(null, "ip_quota_429", START_MS), null);
  memory.noteProxyRecovered(null, "proxy_unreachable", START_MS);
  memory.noteProxyServed(null);
  assert.equal(memory.isProxyAvoided(null, START_MS), false);
  assert.equal(memory.__proxyRefusalMemorySizeForTesting(), 0);
});

test("the memory keeps at most 1000 entries and evicts the oldest", () => {
  for (let i = 0; i < 1001; i++) {
    memory.noteProxyRefusal(`http://@h:${10000 + i}`, "ip_quota_429", START_MS);
  }
  assert.equal(memory.__proxyRefusalMemorySizeForTesting(), 1000);
  assert.equal(memory.isProxyAvoided("http://@h:10000", START_MS + 1), false);
  assert.equal(memory.isProxyAvoided("http://@h:11000", START_MS + 1), true);
});

test("the switch is on unless false, 0, no or off", () => {
  assert.equal(memory.isProxySkipEnabled(), true);
  for (const value of ["true", "1", "yes", "", "anything"]) {
    process.env.PROXY_SKIP_RECENTLY_FAILED = value;
    assert.equal(memory.isProxySkipEnabled(), true, value);
  }
  for (const value of ["false", "0", "no", "off", " OFF ", "False"]) {
    process.env.PROXY_SKIP_RECENTLY_FAILED = value;
    assert.equal(memory.isProxySkipEnabled(), false, value);
  }
});
