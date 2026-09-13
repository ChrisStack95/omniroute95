/**
 * Short-lived, per-process memory of proxies that just failed, shared by both places that
 * pick a proxy: registry pools (#6365) and the per-account rotation of noauth executors.
 * A failed proxy is set aside for a period that doubles on each repeat, up to a cap, then
 * comes back. Nothing is persisted and no proxy status is written: only the order in which
 * candidates are tried changes. Keys are entry points (scheme, username, host, port),
 * never passwords.
 */
import { COOLDOWN_MS } from "../config/errorConfig.ts";
import { proxyConfigToUrl } from "./proxyDispatcher.ts";
import { stripIpv6Brackets } from "./proxyFamily.ts";

export const REFUSAL_POLICIES = {
  /** The TCP probe could not open a connection to the proxy. */
  proxy_unreachable: { baseMs: 60_000, maxMs: 600_000 },
  /** The provider refused through this proxy; the member is set aside for a cooldown. */
  ip_quota_429: { baseMs: COOLDOWN_MS.rateLimit, maxMs: 3_600_000 },
} as const;

export type ProxyRefusalKind = keyof typeof REFUSAL_POLICIES;

type RefusalState = { streak: number; until: number };

const MAX_ENTRIES = 1000;
const DISABLED_VALUES = ["false", "0", "no", "off"];
const REFUSAL_KINDS = Object.keys(REFUSAL_POLICIES) as ProxyRefusalKind[];
// scheme://[userinfo@]host:port at the start of a normalized proxy URL.
const AUTHORITY = /^([a-z0-9+.-]+):\/\/(?:([^@/]*)@)?(\[[^\]]+\]|[^:/?#]+):(\d+)/i;

const memory = new Map<string, RefusalState>();

/** On unless PROXY_SKIP_RECENTLY_FAILED is false, 0, no or off (like ENABLE_SOCKS5_PROXY). */
export function isProxySkipEnabled(): boolean {
  const raw = (process.env.PROXY_SKIP_RECENTLY_FAILED ?? "").trim().toLowerCase();
  return !DISABLED_VALUES.includes(raw);
}

/**
 * One key per proxy entry point, whether the proxy comes as a config object, a URL or a
 * legacy string: scheme, decoded username, lower-case host without IPv6 brackets, port as
 * written by normalization. Password and ?family= are ignored. Anything unusable, and
 * edge relays (no port), give null, which never sets anything aside.
 */
export function proxyEgressKey(proxy: unknown): string | null {
  try {
    let input = proxy;
    if (proxy && typeof proxy === "object" && !Array.isArray(proxy)) {
      const host = (proxy as { host?: unknown }).host;
      if (typeof host === "string" && host.includes(":") && !host.startsWith("[")) {
        input = { ...(proxy as Record<string, unknown>), host: `[${host}]` };
      }
    }
    const url = proxyConfigToUrl(input, { allowSocks5: true });
    const match = url ? AUTHORITY.exec(url) : null;
    if (!match) return null;
    const [, scheme, userinfo, host, port] = match;
    const rawUser = userinfo ? userinfo.split(":")[0] : "";
    const user = rawUser ? decodeURIComponent(rawUser) : "";
    return `${scheme.toLowerCase()}://${user}@${stripIpv6Brackets(host).toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

function entryId(key: string, kind: ProxyRefusalKind): string {
  return `${kind} ${key}`;
}

// Read one (key, kind) state, dropping it once its period ended more than 2 x maxMs ago.
function readState(key: string, kind: ProxyRefusalKind, nowMs: number): RefusalState | undefined {
  const id = entryId(key, kind);
  const state = memory.get(id);
  if (state && nowMs - state.until >= 2 * REFUSAL_POLICIES[kind].maxMs) {
    memory.delete(id);
    return undefined;
  }
  return state;
}

/** Set a proxy aside for `kind`. Returns the new period in ms, or null if nothing changed. */
export function noteProxyRefusal(
  key: string | null,
  kind: ProxyRefusalKind,
  nowMs: number = Date.now()
): number | null {
  if (key === null) return null;
  const state = readState(key, kind, nowMs);
  if (state && state.until > nowMs) return null;
  const policy = REFUSAL_POLICIES[kind];
  const streak = (state?.streak ?? 0) + 1;
  const periodMs = Math.min(policy.baseMs * 2 ** (streak - 1), policy.maxMs);
  const id = entryId(key, kind);
  memory.delete(id);
  memory.set(id, { streak, until: nowMs + periodMs });
  if (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  return periodMs;
}

/** The proxy answered again: end its period now, keep the streak so a repeat doubles. */
export function noteProxyRecovered(
  key: string | null,
  kind: ProxyRefusalKind,
  nowMs: number = Date.now()
): void {
  if (key === null) return;
  const state = readState(key, kind, nowMs);
  if (state && state.until > nowMs) state.until = nowMs;
}

/** A response came back through this proxy: forget every refusal kind for it. */
export function noteProxyServed(key: string | null): void {
  if (key === null) return;
  for (const kind of REFUSAL_KINDS) memory.delete(entryId(key, kind));
}

export function isProxyAvoided(key: string | null, nowMs: number = Date.now()): boolean {
  if (key === null) return false;
  return REFUSAL_KINDS.some((kind) => {
    const state = readState(key, kind, nowMs);
    return state !== undefined && state.until > nowMs;
  });
}

/** Test-only: forget everything. */
export function __resetProxyRefusalMemoryForTesting(): void {
  memory.clear();
}

/** Test-only: number of (key, kind) entries held. */
export function __proxyRefusalMemorySizeForTesting(): number {
  return memory.size;
}
