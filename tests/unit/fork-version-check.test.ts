import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveForkVersionInfo } from "../../src/lib/system/forkVersionCheck.ts";

const currentSha = "1111111111111111111111111111111111111111";
const latestSha = "2222222222222222222222222222222222222222";
const published = (sha = latestSha) => ({
  workflow_runs: [
    { id: 123, head_sha: sha, head_branch: "stable", status: "completed", conclusion: "success" },
  ],
});
function responses(...payloads: unknown[]) {
  const urls: string[] = [];
  const fetchImpl = (async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    assert.ok(payloads.length, "unexpected external request");
    const payload = payloads.shift();
    return payload instanceof Response ? payload : Response.json(payload);
  }) as typeof fetch;
  return { urls, fetchImpl };
}

test("current published SHA has no update and needs no comparison", async () => {
  const fake = responses(published(currentSha));
  const result = await resolveForkVersionInfo("fork · sha-1111111", fake.fetchImpl);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.checkStatus, "ok");
  assert.equal(result.latest, "sha-1111111");
  assert.equal(fake.urls.length, 1);
  assert.match(
    fake.urls[0],
    /fenix007\/OmniRoute\/actions\/workflows\/fork-image-fenix007.yml\/runs\?branch=stable&status=success/
  );
});

test("newer successfully published fork advertises SHA and its build page", async () => {
  const fake = responses(published(), { status: "ahead" });
  const result = await resolveForkVersionInfo("fork · sha-1111111", fake.fetchImpl);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.channel, "fork");
  assert.equal(result.autoUpdateSupported, false);
  assert.equal(result.latest, "sha-2222222");
  assert.equal("latestLabel" in result && result.latestLabel, "fork · sha-2222222");
  assert.equal(
    "releaseUrl" in result && result.releaseUrl,
    "https://github.com/fenix007/OmniRoute/actions/runs/123"
  );
  assert.match(fake.urls[1], /compare\/1111111\.\.\.2222222222222222222222222222222222222222/);
});

for (const status of ["behind", "identical", "diverged"]) {
  test(`comparison ${status} never advertises a downgrade`, async () => {
    const fake = responses(published(), { status });
    const result = await resolveForkVersionInfo("fork · sha-1111111", fake.fetchImpl);
    assert.equal(result.updateAvailable, false);
    assert.equal(result.checkStatus, "ok");
  });
}

test("tagged fork release is compared against the published commit", async () => {
  const fake = responses(published(), { status: "ahead" });
  const result = await resolveForkVersionInfo("3.8.48-fork.19", fake.fetchImpl);
  assert.equal(result.updateAvailable, true);
  assert.match(fake.urls[1], /compare\/3\.8\.48-fork\.19\.\.\./);
});

for (const payload of [
  { workflow_runs: [] },
  { workflow_runs: [{ ...published().workflow_runs[0], conclusion: "failure" }] },
  { workflow_runs: [{ ...published().workflow_runs[0], status: "in_progress" }] },
  { workflow_runs: [{ ...published().workflow_runs[0], head_branch: "main" }] },
  { workflow_runs: [{ ...published().workflow_runs[0], head_sha: "unsafe/ref" }] },
  { unexpected: true },
]) {
  test(`unpublished or malformed run is unavailable: ${JSON.stringify(payload)}`, async () => {
    const fake = responses(payload);
    const result = await resolveForkVersionInfo("fork · sha-1111111", fake.fetchImpl);
    assert.equal(result.checkStatus, "unavailable");
    assert.equal(result.updateAvailable, false);
    assert.equal(fake.urls.length, 1);
  });
}

test("rate limits and failed comparisons never fall back to upstream", async () => {
  for (const payloads of [
    [new Response(null, { status: 403 })],
    [published(), new Response(null, { status: 404 })],
  ]) {
    const fake = responses(...payloads);
    const result = await resolveForkVersionInfo("fork · sha-1111111", fake.fetchImpl);
    assert.equal(result.checkStatus, "unavailable");
    assert.equal(result.latest, "unavailable");
    assert.ok(
      fake.urls.every((url) => url.startsWith("https://api.github.com/repos/fenix007/OmniRoute/"))
    );
  }
});

test("network failure and unrecognized current identity fail closed", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error("network unavailable");
  }) as typeof fetch;
  assert.equal(
    (await resolveForkVersionInfo("fork · sha-1111111", fetchImpl)).checkStatus,
    "unavailable"
  );
  assert.equal(
    (await resolveForkVersionInfo("unexpected/ref", fetchImpl)).checkStatus,
    "unavailable"
  );
  assert.equal(calls, 1);
});

test("production lookups share one in-flight check and cache outages", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, { status: 403 });
  }) as typeof fetch;
  try {
    const [first, second] = await Promise.all([
      resolveForkVersionInfo("fork · sha-abcdef1"),
      resolveForkVersionInfo("fork · sha-abcdef1"),
    ]);
    assert.equal(first.checkStatus, "unavailable");
    assert.deepEqual(first, second);
    await resolveForkVersionInfo("fork · sha-abcdef1");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
