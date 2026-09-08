/** Pure WebDAV path, authentication and XML tests split from the HTTP suite. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HANDLER_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../scripts/dev/webdav-handler.mjs"
);

/** Import the handler module fresh (bust module cache for env-dependent tests). */
async function importHandler(): Promise<typeof import("../../scripts/dev/webdav-handler.mjs")> {
  const url = pathToFileURL(HANDLER_PATH).href;
  return import(`${url}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omni-webdav-primitives-"));
test.after(() => fs.rmSync(VAULT_ROOT, { recursive: true, force: true }));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Path traversal guard (resolveVaultPath)
// ─────────────────────────────────────────────────────────────────────────────

test("resolveVaultPath: simple path inside vault resolves correctly", async () => {
  const { resolveVaultPath } = await importHandler();
  const { absPath } = resolveVaultPath(VAULT_ROOT, "/api/v1/webdav/notes/file.md");
  assert.equal(absPath, path.join(VAULT_ROOT, "notes", "file.md"));
});

test("resolveVaultPath: root path resolves to vaultRoot", async () => {
  const { resolveVaultPath } = await importHandler();
  const { absPath } = resolveVaultPath(VAULT_ROOT, "/api/v1/webdav/");
  assert.equal(absPath, path.resolve(VAULT_ROOT));
});

test("resolveVaultPath: ../ traversal is rejected with 403", async () => {
  const { resolveVaultPath } = await importHandler();
  assert.throws(
    () => resolveVaultPath(VAULT_ROOT, "/api/v1/webdav/../../../etc/passwd"),
    (err: { status: number }) => err.status === 403
  );
});

test("resolveVaultPath: encoded %2e%2e%2f traversal is rejected with 403", async () => {
  const { resolveVaultPath } = await importHandler();
  assert.throws(
    () => resolveVaultPath(VAULT_ROOT, "/api/v1/webdav/%2e%2e%2fetc/passwd"),
    (err: { status: number }) => err.status === 403
  );
});

test("resolveVaultPath: encoded %2e%2e traversal variant is rejected", async () => {
  const { resolveVaultPath } = await importHandler();
  assert.throws(
    () => resolveVaultPath(VAULT_ROOT, "/api/v1/webdav/%2e%2e/secret"),
    (err: { status: number }) => err.status === 403
  );
});

test("resolveVaultPath: absolute path injection outside vault is rejected", async () => {
  const { resolveVaultPath } = await importHandler();
  // The guard must catch paths that escape the vault root after resolution.
  // We test by passing a request path whose decoded form resolves outside VAULT_ROOT.
  // The URL segment /api/v1/webdav is stripped, then the remaining path is decoded
  // and resolved relative to vaultRoot. A path like /../../../outside must be caught.

  // Use an alternative vault root with a deeper subdir so we can craft an escape
  const deepVault = path.join(VAULT_ROOT, "sub", "deep");
  // /api/v1/webdav/../../secret: after prefix strip → /../../secret
  // stripped of leading slashes → ../../secret
  // path.resolve(deepVault, "../../secret") → VAULT_ROOT/secret which is OUTSIDE deepVault
  assert.throws(
    () => resolveVaultPath(deepVault, "/api/v1/webdav/../../secret"),
    (err: { status: number }) => err.status === 403
  );
});

test("resolveDestinationPath: raw path that escapes vault is rejected", async () => {
  const { resolveDestinationPath } = await importHandler();
  // Use a deep vault so we can craft an escape path.
  // Pass a raw path (not a full URL) so the URL parser does not normalise away the ..
  const deepVault = path.join(VAULT_ROOT, "sub", "deep");
  // A raw Destination header path that resolves outside deepVault
  assert.throws(
    () => resolveDestinationPath(deepVault, "/api/v1/webdav/../../escape-target"),
    (err: { status: number }) => err.status === 403
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. verifyBasicAuth
// ─────────────────────────────────────────────────────────────────────────────

test("verifyBasicAuth: correct credentials return true", async () => {
  const { verifyBasicAuth } = await importHandler();
  assert.equal(verifyBasicAuth(basicAuth("alice", "s3cr3t"), "alice", "s3cr3t"), true);
});

test("verifyBasicAuth: wrong password returns false", async () => {
  const { verifyBasicAuth } = await importHandler();
  assert.equal(verifyBasicAuth(basicAuth("alice", "wrong"), "alice", "s3cr3t"), false);
});

test("verifyBasicAuth: wrong username returns false", async () => {
  const { verifyBasicAuth } = await importHandler();
  assert.equal(verifyBasicAuth(basicAuth("bob", "s3cr3t"), "alice", "s3cr3t"), false);
});

test("verifyBasicAuth: missing header returns false", async () => {
  const { verifyBasicAuth } = await importHandler();
  assert.equal(verifyBasicAuth(undefined, "alice", "s3cr3t"), false);
});

test("verifyBasicAuth: empty header returns false", async () => {
  const { verifyBasicAuth } = await importHandler();
  assert.equal(verifyBasicAuth("", "alice", "s3cr3t"), false);
});

test("verifyBasicAuth: non-Basic scheme returns false", async () => {
  const { verifyBasicAuth } = await importHandler();
  assert.equal(verifyBasicAuth("Bearer some-token", "alice", "s3cr3t"), false);
});

test("verifyBasicAuth: malformed base64 returns false", async () => {
  const { verifyBasicAuth } = await importHandler();
  assert.equal(verifyBasicAuth("Basic !!!notbase64!!!", "alice", "s3cr3t"), false);
});

test("verifyBasicAuth: base64 with no colon separator returns false", async () => {
  const { verifyBasicAuth } = await importHandler();
  const noColon = "Basic " + Buffer.from("alices3cr3t").toString("base64");
  assert.equal(verifyBasicAuth(noColon, "alice", "s3cr3t"), false);
});

test("verifyBasicAuth: constant-time path exercised (long password diff)", async () => {
  const { verifyBasicAuth } = await importHandler();
  const longPassword = "a".repeat(1000);
  // Should return false without throwing on length mismatch
  assert.equal(verifyBasicAuth(basicAuth("alice", longPassword), "alice", "short"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. buildPropfindXml
// ─────────────────────────────────────────────────────────────────────────────

test("buildPropfindXml: produces valid XML with entries", async () => {
  const { buildPropfindXml } = await importHandler();
  const now = new Date("2026-01-01T00:00:00Z");
  const xml = buildPropfindXml(
    [
      { name: "notes", href: "/api/v1/webdav/notes/", isDir: true, size: 0, mtime: now },
      {
        name: "file.md",
        href: "/api/v1/webdav/notes/file.md",
        isDir: false,
        size: 1234,
        mtime: now,
      },
    ],
    "/api/v1/webdav/"
  );

  assert.match(xml, /<?xml version="1.0"/);
  assert.match(xml, /D:multistatus/);
  assert.match(xml, /D:response/);
  assert.match(xml, /notes/);
  assert.match(xml, /file\.md/);
  assert.match(xml, /1234/); // content-length for file
  assert.match(xml, /D:collection/); // dir has collection resourcetype
});

test("buildPropfindXml: escapes XML special chars in names", async () => {
  const { buildPropfindXml } = await importHandler();
  const xml = buildPropfindXml(
    [
      {
        name: "a <b> & c 'quote' \"double\"",
        href: "/api/v1/webdav/a",
        isDir: false,
        size: 10,
        mtime: new Date(),
      },
    ],
    "/api/v1/webdav/"
  );

  // Unescaped < > & ' " must not appear inside element content
  assert.doesNotMatch(xml, /<D:displayname>[^<]*<[^/]/);
  assert.match(xml, /&lt;/);
  assert.match(xml, /&gt;/);
  assert.match(xml, /&amp;/);
});

test("buildPropfindXml: file entry has no D:collection resourcetype", async () => {
  const { buildPropfindXml } = await importHandler();
  const xml = buildPropfindXml(
    [
      {
        name: "note.md",
        href: "/api/v1/webdav/note.md",
        isDir: false,
        size: 99,
        mtime: new Date(),
      },
    ],
    "/api/v1/webdav/"
  );
  // File should have empty resourcetype, not a collection
  assert.doesNotMatch(xml, /D:collection/);
});
