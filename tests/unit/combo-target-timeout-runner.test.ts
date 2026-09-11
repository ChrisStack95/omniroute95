import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import type { SingleModelTarget } from "../../open-sse/services/combo/types.ts";

const noopLog = { warn() {}, info() {}, error() {}, debug() {} };

function targetAbortSignal(target?: SingleModelTarget): AbortSignal | undefined {
  return target?.modelAbortSignal ?? undefined;
}

test("timeout<=0: passthrough direto (sem timer)", async () => {
  let called = false;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => {
      called = true;
      return new Response("ok");
    },
    comboTargetTimeoutMs: 0,
    log: noopLog,
  });
  const res = await runner({}, "m");
  assert.equal(called, true);
  assert.equal(await res.text(), "ok");
});

test("timeout<=0: erro do upstream vira errorResponse 502", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => {
      throw new Error("boom");
    },
    comboTargetTimeoutMs: 0,
    log: noopLog,
  });
  const res = await runner({}, "m");
  assert.equal(res.status, 502);
});

test("excede o limite: aborta e retorna 524 timed out", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: (_b, _m, target) =>
      new Promise<Response>((resolve) => {
        const signal = targetAbortSignal(target);
        signal?.addEventListener("abort", () => resolve(new Response(null, { status: 599 })));
      }),
    comboTargetTimeoutMs: 20,
    log: noopLog,
  });
  const res = await runner({}, "slow-model");
  assert.equal(res.status, 524);
  const body = await res.json();
  assert.match(JSON.stringify(body), /timed out/i);
});

test("sucesso rápido vence a corrida do timeout", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => new Response("fast", { status: 200 }),
    comboTargetTimeoutMs: 1000,
    log: noopLog,
  });
  const res = await runner({}, "m");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "fast");
});

test("external parent abort preserves its reason on the child", async () => {
  const parent = new AbortController();
  const reason = new Error("request_signal_aborted");
  parent.abort(reason);
  let childReason: unknown = null;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: (_b, _m, target) => {
      childReason = targetAbortSignal(target)?.reason;
      return Promise.resolve(new Response("ok"));
    },
    comboTargetTimeoutMs: 1000,
    log: noopLog,
  });
  await runner({}, "m", { modelAbortSignal: parent.signal });
  assert.equal(childReason, reason);
});
