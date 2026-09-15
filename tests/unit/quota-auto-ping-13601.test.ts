import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-autoping-13601-"));

const { runQuotaAutoPingTick, createQuotaAutoPingState } =
  await import("../../src/lib/services/quotaAutoPing.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { QUOTA_AUTOPING_FAR_RESET_SKIP_MS } =
  await import("../../src/shared/constants/quotaAutoPing.ts");

test.after(() => {
  resetDbInstance();
});

const NOW_ISO = "2026-01-01T12:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();
const FAR_RESET_ISO = new Date(NOW_MS + 30 * 24 * 60 * 60 * 1000).toISOString();
const NEAR_RESET_ISO = new Date(NOW_MS + 61 * 1000).toISOString();

function baseDeps(overrides = {}) {
  const calls = { updateProviderConnection: [], executorExecute: [] };
  const deps = {
    getSettings: async () => ({ codexAutoPing: { connections: { "codex-1": true } } }),
    getProviderConnections: async ({ provider }) =>
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }]
        : [],
    updateProviderConnection: async (id, data) => {
      calls.updateProviderConnection.push([id, data]);
      return null;
    },
    refreshAndUpdateCredentials: async (connection) => ({ connection }),
    getCodexUsage: async () => ({ quotas: {} }),
    throttleQuotaFetch: async () => {},
    getExecutor: () => ({
      execute: async (input) => {
        calls.executorExecute.push(input);
        return { response: { ok: true, text: async () => "" } };
      },
    }),
    canExecuteProvider: () => true,
    isConnectionUnavailableToAuxiliaryActivity: async () => false,
    resolvePingModel: async () => "gpt-5-codex",
    ...overrides,
  };
  return { deps, calls };
}

test("#13601 D4: far-out resetAt sends no ping and records no failure", async () => {
  const { deps, calls } = baseDeps({
    getCodexUsage: async () => ({
      quotas: {
        session: { used: 1, total: 100, remaining: 99, resetAt: FAR_RESET_ISO },
      },
    }),
  });
  const state = createQuotaAutoPingState();
  state.resetCache["codex:codex-1"] = NEAR_RESET_ISO;

  await runQuotaAutoPingTick(deps, state, () => NOW_MS);

  assert.equal(calls.executorExecute.length, 0, "no ping may be sent when reset is far out");
  assert.equal(calls.updateProviderConnection.length, 0, "no ping bookkeeping may be written");
  assert.equal(
    state.failureCache["codex:codex-1"],
    undefined,
    "a skipped-as-far tick must not warn/record a failure"
  );
});

test("#13601 D4: isActive:false connections are never pinged", async () => {
  const { deps, calls } = baseDeps({
    getSettings: async () => ({
      codexAutoPing: { connections: { "codex-1": true, "codex-2": true } },
    }),
    getProviderConnections: async ({ provider }) =>
      provider === "codex"
        ? [
            {
              id: "codex-1",
              provider: "codex",
              authType: "oauth",
              accessToken: "t1",
              isActive: false,
            },
            { id: "codex-2", provider: "codex", authType: "oauth", accessToken: "t2" },
          ]
        : [],
    getCodexUsage: async () => ({
      quotas: {
        session: { used: 1, total: 100, remaining: 99, resetAt: NEAR_RESET_ISO },
      },
    }),
  });
  const state = createQuotaAutoPingState();
  state.resetCache["codex:codex-1"] = NOW_ISO;
  state.resetCache["codex:codex-2"] = NOW_ISO;

  await runQuotaAutoPingTick(deps, state, () => NOW_MS);

  assert.equal(calls.executorExecute.length, 1, "only the active connection may be pinged");
  assert.equal(calls.executorExecute[0].credentials.connectionId, "codex-2");
});

test("#13601 D4: resetAt exactly at the 6h threshold still sends (strict `>`)", async () => {
  const exactResetISO = new Date(NOW_MS + QUOTA_AUTOPING_FAR_RESET_SKIP_MS).toISOString();
  const { deps, calls } = baseDeps({
    getCodexUsage: async () => ({
      quotas: {
        session: { used: 1, total: 100, remaining: 99, resetAt: exactResetISO },
      },
    }),
  });
  const state = createQuotaAutoPingState();
  state.resetCache["codex:codex-1"] = NOW_ISO;

  await runQuotaAutoPingTick(deps, state, () => NOW_MS);

  assert.equal(calls.executorExecute.length, 1, "exactly-at-threshold must not be skipped");
});

test("#13601 D4: missing resetAt sends no ping (early return)", async () => {
  const { deps, calls } = baseDeps({
    getCodexUsage: async () => ({
      quotas: { session: { used: 1, total: 100, remaining: 99 } },
    }),
  });
  const state = createQuotaAutoPingState();
  state.resetCache["codex:codex-1"] = NOW_ISO;

  await runQuotaAutoPingTick(deps, state, () => NOW_MS);

  assert.equal(calls.executorExecute.length, 0, "no resetAt means no ping");
  assert.equal(calls.updateProviderConnection.length, 0, "no resetAt means no bookkeeping");
});

test("#13601 D4: invalid-date resetAt currently sends no ping", async () => {
  // Documents current behavior: `NaN > skipMs` is false so the far-reset guard
  // itself is fail-open, but the downstream reset-drift gate (NaN drift → 0)
  // still stops the send.
  const { deps, calls } = baseDeps({
    getCodexUsage: async () => ({
      quotas: {
        session: { used: 1, total: 100, remaining: 99, resetAt: "not-a-date" },
      },
    }),
  });
  const state = createQuotaAutoPingState();
  state.resetCache["codex:codex-1"] = NOW_ISO;

  await runQuotaAutoPingTick(deps, state, () => NOW_MS);

  assert.equal(calls.executorExecute.length, 0, "invalid resetAt must not send a ping");
  assert.equal(
    state.failureCache["codex:codex-1"],
    undefined,
    "an invalid-resetAt skip must not record a failure"
  );
});
