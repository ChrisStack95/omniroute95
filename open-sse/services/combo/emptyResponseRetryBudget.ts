/** Shared by account retries and every combo dispatch within one client request. */
export const EMPTY_RESPONSE_ATTEMPT_LIMIT = 3;
export const EMPTY_RESPONSE_RETRY_EXHAUSTED = "empty_response_retry_exhausted";

export class EmptyResponseRetryBudget {
  private failures = new Map<string, number>();

  isExhausted(provider: string, model: string): boolean {
    return (
      (this.failures.get(JSON.stringify([provider, model])) ?? 0) >= EMPTY_RESPONSE_ATTEMPT_LIMIT
    );
  }

  recordFailure(
    provider: string,
    model: string,
    result: {
      status: number;
      errorCode?: string;
      error?: string;
    }
  ): boolean {
    if (
      result.status !== 502 ||
      !(
        result.errorCode === "empty_response" ||
        /returned (?:an empty response|empty content)/i.test(result.error ?? "")
      )
    )
      return false;
    const key = JSON.stringify([provider, model]);
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    return this.isExhausted(provider, model);
  }
}
