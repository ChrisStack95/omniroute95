/** Shared by account retries and every combo dispatch within one client request. */
export const EMPTY_RESPONSE_ATTEMPT_LIMIT = 3;
export const EMPTY_RESPONSE_RETRY_EXHAUSTED = "empty_response_retry_exhausted";

type EmptyResponseFailure = {
  status: number;
  errorCode?: string;
  error?: string;
};

/** Stable classification for structured errors and legacy call-log summaries. */
export function getEmptyResponseErrorCode(
  result: EmptyResponseFailure
): "empty_response" | typeof EMPTY_RESPONSE_RETRY_EXHAUSTED | null {
  if (result.status !== 502) return null;
  if (
    result.errorCode === "empty_response" ||
    result.errorCode === EMPTY_RESPONSE_RETRY_EXHAUSTED
  ) {
    return result.errorCode;
  }
  if (
    /returned empty output on \d+ attempts; stopping retries for this provider\/model/i.test(
      result.error ?? ""
    )
  ) {
    return EMPTY_RESPONSE_RETRY_EXHAUSTED;
  }
  return /empty content|an empty response/i.test(result.error ?? "") ? "empty_response" : null;
}

/** Empty output is a model failure, not evidence of a broken provider connection. */
export function isModelEmptyResponseFailure(result: EmptyResponseFailure): boolean {
  return getEmptyResponseErrorCode(result) !== null;
}

export class EmptyResponseRetryBudget {
  private failures = new Map<string, number>();

  isExhausted(provider: string, model: string): boolean {
    return (
      (this.failures.get(JSON.stringify([provider, model])) ?? 0) >= EMPTY_RESPONSE_ATTEMPT_LIMIT
    );
  }

  recordFailure(provider: string, model: string, result: EmptyResponseFailure): boolean {
    if (!isModelEmptyResponseFailure(result)) return false;
    const key = JSON.stringify([provider, model]);
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    return this.isExhausted(provider, model);
  }
}
