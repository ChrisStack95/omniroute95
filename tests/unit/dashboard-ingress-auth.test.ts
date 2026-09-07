import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";

process.env.JWT_SECRET = "dashboard-ingress-synthetic-signing-secret";
const { GET, HEAD } = await import("../../src/app/api/auth/dashboard-access/route.ts");

function request(headers: HeadersInit = {}) {
  return new Request("https://router.example/api/auth/dashboard-access", { headers });
}

async function cookie(secret = process.env.JWT_SECRET, expired = false) {
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expired ? "-1h" : "1h")
    .sign(new TextEncoder().encode(secret));
  return `auth_token=${token}`;
}

test("dashboard ingress accepts a verified session for GET and HEAD without caching", async () => {
  for (const handler of [GET, HEAD]) {
    const response = await handler(request({ cookie: await cookie() }));
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
  }
});

test("dashboard ingress rejects absent, forged and expired sessions", async () => {
  for (const headers of [
    {},
    { cookie: "auth_token=forged" },
    { cookie: await cookie("a-different-synthetic-signing-secret") },
    { cookie: await cookie(process.env.JWT_SECRET, true) },
    { authorization: "Bearer synthetic-client-key", "x-omniroute-auth-kind": "dashboard_session" },
  ]) {
    assert.equal((await GET(request(headers))).status, 401);
  }
});

test("even a configured master API key cannot replace the dashboard session", async () => {
  const previous = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "synthetic-dashboard-ingress-master-key";
  try {
    const response = await GET(
      request({ authorization: `Bearer ${process.env.OMNIROUTE_API_KEY}` })
    );
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previous;
  }
});
