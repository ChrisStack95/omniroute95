/** Estimated-usage billing decision (single call-site helper). */
import {
  isEstimatedUsage,
  isPartiallyEstimatedUsage,
  normalizeUsage,
  stripEstimatedPromptTokens,
  type UsageLike,
} from "./usageTracking.ts";

export { normalizeUsage };

/** Null when fully estimated (skip), cleaned copy when partial, untouched otherwise. */
export function selectBillingUsage(usage: UsageLike | null | undefined) {
  if (isEstimatedUsage(usage)) return null;
  if (isPartiallyEstimatedUsage(usage)) return stripEstimatedPromptTokens(usage);
  return usage;
}

/** Normalized billable cost input, or null when nothing to bill. */
export function billableCostUsage(
  responseUsage: UsageLike | null | undefined,
  normalize: (u: UsageLike) => UsageLike | null
): UsageLike | null {
  const billableUsage = selectBillingUsage(responseUsage);
  return billableUsage ? normalize(billableUsage) : null;
}

export { isEstimatedUsage };

/** Quota-share hook decision: skip the record only for fully estimated usage. */
export function shouldSkipQuotaShare(usage: unknown): boolean {
  return (
    !!usage && typeof usage === "object" && (usage as { estimated?: unknown }).estimated === true
  );
}
