/**
 * Runtime mirror of the connection-test ambiguous-401 predicate (#7718):
 * a bare Mistral 401 (`{"detail":"Unauthorized"}`) is byte-identical for a
 * revoked key and for exhausted quota, so the runtime must not assert a hard
 * auth failure on it. A body carrying an explicit auth signal still classifies
 * as a genuine auth failure. Pure leaf: no imports, no cycles.
 */

const AUTH_SIGNALS = ["invalid api key", "token invalid", "revoked", "access denied"];

/** True for a Mistral 401 whose body carries no explicit auth signal. */
export function isMistralAmbiguous401(
  provider: string | null | undefined,
  errorText: string | null | undefined
): boolean {
  if (provider !== "mistral") return false;
  const normalized = String(errorText || "").toLowerCase();
  return !AUTH_SIGNALS.some((signal) => normalized.includes(signal));
}
