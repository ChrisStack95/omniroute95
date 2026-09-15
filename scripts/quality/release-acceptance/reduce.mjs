import { gateKey, keyId, sameKey } from "./types.mjs";

export function classifyDependent(prereqStatus, dependentKey, prereqKey) {
  if (prereqStatus === "FAIL") {
    return { status: "FAIL", cause: prereqKey };
  }
  if (prereqStatus === "INFRA_ERROR") {
    return { status: "INFRA_ERROR", cause: prereqKey };
  }
  if (prereqStatus == null) {
    return {
      status: "INFRA_ERROR",
      cause: prereqKey,
      evidence_error: {
        code: "prerequisite_missing",
        gate: dependentKey,
        detail: `missing prerequisite ${prereqKey.gate_id}`,
      },
    };
  }
  if (prereqStatus === "SKIPPED") {
    throw new Error("optional prerequisite");
  }
  return { status: "RUN", cause: null };
}

function findRecord(records, k) {
  return records.find((r) => sameKey(gateKey(r), k));
}

function requiredSet(plan) {
  return plan.required_gates ?? [];
}

function optionalSet(plan) {
  return plan.optional_gates ?? [];
}

function isRequired(plan, k) {
  return requiredSet(plan).some((r) => sameKey(r, k));
}

function isOptional(plan, k) {
  return optionalSet(plan).some((r) => sameKey(r, k));
}

export function reduce(plan, records) {
  const deps = plan.dependencies ?? {};
  for (const [depId, prereqId] of Object.entries(deps)) {
    const depKey = { gate_id: depId, suite_id: null, shard_index: null, shard_total: null };
    const prereqKey = { gate_id: prereqId, suite_id: null, shard_index: null, shard_total: null };
    if (isRequired(plan, depKey) && isOptional(plan, prereqKey)) {
      throw new Error("optional prerequisite");
    }
  }

  const byId = new Map();
  for (const rec of records) {
    byId.set(keyId(gateKey(rec)), rec);
  }

  const gates = [];
  const evidence_errors = [];
  const emitted = new Set();

  for (const rec of records) {
    const k = gateKey(rec);
    const copy = { ...rec, cause: rec.cause ?? null };
    if (copy.status === "SKIPPED" && isRequired(plan, k) && !copy.reason) {
      copy.reason = "required skipped";
    }
    gates.push(copy);
    emitted.add(keyId(k));
  }

  for (const [depId, prereqId] of Object.entries(deps)) {
    const depKey = { gate_id: depId, suite_id: null, shard_index: null, shard_total: null };
    const prereqKey = { gate_id: prereqId, suite_id: null, shard_index: null, shard_total: null };
    if (emitted.has(keyId(depKey))) continue;
    const prereq = findRecord(records, prereqKey);
    const classified = classifyDependent(prereq?.status ?? null, depKey, prereqKey);
    if (classified.status === "RUN") continue;
    const identity = plan.identity ?? {};
    gates.push({
      gate_id: depKey.gate_id,
      suite_id: depKey.suite_id,
      shard_index: depKey.shard_index,
      shard_total: depKey.shard_total,
      tested_sha: identity.tested_sha ?? null,
      run_id: identity.run_id ?? "0",
      run_attempt: identity.run_attempt ?? 1,
      command_id: depKey.gate_id,
      gate_type: "artifact",
      status: classified.status,
      cause: classified.cause,
      exit_code: classified.status === "FAIL" ? 1 : 2,
      duration_ms: 0,
      evidence: [],
    });
    if (classified.evidence_error) evidence_errors.push(classified.evidence_error);
    emitted.add(keyId(depKey));
  }

  for (const k of requiredSet(plan)) {
    const rec = gates.find((g) => sameKey(gateKey(g), k));
    if (!rec) {
      evidence_errors.push({
        code: "missing_record",
        gate: k,
        detail: `required gate ${k.gate_id} has no record`,
      });
    } else if (rec.status === "SKIPPED") {
      evidence_errors.push({
        code: "required_skipped",
        gate: k,
        detail: rec.reason ?? "required gate SKIPPED",
      });
    }
  }

  let verdict = "VERIFIED";
  const hasFail = gates.some((g) => g.status === "FAIL" && isRequired(plan, gateKey(g)));
  const hasUnverified =
    evidence_errors.length > 0 ||
    gates.some(
      (g) =>
        isRequired(plan, gateKey(g)) &&
        (g.status === "SKIPPED" || g.status === "INFRA_ERROR")
    );
  if (hasFail) verdict = "FAILED";
  else if (hasUnverified) verdict = "UNVERIFIED";
  else if (requiredSet(plan).some((k) => !gates.some((g) => sameKey(gateKey(g), k)))) {
    verdict = "UNVERIFIED";
  }

  return { verdict, evidence_errors, gates };
}
