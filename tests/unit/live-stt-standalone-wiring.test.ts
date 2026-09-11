import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("live STT sidecar is started and proxied by the standalone server", () => {
  const instrumentation = read("src/instrumentation-node.ts");
  const standaloneWrapper = read("scripts/dev/standalone-server-ws.mjs");

  assert.match(instrumentation, /import\("@\/server\/liveStt\/server"\)/);
  assert.match(standaloneWrapper, /LIVE_STT_PATH\s*=\s*"\/v1\/audio\/transcriptions\/live"/);
  assert.match(standaloneWrapper, /url\.pathname\s*===\s*LIVE_STT_PATH/);
  assert.match(standaloneWrapper, /proxyLiveSttWs\(req, socket, head\)/);
});
