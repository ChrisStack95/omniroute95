/**
 * Regression test for #5997 and the OpenCode free-tier validation change —
 * opencode-go/opencode-zen upstream requests must carry a valid OpenCode identity
 * even when the client did not supply one.
 *
 * On a datacenter VPS, `opencode.ai/zen/go/v1/chat/completions` is fronted by
 * upstream validation requires a versioned OpenCode User-Agent and canonical
 * `ses_...`/`msg_...` identifiers. Since most OpenAI-compatible clients never send
 * them,
 * `OpencodeExecutor.buildHeaders()` must synthesize the defaults when absent.
 *
 * Client-supplied values always take precedence (defaults only fill gaps), and the
 * UA/client/project defaults are env-overridable.
 *
 * PR #10571 flips the executor-level synthesis to ON BY DEFAULT. Opt-out remains
 * `OPENCODE_SYNTHESIZE_CLI_HEADERS=false`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardOpencodeClientHeaders } from "../../open-sse/utils/opencodeHeaders.ts";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";

const REQUEST_ID_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

// Values passed explicitly to forwardOpencodeClientHeaders()'s `cliDefaults` option in
// the tests below — these are caller-supplied, independent of OpencodeExecutor's own
// env-driven defaults (covered separately by the OPENCODE_DEFAULTS constant + the
// OpencodeExecutor.buildHeaders tests further down).
const CLI_DEFAULTS = { userAgent: "opencode/1.18.31", client: "desktop", project: "global" };

// PR #10571's new synthesized defaults for OpencodeExecutor.buildHeaders() itself.
const OPENCODE_DEFAULTS = { userAgent: "opencode/1.18.31", client: "desktop", project: "global" };

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const saved = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

test("forwardOpencodeClientHeaders: cliDefaults synthesize all CLI identity headers when absent [#5997]", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(headers, {}, { cliDefaults: CLI_DEFAULTS });

  assert.equal(headers["User-Agent"], "opencode/1.18.31");
  assert.equal(headers["x-opencode-client"], "desktop");
  assert.equal(headers["x-opencode-project"], "global");
  assert.match(headers["x-opencode-request"] ?? "", REQUEST_ID_RE);
  assert.match(headers["x-opencode-session"] ?? "", SESSION_ID_RE);
  assert.notEqual(headers["x-opencode-request"], headers["x-opencode-session"]);
});

test("forwardOpencodeClientHeaders: non-CLI client UA is REPLACED with the CLI UA; other headers keep client-wins [#5997 follow-up]", () => {
  const headers: Record<string, string> = {};
  const clientHeaders = {
    "User-Agent": "curl/8.5.0",
    "x-opencode-client": "vscode",
    "x-opencode-project": "acme",
    "x-opencode-request": "msg_0123456789abABCDEFGHIJKLMN",
    "x-opencode-session": "ses_0123456789abABCDEFGHIJKLMN",
  };
  forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });

  assert.equal(headers["User-Agent"], "opencode/1.18.31");
  assert.equal(headers["x-opencode-client"], "vscode");
  assert.equal(headers["x-opencode-project"], "acme");
  assert.equal(headers["x-opencode-request"], "msg_0123456789abABCDEFGHIJKLMN");
  assert.equal(headers["x-opencode-session"], "ses_0123456789abABCDEFGHIJKLMN");
});

test("forwardOpencodeClientHeaders: a valid versioned OpenCode UA is preserved", () => {
  const headers: Record<string, string> = {};
  const clientHeaders = { "User-Agent": "opencode/2.5.0" };
  forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });
  assert.equal(headers["User-Agent"], "opencode/2.5.0");
});

test("forwardOpencodeClientHeaders: bare and outdated OpenCode UAs are upgraded", () => {
  for (const userAgent of ["opencode", "opencode/1.16.9", "curl/8.5.0"]) {
    const headers: Record<string, string> = {};
    forwardOpencodeClientHeaders(
      headers,
      { "User-Agent": userAgent },
      { cliDefaults: CLI_DEFAULTS }
    );
    assert.equal(headers["User-Agent"], "opencode/1.18.31");
  }
});

test("forwardOpencodeClientHeaders: without cliDefaults, no synthesis (DefaultExecutor path unchanged)", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(headers, {});
  assert.equal(headers["User-Agent"], undefined);
  assert.equal(headers["x-opencode-client"], undefined);
  assert.equal(headers["x-opencode-project"], undefined);
});

test("OpencodeExecutor.buildHeaders: synthesizes CLI defaults by default — flag unset [#10571]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", undefined, () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");
    assert.equal(headers["User-Agent"], OPENCODE_DEFAULTS.userAgent);
    assert.equal(headers["x-opencode-client"], OPENCODE_DEFAULTS.client);
    assert.equal(headers["x-opencode-project"], OPENCODE_DEFAULTS.project);
    assert.match(headers["x-opencode-request"] ?? "", REQUEST_ID_RE);
  });
});

test("OpencodeExecutor.buildHeaders: synthesizes CLI defaults with flag explicitly on + no client headers [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "true", () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");

    assert.equal(headers["User-Agent"], OPENCODE_DEFAULTS.userAgent);
    assert.equal(headers["x-opencode-client"], OPENCODE_DEFAULTS.client);
    assert.equal(headers["x-opencode-project"], OPENCODE_DEFAULTS.project);
    assert.match(headers["x-opencode-request"] ?? "", REQUEST_ID_RE);
    assert.match(headers["x-opencode-session"] ?? "", SESSION_ID_RE);
  });
});

test("OpencodeExecutor.buildHeaders: forward-only — no fabrication when flag is explicitly off [#10571 opt-out]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "false", () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");
    assert.equal(headers["User-Agent"], undefined);
    assert.equal(headers["x-opencode-client"], undefined);
    assert.equal(headers["x-opencode-project"], undefined);
  });
});

test("OpencodeExecutor.buildHeaders: OPENCODE_GO_USER_AGENT env overrides the default UA (flag on) [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "true", () => {
    withEnv("OPENCODE_GO_USER_AGENT", "opencode/2.5.0", () => {
      const executor = new OpencodeExecutor("opencode-go");
      const headers = executor.buildHeaders(null, true, null, "glm-5.2");
      assert.equal(headers["User-Agent"], "opencode/2.5.0");
    });
  });
});
