import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { getClientIpFromRequest } from "../../src/lib/ipUtils.ts";
import { CLIENT_IP_HEADER, stampClientIp } from "../../src/server/authz/clientIpStamp.ts";
import { PEER_IP_HEADER } from "../../src/server/authz/headers.ts";
import {
  checkLoginGuard,
  recordLoginFailure,
  resetLoginGuardForTests,
} from "../../src/server/auth/loginGuard.ts";

const originalToken = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
const originalProxies = process.env.OMNIROUTE_TRUSTED_PROXY_IPS;
const token = "trusted-client-ip-fixture";
test.beforeEach(() => {
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = token;
  delete process.env.OMNIROUTE_TRUSTED_PROXY_IPS;
  resetLoginGuardForTests();
});
test.after(() => {
  if (originalToken === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  else process.env.OMNIROUTE_PEER_STAMP_TOKEN = originalToken;
  if (originalProxies === undefined) delete process.env.OMNIROUTE_TRUSTED_PROXY_IPS;
  else process.env.OMNIROUTE_TRUSTED_PROXY_IPS = originalProxies;
});
function request(headers: Record<string, string>) {
  return new NextRequest("https://audit.invalid/api/auth/login", { headers });
}

test("socket-less forged CF, forwarding and internal headers cannot select login buckets", () => {
  for (const fake of ["203.0.113.1", "203.0.113.2"]) {
    const ip = getClientIpFromRequest(
      request({
        "cf-connecting-ip": fake,
        "x-forwarded-for": fake,
        [PEER_IP_HEADER]: `forged|${fake}`,
        [CLIENT_IP_HEADER]: `${fake}|${"0".repeat(64)}`,
      })
    );
    assert.equal(ip, "unknown");
    if (fake.endsWith(".1")) for (let i = 0; i < 5; i++) recordLoginFailure(ip, { enabled: true });
    assert.equal(checkLoginGuard(ip, { enabled: true }).allowed, false);
  }
});

test("authenticated public peer wins over attacker forwarding headers", () => {
  assert.equal(
    getClientIpFromRequest(
      request({
        [PEER_IP_HEADER]: `${token}|198.51.100.10`,
        "cf-connecting-ip": "203.0.113.1",
        "x-forwarded-for": "203.0.113.2",
      })
    ),
    "198.51.100.10"
  );
});

test("private peers require explicit proxy trust; Docker nginx retains actual client identity", () => {
  const req = request({
    [PEER_IP_HEADER]: `${token}|172.19.0.5`,
    "x-forwarded-for": "198.51.100.10",
    "cf-connecting-ip": "203.0.113.1",
  });
  assert.equal(getClientIpFromRequest(req), "172.19.0.5");
  process.env.OMNIROUTE_TRUSTED_PROXY_IPS = "172.19.0.0/16";
  assert.equal(getClientIpFromRequest(req), "198.51.100.10");
});

test("forwarding traversal stops at nearest untrusted hop instead of spoofable leftmost IP", () => {
  process.env.OMNIROUTE_TRUSTED_PROXY_IPS = "172.19.0.5,10.0.0.0/24";
  assert.equal(
    getClientIpFromRequest(
      request({
        [PEER_IP_HEADER]: `${token}|172.19.0.5`,
        "x-forwarded-for": "203.0.113.99, 198.51.100.10, 10.0.0.3",
      })
    ),
    "198.51.100.10"
  );
});

test("malformed nearest hops and malformed trust configuration fail closed", () => {
  process.env.OMNIROUTE_TRUSTED_PROXY_IPS = "garbage,0.0.0.0/999,172.19.0.0/";
  assert.equal(
    getClientIpFromRequest(
      request({
        [PEER_IP_HEADER]: `${token}|172.19.0.5`,
        "x-forwarded-for": "203.0.113.99",
      })
    ),
    "172.19.0.5"
  );
  assert.equal(
    getClientIpFromRequest(
      request({
        [PEER_IP_HEADER]: `${token}|127.0.0.1`,
        "x-forwarded-for": "203.0.113.99, unknown",
      })
    ),
    "127.0.0.1"
  );
});

test("IPv6 and IPv4-mapped trusted peers preserve normalized client identity", () => {
  process.env.OMNIROUTE_TRUSTED_PROXY_IPS = "fd00:1234::/64";
  assert.equal(
    getClientIpFromRequest(
      request({
        [PEER_IP_HEADER]: `${token}|fd00:1234::2`,
        "x-forwarded-for": "2001:db8::10",
      })
    ),
    "2001:db8::10"
  );
  assert.equal(
    getClientIpFromRequest(
      request({
        [PEER_IP_HEADER]: `${token}|::ffff:127.0.0.1`,
        "x-forwarded-for": "::ffff:198.51.100.10",
      })
    ),
    "198.51.100.10"
  );
});

test("client stamp authenticates identity without forwarding the process secret", () => {
  const signed = stampClientIp("198.51.100.10", token)!;
  assert.equal(signed.includes(token), false);
  assert.equal(getClientIpFromRequest(request({ [CLIENT_IP_HEADER]: signed })), "198.51.100.10");
  assert.equal(
    getClientIpFromRequest(request({ [CLIENT_IP_HEADER]: signed.replace(".10|", ".11|") })),
    "unknown"
  );
  assert.equal(stampClientIp("unknown", token), null);
});
