/**
 * opencodeRateLimited.ts — 429 classifier for the opencode executor loop.
 *
 * Leaf module: zero imports, pure logic, no registry, no DB. Headers-first:
 * a parseable Retry-After alone signals a rate-limited 429; otherwise a
 * bounded body read is matched against generic English rate-limit signals
 * (derived from a captured 429 body, never fixed ex nihilo). Anything else —
 * including any 5xx status alone — is a burst that keeps the fast rotation.
 */

const RATE_LIMITED_SIGNALS: ReadonlyArray<RegExp> = [
  /rate.?limited/i,
  /usage.?limit/i,
  /too many requests/i,
];

export function parseRetryAfterSeconds(
  retryAfter: string | number | null | undefined
): number | null {
  if (typeof retryAfter === "number") {
    if (!Number.isFinite(retryAfter) || retryAfter <= 0) return null;
    if (retryAfter < 1_000_000_000) return Math.max(Math.ceil(retryAfter), 1);
  }
  if (typeof retryAfter !== "string") return null;
  const text = retryAfter.trim();
  if (text === "") return null;
  if (/^\d+$/.test(text)) return Math.max(Math.ceil(Number(text)), 1);
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) return Math.max(Math.ceil((ms - Date.now()) / 1000), 1);
  return null;
}

function isParseableRetryAfter(retryAfter: string | number | null | undefined): boolean {
  return parseRetryAfterSeconds(retryAfter) !== null;
}

export function classify429(input: {
  retryAfter?: string | number | null;
  bodyText?: string | null;
  status?: number | null;
}): "rate_limited" | "burst" {
  if (isParseableRetryAfter(input.retryAfter)) return "rate_limited";
  const body = typeof input.bodyText === "string" ? input.bodyText : "";
  if (body !== "" && RATE_LIMITED_SIGNALS.some((re) => re.test(body))) return "rate_limited";
  return "burst";
}
