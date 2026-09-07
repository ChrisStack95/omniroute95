import { BlockList, isIP } from "node:net";
import { resolveStampedPeer } from "@/server/authz/peerStampValue";
import { PEER_IP_HEADER } from "@/server/authz/headers";
import { CLIENT_IP_HEADER, resolveClientIpStamp } from "@/server/authz/clientIpStamp";

/**
 * T07: Extract the real client IP from X-Forwarded-For header.
 * Skips invalid entries like "unknown" or empty strings.
 * Falls back to remoteAddress if no valid IP found.
 * Ref: sub2api PR #1135
 *
 * @param xForwardedFor - Value of the X-Forwarded-For header (may be CSV)
 * @param remoteAddress - Fallback from the raw socket (req.socket.remoteAddress)
 * @returns The first valid IP address found, or "unknown"
 */
export function extractClientIp(
  xForwardedFor: string | null | undefined,
  remoteAddress: string | undefined
): string {
  if (xForwardedFor) {
    const entries = xForwardedFor.split(",");
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed && isIP(trimmed) !== 0) {
        return trimmed; // First valid IP wins
      }
    }
  }
  return remoteAddress?.trim() ?? "unknown";
}

/**
 * Strip an IPv4-mapped IPv6 prefix ("::ffff:127.0.0.1" -> "127.0.0.1") so the
 * loopback check below catches both representations Node may report.
 */
function normalizePeer(addr: string | undefined): string {
  const trimmed = (addr ?? "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

/** Only configured reverse proxies may supply an X-Forwarded-For chain. */
function isTrustedProxy(address: string): boolean {
  const ip = normalizePeer(address);
  if (!isIP(ip)) return false;
  const trusted = new BlockList();
  trusted.addSubnet("127.0.0.0", 8, "ipv4");
  trusted.addAddress("::1", "ipv6");
  for (const entry of (process.env.OMNIROUTE_TRUSTED_PROXY_IPS || "").split(",")) {
    const [rawAddress, prefix, ...extra] = entry.trim().split("/");
    const candidate = normalizePeer(rawAddress);
    const family = isIP(candidate);
    if (!family || extra.length) continue;
    const type = family === 4 ? "ipv4" : "ipv6";
    try {
      if (prefix === undefined) trusted.addAddress(candidate, type);
      else if (/^\d+$/.test(prefix)) trusted.addSubnet(candidate, Number(prefix), type);
    } catch {
      // Invalid configuration never broadens trust.
    }
  }
  return trusted.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
}

/**
 * Resolve the client from a real peer, a server-authenticated peer stamp, or
 * the pipeline's authenticated client-IP stamp. Header-only requests without
 * these proofs share the unknown bucket; arbitrary forwarding headers cannot
 * create fresh login buckets. CF-Connecting-IP is deliberately never trusted.
 *
 * Reverse proxies must overwrite XFF or append their immediate client to it.
 * Walk from the socket towards the client, stopping at the first untrusted hop.
 */
export function getClientIpFromRequest(req: {
  headers?: Headers | { get?: (n: string) => string | null };
  socket?: { remoteAddress?: string };
  ip?: string;
}): string {
  const getHeader = (name: string): string | null => req.headers?.get?.(name) ?? null;
  const token = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  const rawPeer =
    req.socket?.remoteAddress ?? req.ip ?? resolveStampedPeer(getHeader(PEER_IP_HEADER), token);
  const peer = normalizePeer(rawPeer ?? undefined);
  if (!isIP(peer)) {
    return resolveClientIpStamp(getHeader(CLIENT_IP_HEADER), token) ?? "unknown";
  }
  if (!isTrustedProxy(peer)) return peer;

  const forwarded = getHeader("x-forwarded-for") ?? getHeader("x-real-ip");
  if (!forwarded) return peer;
  const hops = forwarded.split(",").map((part) => normalizePeer(part));
  let current = peer;
  for (let i = hops.length - 1; i >= 0 && isTrustedProxy(current); i--) {
    // A malformed nearest hop must not let us skip to attacker-controlled data.
    if (!isIP(hops[i])) return current;
    current = hops[i];
  }
  return current;
}
