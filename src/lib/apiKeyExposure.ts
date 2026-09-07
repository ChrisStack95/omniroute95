import { evaluateAccessTokenAuth, extractBearer } from "@/server/authz/accessTokenAuth";
import { isApiKeyRevealEnabledFlag } from "@/shared/utils/featureFlags";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isApiKeyRevealEnabled(): boolean {
  try {
    return isApiKeyRevealEnabledFlag();
  } catch {
    const raw = String(process.env.ALLOW_API_KEY_REVEAL || "")
      .trim()
      .toLowerCase();
    return ENABLED_VALUES.has(raw);
  }
}

/** A global reveal toggle never broadens a restricted CLI credential. */
export function isApiKeyRevealEnabledForRequest(request: Request): boolean {
  if (extractBearer(request)?.startsWith("oma_")) {
    const verdict = evaluateAccessTokenAuth(request);
    if (verdict.kind !== "ok" || verdict.scope !== "admin") return false;
  }
  return isApiKeyRevealEnabled();
}

export function maskStoredApiKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  return key.slice(0, 8) + "****" + key.slice(-4);
}
