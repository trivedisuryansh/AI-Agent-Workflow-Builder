/**
 * Retry with exponential backoff for external calls.
 *
 * Policy: retry transient failures (network error, timeout, HTTP 5xx, 408, 429)
 * and never retry failures that cannot possibly succeed on a second attempt
 * (4xx other than 408/429, malformed step config, unparseable provider
 * response). Burning a retry on a 401 just doubles the latency of a guaranteed
 * failure, and for a 400 it can double a side effect.
 *
 * Attempt bookkeeping is reported through onAttempt so the caller can persist
 * step_runs.attempt_count after every try, including the ones that failed.
 */

import { StepError } from '../types.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface AttemptInfo {
  attempt: number;
  error?: Error;
  willRetry: boolean;
  delayMs: number;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** True when a second attempt has a plausible chance of a different outcome. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof StepError) return !err.permanent;
  // Unknown throw sites (bugs, network stack errors) get one more chance.
  return true;
}

/**
 * Full jitter backoff: delay = random(0, base * 2^(attempt-1)).
 * Jitter matters because a workflow may fan several steps at an API at once;
 * synchronized retries would reproduce the same burst that caused the failure.
 */
export function backoffDelay(attempt: number, baseDelayMs: number, rng = Math.random): number {
  const ceiling = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(Math.floor(rng() * ceiling), 30_000);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  onAttempt?: (info: AttemptInfo) => Promise<void> | void,
  rng: () => number = Math.random,
): Promise<T> {
  const maxAttempts = Math.max(1, policy.maxAttempts);
  let lastError: Error = new Error('retry loop did not execute');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn(attempt);
      await onAttempt?.({ attempt, willRetry: false, delayMs: 0 });
      return value;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const canRetry = attempt < maxAttempts && isRetryable(lastError);
      const delayMs = canRetry ? backoffDelay(attempt, policy.baseDelayMs, rng) : 0;

      await onAttempt?.({ attempt, error: lastError, willRetry: canRetry, delayMs });

      if (!canRetry) break;
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export function resolvePolicy(
  stepConfig: { max_attempts?: number; base_delay_ms?: number } | undefined,
  defaults: RetryPolicy,
): RetryPolicy {
  return {
    maxAttempts: Math.max(1, stepConfig?.max_attempts ?? defaults.maxAttempts),
    baseDelayMs: Math.max(0, stepConfig?.base_delay_ms ?? defaults.baseDelayMs),
  };
}
