/**
 * #13298 source guard: every consumer of the `auth_token` cookie must verify it
 * through verifyDashboardSessionToken (which requires `authenticated: true`).
 * A bare jose `jwtVerify` (called or aliased) in one of these files re-opens the
 * forgeable-session hole (Cursor CLI tokens share JWT_SECRET).
 *
 * ALLOWLIST: src/shared/utils/dashboardSessionToken.ts (the verifier itself),
 * src/app/api/auth/oidc/callback/route.ts (validates upstream ID token via jose/jwtVerify).
 * Any other file importing jwtVerify from jose and reading auth_token is a regression.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const VERIFIERS = [
  "src/shared/utils/apiAuth.ts",
  "src/server/authz/pipeline.ts",
  "src/lib/ws/handshake.ts",
  "src/server/ws/liveServer.ts",
  "src/app/api/settings/require-login/route.ts",
  "src/app/api/auth/status/route.ts",
];

for (const rel of VERIFIERS) {
  test(`${rel} verifies auth_token only through verifyDashboardSessionToken`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, /verifyDashboardSessionToken\s*\(/, "must call the shared verifier");
    assert.doesNotMatch(src, /\bjwtVerify\b/, "any bare jwtVerify is the #13298 regression");
  });
}

const ALLOWED_JWT_VERIFY_FILES = [
  "src/shared/utils/dashboardSessionToken.ts",
  "src/app/api/auth/oidc/callback/route.ts",
];

test("only allowlisted files call jwtVerify from jose (any bare import is a regression)", () => {
  for (const rel of ALLOWED_JWT_VERIFY_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, /\bjwtVerify\s*\(/, `${rel} must call jwtVerify`);
    assert.match(src, /=== true/, `${rel} must check the authenticated claim`);
  }
});
