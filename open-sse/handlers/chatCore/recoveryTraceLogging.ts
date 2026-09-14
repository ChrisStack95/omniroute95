import type { StreamRecoveryTrace } from "../../services/streamRecovery.ts";

/**
 * Format a stream-recovery trace as a single correlatable log line. The
 * continuation `attempt` is the join key with the `onContinue` line. Only
 * `latch` lines carry `orderFix` (the only transition the flag governs);
 * attempt/outcome lines never expose the ephemeral flag name.
 */
export function formatRecoveryTrace(trace: StreamRecoveryTrace): string {
  const parts = [`recovery trace attempt=${trace.attempt} kind=${trace.kind}`];
  if (trace.kind === "continue-attempt") {
    parts.push(`latch=${trace.latch ?? false}`);
  } else if (trace.kind === "continue-outcome") {
    if (trace.outcome) parts.push(`outcome=${trace.outcome}`);
    if (trace.suffixChars !== undefined) parts.push(`suffixChars=${trace.suffixChars}`);
    if (trace.overlapChars !== undefined) parts.push(`overlapChars=${trace.overlapChars}`);
    if (trace.refusedReason) parts.push(`refusedReason=${trace.refusedReason}`);
  } else {
    parts.push(`latchBefore=${trace.latchBefore ?? false}`);
    parts.push(`latchAfter=${trace.latchAfter ?? false}`);
    parts.push(`orderFix=${trace.orderFixOn}`);
  }
  return parts.join(" ");
}
