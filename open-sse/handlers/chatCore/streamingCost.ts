/**
 * chatCore streaming per-request cost recording (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's onStreamComplete: resolves the real per-request cost for a
 * completed streaming response and records it against the api key. onStreamComplete is synchronous,
 * so this is a sync fire-and-forget driven through calculateCost().then().catch() that never throws
 * to the caller. calculateCost and recordCost are injected so the hook stays decoupled. Behaviour
 * is byte-identical to the previous inline block.
 */

import {
  isEstimatedUsage,
  selectBillingUsage,
} from "../../utils/billingDecision.ts";

type CostResolver = (
  provider: string,
  model: string,
  usage: Record<string, number | undefined> | null | undefined,
  options: { serviceTier?: string }
) => Promise<number>;

export function recordStreamingCost(args: {
  apiKeyId: string | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  streamUsage: Record<string, unknown> | null | undefined;
  serviceTier?: string;
  calculateCost: CostResolver;
  recordCost: (apiKeyId: string, cost: number) => void;
}): void {
  if (!args.apiKeyId || !args.streamUsage) return;
  // Fully estimated usage is never billed; partially estimated usage bills
  // the real portion only (grafted input estimate excluded).
  if (isEstimatedUsage(args.streamUsage)) return;
  const billable = selectBillingUsage(args.streamUsage) as Record<
    string,
    number | undefined
  > | null;
  if (!billable) return;

  const apiKeyId = args.apiKeyId;
  args
    .calculateCost(args.provider, args.model, billable, { serviceTier: args.serviceTier })
    .then((estimatedCost) => {
      if (estimatedCost > 0) args.recordCost(apiKeyId, estimatedCost);
    })
    .catch(() => {});
}
