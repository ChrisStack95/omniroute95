import { describe, it } from "node:test";
import assert from "node:assert";
import {
  classify429,
  parseRetryAfterSeconds,
} from "../../open-sse/executors/opencodeRateLimited.ts";

describe("classify429", () => {
  it("parseable Retry-After header alone classifies rate_limited", () => {
    assert.strictEqual(classify429({ retryAfter: "30" }), "rate_limited");
    assert.strictEqual(classify429({ retryAfter: "120" }), "rate_limited");
  });
  it("numeric Retry-After classifies rate_limited", () => {
    assert.strictEqual(classify429({ retryAfter: 45 }), "rate_limited");
  });
  it("body with rate-limit signal classifies rate_limited", () => {
    assert.strictEqual(classify429({ bodyText: "Rate limited, slow down" }), "rate_limited");
    assert.strictEqual(classify429({ bodyText: "Too many requests, retry later" }), "rate_limited");
    assert.strictEqual(
      classify429({ bodyText: "usage limit reached, retry in 60s" }),
      "rate_limited"
    );
  });
  it("bare 429 without signal classifies burst", () => {
    assert.strictEqual(classify429({}), "burst");
    assert.strictEqual(classify429({ bodyText: '{"error":"boom"}' }), "burst");
  });
  it("unparseable Retry-After without body signal classifies burst", () => {
    assert.strictEqual(classify429({ retryAfter: "not-a-date" }), "burst");
  });
  it("status never classifies: only the signal inputs matter", () => {
    assert.strictEqual(classify429({ status: 500 }), "burst");
    assert.strictEqual(classify429({ status: 500, retryAfter: "30" }), "rate_limited");
  });
  it("date Retry-After parses to seconds like the classifier accepts", () => {
    const future = new Date(Date.now() + 120_000).toUTCString();
    assert.strictEqual(classify429({ retryAfter: future }), "rate_limited");
    const secs = parseRetryAfterSeconds(future);
    assert.ok(secs !== null && secs > 0 && secs <= 120, `got ${secs}`);
    assert.strictEqual(parseRetryAfterSeconds("30"), 30);
    assert.strictEqual(parseRetryAfterSeconds("not-a-date"), null);
  });
});
import net from "node:net";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";
import type { ExecutorLog, ProviderCredentials } from "../../open-sse/executors/base.ts";
import { resolveProxyForRequest } from "../../open-sse/utils/proxyFetch.ts";

const rlog: ExecutorLog = { debug() {}, info() {}, warn() {}, error() {} };
const FP_X = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const FP_Y = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
const FP_Z = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

function credentialsFor3(px: number, py: number, pz: number): ProviderCredentials {
  return {
    apiKey: null,
    accessToken: null,
    connectionId: "noauth",
    providerSpecificData: {
      fingerprints: [FP_X, FP_Y, FP_Z],
      accountProxies: [FP_X, FP_Y, FP_Z].map((fp) => ({
        fingerprint: fp,
        proxy: {
          type: "http",
          host: "127.0.0.1",
          port: fp === FP_X ? px : fp === FP_Y ? py : pz,
        },
      })),
    },
  };
}

describe("rate-limited 429 stops the wave", () => {
  it("429 with Retry-After: 1 dispatch, drain 429 with relayed headers", async () => {
    const servers = [
      net.createServer((s) => s.destroy()),
      net.createServer((s) => s.destroy()),
      net.createServer((s) => s.destroy()),
    ];
    try {
      const ports: number[] = [];
      for (const s of servers) {
        ports.push(
          await new Promise<number>((resolve) =>
            s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port))
          )
        );
      }
      const observed: string[] = [];
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          const resolved = resolveProxyForRequest(url);
          observed.push(resolved.proxyUrl ? new URL(resolved.proxyUrl).port : "direct");
          return new Response(JSON.stringify({ error: { message: "slow down" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "30" },
          });
        }) as typeof globalThis.fetch;
        const exec = new OpencodeExecutor("opencode-zen");
        const result = (await exec.execute({
          model: "muse-spark-1.3-contributor-free",
          body: { messages: [{ role: "user", content: "hi" }], stream: false },
          stream: false,
          signal: null,
          credentials: credentialsFor3(ports[0], ports[1], ports[2]),
          log: rlog,
        })) as { response: Response };
        assert.strictEqual(observed.length, 1, "wave stops after the classified 429");
        assert.strictEqual(result.response.status, 429);
        assert.strictEqual(result.response.headers.get("retry-after"), "30");
        assert.strictEqual(result.response.headers.get("x-opencode-retry-state"), "rate-limited");
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      for (const s of servers) s.close();
    }
  });

  it("bare 429 without signal keeps rotating to the healthy proxy", async () => {
    const servers = [net.createServer((s) => s.destroy()), net.createServer((s) => s.destroy())];
    try {
      const ports: number[] = [];
      for (const s of servers) {
        ports.push(
          await new Promise<number>((resolve) =>
            s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port))
          )
        );
      }
      const observed: string[] = [];
      const originalFetch = globalThis.fetch;
      try {
        let call = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          const resolved = resolveProxyForRequest(url);
          observed.push(resolved.proxyUrl ? new URL(resolved.proxyUrl).port : "direct");
          call++;
          if (call === 1) {
            return new Response(JSON.stringify({ error: "boom" }), {
              status: 429,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof globalThis.fetch;
        const exec = new OpencodeExecutor("opencode-zen");
        const creds: ProviderCredentials = {
          apiKey: null,
          accessToken: null,
          connectionId: "noauth",
          providerSpecificData: {
            fingerprints: [FP_X, FP_Y],
            accountProxies: [FP_X, FP_Y].map((fp) => ({
              fingerprint: fp,
              proxy: { type: "http", host: "127.0.0.1", port: fp === FP_X ? ports[0] : ports[1] },
            })),
          },
        };
        const result = (await exec.execute({
          model: "muse-spark-1.3-contributor-free",
          body: { messages: [{ role: "user", content: "hi" }], stream: false },
          stream: false,
          signal: null,
          credentials: creds,
          log: rlog,
        })) as { response: Response };
        assert.strictEqual(result.response.status, 200);
        assert.strictEqual(observed.length, 2, "burst 429 rotates, does not stop the wave");
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      for (const s of servers) s.close();
    }
  });
});

describe("all-burst wave carries no state header (M1)", () => {
  it("all-burst 429s surface the last response untouched", async () => {
    const servers = [net.createServer((s) => s.destroy()), net.createServer((s) => s.destroy())];
    try {
      const ports: number[] = [];
      for (const s of servers) {
        ports.push(
          await new Promise<number>((resolve) =>
            s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port))
          )
        );
      }
      const observed: string[] = [];
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          const resolved = resolveProxyForRequest(url);
          observed.push(resolved.proxyUrl ? new URL(resolved.proxyUrl).port : "direct");
          return new Response(JSON.stringify({ error: "boom" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof globalThis.fetch;
        const exec = new OpencodeExecutor("opencode-zen");
        const creds: ProviderCredentials = {
          apiKey: null,
          accessToken: null,
          connectionId: "noauth",
          providerSpecificData: {
            fingerprints: [FP_X, FP_Y],
            accountProxies: [FP_X, FP_Y].map((fp) => ({
              fingerprint: fp,
              proxy: { type: "http", host: "127.0.0.1", port: fp === FP_X ? ports[0] : ports[1] },
            })),
          },
        };
        const result = (await exec.execute({
          model: "muse-spark-1.3-contributor-free",
          body: { messages: [{ role: "user", content: "hi" }], stream: false },
          stream: false,
          signal: null,
          credentials: creds,
          log: rlog,
        })) as { response: Response };
        assert.strictEqual(result.response.status, 429);
        assert.strictEqual(observed.length, 2, "both proxies tried, no wave stop");
        assert.strictEqual(result.response.headers.get("x-opencode-retry-state"), null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      for (const s of servers) s.close();
    }
  });
});
