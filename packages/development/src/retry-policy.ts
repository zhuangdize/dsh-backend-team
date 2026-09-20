import type { ClassifiedFailure } from './failure-classifier.js'

export type RetryAction = 'retry' | 'repair' | 'stop'

export interface RetryDecision {
  readonly action: RetryAction
  readonly attempt: number
  readonly delayMs: number
  readonly reason: string
}

/** Bounded policy: at most two transient retries, with repair reserved for code/test failures. */
export class RetryPolicy {
  constructor(private readonly maxRetries = 2, private readonly backoffMs = 25) {
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) throw new Error('retry limit must be between zero and two')
    if (!Number.isInteger(backoffMs) || backoffMs < 0) throw new Error('retry backoff must be non-negative')
  }

  decide(failure: ClassifiedFailure, attempt: number): RetryDecision {
    if (!Number.isInteger(attempt) || attempt < 0) throw new Error('retry attempt is invalid')
    if (failure.category === 'test-assertion' || failure.category === 'code-compile') {
      return attempt < this.maxRetries ? { action: 'repair', attempt: attempt + 1, delayMs: 0, reason: `repair ${failure.category}` } : { action: 'stop', attempt, delayMs: 0, reason: 'repair limit reached' }
    }
    if (failure.recoverable && attempt < this.maxRetries) return { action: 'retry', attempt: attempt + 1, delayMs: this.backoffMs * (attempt + 1), reason: `retry ${failure.category}` }
    return { action: 'stop', attempt, delayMs: 0, reason: `stop on ${failure.category}` }
  }
}
