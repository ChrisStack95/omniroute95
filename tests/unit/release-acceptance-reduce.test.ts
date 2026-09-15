import test from "node:test";
import assert from "node:assert/strict";
import { reduce } from "../../scripts/quality/release-acceptance/reduce.mjs";

const SHA = "30b5bf18fbe827a0283ce17e91bda22cc8b4c13e";

function key(gate_id) {
  return { gate_id, suite_id: null, shard_index: null, shard_total: null };
}

function record(partial) {
  return {
    gate_id: "lint",
    suite_id: null,
    shard_index: null,
    shard_total: null,
    tested_sha: SHA,
    run_id: "1",
    run_attempt: 1,
    command_id: partial.gate_id ?? "lint",
    gate_type: "static",
    status: "PASS",
    cause: null,
    exit_code: 0,
    duration_ms: 10,
    evidence: [],
    ...partial,
  };
}

function planWithRequired(gateId, extra = {}) {
  return {
    required_gates: [key(gateId)],
    identity: { tested_sha: SHA, run_id: "1", run_attempt: 1 },
    ...extra,
  };
}

const planPack = {
  required_gates: [key("pack-artifact"), key("pack-boot")],
  identity: { tested_sha: SHA, run_id: "1", run_attempt: 1 },
  dependencies: { "pack-boot": "pack-artifact" },
};

test("required SKIPPED never yields VERIFIED", () => {
  const out = reduce(planWithRequired("lint"), [
    record({ gate_id: "lint", status: "SKIPPED", reason: "optional-looking" }),
  ]);
  assert.equal(out.verdict, "UNVERIFIED");
});

test("pack-artifact FAIL classifies pack-boot as FAIL with cause", () => {
  const out = reduce(planPack, [
    record({ gate_id: "pack-artifact", status: "FAIL", gate_type: "artifact" }),
  ]);
  const boot = out.gates.find((g) => g.gate_id === "pack-boot");
  assert.equal(boot.status, "FAIL");
  assert.equal(boot.cause.gate_id, "pack-artifact");
  assert.equal(out.verdict, "FAILED");
});

test("pack-artifact INFRA_ERROR classifies pack-boot as INFRA_ERROR", () => {
  const out = reduce(planPack, [
    record({
      gate_id: "pack-artifact",
      status: "INFRA_ERROR",
      gate_type: "artifact",
    }),
  ]);
  const boot = out.gates.find((g) => g.gate_id === "pack-boot");
  assert.equal(boot.status, "INFRA_ERROR");
  assert.equal(out.verdict, "UNVERIFIED");
});

test("plan that marks a required gate's prerequisite optional is rejected", () => {
  const illegalPlan = {
    required_gates: [key("pack-boot")],
    identity: { tested_sha: SHA, run_id: "1", run_attempt: 1 },
    dependencies: { "pack-boot": "pack-artifact" },
    optional_gates: [key("pack-artifact")],
  };
  assert.throws(() => reduce(illegalPlan, []), /optional prerequisite/);
});
