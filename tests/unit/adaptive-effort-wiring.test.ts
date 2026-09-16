// chatCore adaptive-effort wiring tests (#13448).
//
// The wiring module is the chatCore call-site adapter extracted from
// chatCore.ts (file-size gate: that file cannot grow). The service-level
// tests in adaptive-effort.test.ts cover resolution semantics; THESE tests
// cover the adapter's own decisions, which are invisible to the service:
//   - explicit client reasoning fields are never overwritten (precedence),
//   - the literal "auto" injected by ModelSpec.defaultReasoningEffort is an
//     opt-in marker and must be stripped before resolution, not sent upstream,
//   - the x-omniroute-effort header opts in independently,
//   - a non-opted-in body is returned untouched (same reference).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireAdaptiveEffort } from "@omniroute/open-sse/handlers/chatCore/adaptiveEffortWiring.ts";
import { FORMATS } from "@omniroute/open-sse/translator/formats.ts";

const HEAVY = "x".repeat(20000);
const trivialMsgs = [{ role: "user", content: "list the files" }];
const heavyMsgs = [{ role: "user", content: HEAVY }];

test("explicit reasoning_effort is never overwritten by adaptive wiring", () => {
  const body = { model: "m", reasoning_effort: "low" };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: heavyMsgs },
    headerEffort: "auto",
    targetFormat: FORMATS.OPENAI,
  });
  assert.equal(out.reasoning_effort, "low");
});

test("explicit reasoning object is never overwritten", () => {
  const body = { model: "m", reasoning: { effort: "high" } };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: trivialMsgs },
    headerEffort: "auto",
    targetFormat: FORMATS.OPENAI,
  });
  assert.deepEqual(out.reasoning, { effort: "high" });
  assert.equal(out.reasoning_effort, undefined);
});

test("explicit thinking field is never overwritten", () => {
  const body = { model: "m", thinking: { type: "enabled" } };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: heavyMsgs },
    headerEffort: "auto",
    targetFormat: FORMATS.OPENAI,
  });
  assert.deepEqual(out.thinking, { type: "enabled" });
  assert.equal(out.reasoning_effort, undefined);
});

test("model-default 'auto' marker is resolved, never sent upstream verbatim", () => {
  const body = { model: "m", reasoning_effort: "auto" };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: trivialMsgs },
    headerEffort: null,
    targetFormat: FORMATS.OPENAI,
  });
  assert.notEqual(out.reasoning_effort, "auto");
  assert.equal(out.reasoning_effort, "low");
});

test("model-default 'auto' resolves high on heavy turns", () => {
  const body = { model: "m", reasoning_effort: "auto" };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: heavyMsgs },
    headerEffort: null,
    targetFormat: FORMATS.OPENAI,
  });
  assert.equal(out.reasoning_effort, "high");
});

test("header opt-in resolves from the raw (pre-translation) body messages", () => {
  const body = { model: "m" };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: heavyMsgs },
    headerEffort: "auto",
    targetFormat: FORMATS.OPENAI,
  });
  assert.equal(out.reasoning_effort, "high");
});

test("no opt-in leaves the body untouched (same reference)", () => {
  const body = { model: "m" };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: heavyMsgs },
    headerEffort: null,
    targetFormat: FORMATS.OPENAI,
  });
  assert.equal(out, body);
  assert.equal(out.reasoning_effort, undefined);
});

test("missing rawBody does not throw", () => {
  const body = { model: "m", reasoning_effort: "auto" };
  const out = wireAdaptiveEffort(body, {
    rawBody: undefined,
    headerEffort: null,
    targetFormat: FORMATS.OPENAI,
  });
  assert.ok(["low", "medium", "high"].includes(out.reasoning_effort as string));
});

// #13448 rework: the field wireAdaptiveEffort injects (`reasoning_effort`) is an
// OpenAI Chat-Completions-shaped field. On any other dispatch format it is either
// inert (Claude/Gemini read `thinking`/`reasoning.effort` instead) or actively
// harmful (Anthropic's Messages API 400s on an unrecognized top-level parameter).
// Every sibling reasoning-shape normalization in chatCore.ts is scoped to
// `FORMATS.OPENAI` the same way (applyDefaultReasoningEffort,
// promoteStrayReasoningEffort's same-format Responses lane) -- wiring must match.
test("header opt-in is a no-op on a Claude-targeted dispatch (body returned unchanged)", () => {
  const body = { model: "m" };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: heavyMsgs },
    headerEffort: "auto",
    targetFormat: FORMATS.CLAUDE,
  });
  assert.equal(out, body, "must be the exact same reference -- no reasoning_effort injected");
  assert.equal(out.reasoning_effort, undefined);
});

test("header opt-in is a no-op on a Gemini-targeted dispatch", () => {
  const body = { model: "m" };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: heavyMsgs },
    headerEffort: "auto",
    targetFormat: FORMATS.GEMINI,
  });
  assert.equal(out, body);
  assert.equal(out.reasoning_effort, undefined);
});

test("model-default 'auto' marker is left untouched (not stripped, not resolved) on a non-OpenAI target", () => {
  // Guards against a partial fix that strips the "auto" marker before the
  // targetFormat check -- on a non-OpenAI target the body (including any stray
  // literal "auto") must be untouched, since it was never OmniRoute's own
  // injection to interpret on that dispatch shape.
  const body = { model: "m", reasoning_effort: "auto" };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: heavyMsgs },
    headerEffort: null,
    targetFormat: FORMATS.CLAUDE,
  });
  assert.equal(out, body);
  assert.equal(out.reasoning_effort, "auto");
});

test("targetFormat undefined (e.g. an uncovered call site) also no-ops -- fail closed", () => {
  const body = { model: "m" };
  const out = wireAdaptiveEffort(body, {
    rawBody: { messages: heavyMsgs },
    headerEffort: "auto",
    targetFormat: undefined,
  });
  assert.equal(out, body);
});
