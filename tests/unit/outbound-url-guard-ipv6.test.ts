import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  isCloudMetadataHost,
  isPrivateHost,
  parseAndValidatePublicUrl,
} from "@/shared/network/outboundUrlGuard";
import { fetchRemoteImage } from "@/shared/network/remoteImageFetch";

const blockedIpv6 = [
  "::",
  "0:0:0:0:0:0:0:0",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1",
  "0:0:0:0:0:ffff:7f00:1",
  "::127.0.0.1",
  "fc00::1",
  "FD12:3456::1",
  "fe80::1",
  "febf::1",
  "fec0::1",
  "ff02::1",
];

test("public URL guard rejects canonical and expanded non-public IPv6 addresses", () => {
  for (const address of blockedIpv6) {
    assert.equal(isPrivateHost(address), true, address);
    assert.equal(isPrivateHost(`[${address}]`), true, address);
    assert.throws(() => parseAndValidatePublicUrl(`http://[${address}]/image.png`), /Blocked/);
  }
  assert.equal(isPrivateHost("fe80::1%eth0"), true);
  for (const address of ["2606:4700:4700::1111", "2001:4860:4860:0:0:0:0:8888"]) {
    assert.equal(isPrivateHost(address), false, address);
    assert.doesNotThrow(() => parseAndValidatePublicUrl(`https://[${address}]/image.png`));
  }
  assert.equal(isCloudMetadataHost("FD00:0EC2:0:0:0:0:0:0254"), true);
  for (const address of ["224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255"]) {
    assert.equal(isPrivateHost(address), true, address);
  }
});

test("real image fetch cannot reach a local listener through the unspecified IPv6 address", async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end("synthetic local data");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", resolve);
    });
  } catch (error) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code || "")) {
      t.skip("IPv6 loopback unavailable");
      return;
    }
    throw error;
  }
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  await assert.rejects(
    fetchRemoteImage(`http://[::]:${port}/image.png`, { guard: "public-only" }),
    /Blocked/
  );
  assert.equal(requests, 0);
});

test("public image fetch rejects non-public IPv6 literals and DNS answers before fetching", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return new Response("unexpected");
  };
  for (const address of blockedIpv6) {
    await assert.rejects(
      fetchRemoteImage(`http://[${address}]/image.png`, { guard: "public-only", fetchImpl }),
      /blocked/i
    );
    await assert.rejects(
      fetchRemoteImage("https://images.example.com/image.png", {
        guard: "public-only",
        fetchImpl,
        lookup: async () => [{ address, family: 6 }],
      }),
      /blocked/i
    );
  }
  assert.equal(fetchCalls, 0);
});

test("public image fetch rejects redirects to IPv6 unspecified before the second fetch", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    fetchRemoteImage("https://images.example.com/image.png", {
      guard: "public-only",
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchImpl: async () => {
        fetchCalls++;
        return new Response(null, { status: 302, headers: { location: "http://[::]/private" } });
      },
    }),
    /Blocked/
  );
  assert.equal(fetchCalls, 1);
});
