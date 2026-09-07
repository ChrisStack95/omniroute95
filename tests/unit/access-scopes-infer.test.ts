import test from "node:test";
import assert from "node:assert/strict";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";

test("read methods default to read", () => {
  assert.equal(inferRequiredScope("GET", "/api/v1/models"), "read");
  assert.equal(inferRequiredScope("HEAD", "/api/health"), "read");
  assert.equal(inferRequiredScope("OPTIONS", "/api/anything"), "read");
});

test("mutating methods default to write", () => {
  assert.equal(inferRequiredScope("POST", "/api/combos"), "write");
  assert.equal(inferRequiredScope("PUT", "/api/config"), "write");
  assert.equal(inferRequiredScope("PATCH", "/api/combo/x"), "write");
  assert.equal(inferRequiredScope("DELETE", "/api/combos/abc"), "write");
});

test("admin-prefix routes require admin for ANY method", () => {
  assert.equal(inferRequiredScope("GET", "/api/cli/tokens"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/cli/tokens"), "admin");
  assert.equal(inferRequiredScope("DELETE", "/api/cli/tokens/tok_1"), "admin");
  assert.equal(inferRequiredScope("GET", "/api/oauth/start"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/auth/login"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/policy"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/services/foo/start"), "admin");
});

test("admin-mutation prefixes: GET stays read, mutations become admin", () => {
  // providers: status is read, but creating/rotating is admin
  assert.equal(inferRequiredScope("GET", "/api/providers/status"), "read");
  assert.equal(inferRequiredScope("GET", "/api/providers"), "read");
  assert.equal(inferRequiredScope("POST", "/api/providers"), "admin");
  assert.equal(inferRequiredScope("DELETE", "/api/providers/openai"), "admin");
  // cli-tools/apply writes to the host fs
  assert.equal(inferRequiredScope("POST", "/api/cli-tools/apply"), "admin");
});

test("a brand-new mutating route is write by default (not admin)", () => {
  assert.equal(inferRequiredScope("POST", "/api/some-future-route"), "write");
  assert.equal(inferRequiredScope("GET", "/api/some-future-route"), "read");
});

test("prefix matching does not over-match unrelated paths", () => {
  // "/api/authz-inventory" must NOT be caught by the "/api/auth" admin prefix
  assert.equal(inferRequiredScope("GET", "/api/authz-inventory"), "read");
  // "/api/services" itself and its children are admin, but a lookalike is not
  assert.equal(inferRequiredScope("GET", "/api/services-catalog"), "read");
});

test("all credential mutation and disclosure operations require admin", () => {
  for (const [method, path] of [
    ["POST", "/api/keys"],
    ["PATCH", "/api/keys/example"],
    ["POST", "/api/keys/example/regenerate"],
    ["DELETE", "/api/keys/example"],
    ["GET", "/api/keys/example/reveal"],
    ["HEAD", "/api/keys/example/reveal/"],
    ["GET", "/api/cli-tools/keys"],
    ["GET", "/api/cli-tools/codex-settings"],
    ["POST", "/api/cli-tools/guide-settings/opencode"],
    ["GET", "/api/cli-tools/backups"],
    ["GET", "/api/cli-tools/codex-profiles"],
    ["POST", "/api/sync/tokens"],
    ["DELETE", "/api/relay/tokens/example"],
    ["HEAD", "/api/cli-tools/keys/"],
  ])
    assert.equal(inferRequiredScope(method, path), "admin", `${method} ${path}`);
  assert.equal(inferRequiredScope("GET", "/api/keys"), "read");
  assert.equal(inferRequiredScope("GET", "/api/keys/example"), "read");
  assert.equal(inferRequiredScope("GET", "/api/cli-tools/status"), "read");
  assert.equal(inferRequiredScope("GET", "/api/sync/tokens"), "read");
  assert.equal(inferRequiredScope("GET", "/api/relay/tokens"), "read");
});
