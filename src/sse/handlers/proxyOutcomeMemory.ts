import { isEgressBucketedLockScope } from "@omniroute/open-sse/config/providerErrorRules.ts";
import { isRelayType } from "@omniroute/open-sse/utils/proxyDispatcher.ts";
import {
  isProxySkipEnabled,
  noteProxyRecovered,
  noteProxyRefusal,
  noteProxyServed,
  proxyEgressKey,
} from "@omniroute/open-sse/utils/proxyRefusalMemory.ts";

/**
 * Feed the outcome the provider actually returned through a proxy (captured around the
 * patched fetch and carried on proxyInfo.upstreamStatus) back to proxy selection. A
 * refusal received through a member sets it aside for the existing cooldown, and a
 * success through such a member clears it. A success from another provider proves the
 * proxy is reachable but says nothing about that refusal (a global pool is shared
 * across providers), so it only ends an unreachable period. No outcome (local refusal,
 * network error), an edge relay (the outcome is the relay's) or a direct request writes
 * nothing. Never reads result.status: several failures are generated locally.
 */
export function noteProxyOutcome(
  provider: string | null,
  proxyInfo: { proxy?: unknown; upstreamStatus?: number | null } | null | undefined
): void {
  if (!isProxySkipEnabled()) return;
  const status = proxyInfo?.upstreamStatus;
  if (typeof status !== "number") return;
  const proxy = proxyInfo?.proxy;
  if (proxy && typeof proxy === "object" && isRelayType((proxy as { type?: string }).type)) return;
  const key = proxyEgressKey(proxy);
  if (key === null) return;
  const refusalScopeProvider = isEgressBucketedLockScope(provider);
  if (status === 429 && refusalScopeProvider) {
    noteProxyRefusal(key, "ip_quota_429");
  } else if (status >= 200 && status < 300) {
    if (refusalScopeProvider) noteProxyServed(key);
    else noteProxyRecovered(key, "proxy_unreachable");
  }
}
