import { describe, expect, it } from 'vitest'
import { FailureClassifier } from '../src/failure-classifier.js'
import { RetryPolicy } from '../src/retry-policy.js'

describe('RetryPolicy', () => {
  const classifier = new FailureClassifier()
  const policy = new RetryPolicy()

  it.each([
    ['network-timeout', 'retry'],
    ['tool-busy', 'retry'],
    ['permission-denied', 'stop'],
    ['requirements-contradiction', 'stop'],
    ['migration-data-risk', 'stop'],
    ['test-assertion-failed', 'repair'],
  ] as const)('routes %s to %s', (failure, action) => {
    expect(policy.decide(classifier.classify(failure), 0).action).toBe(action)
  })

  it('stops after two recoverable attempts', () => {
    const failure = classifier.classify('network-timeout')
    expect(policy.decide(failure, 0)).toMatchObject({ action: 'retry', attempt: 1 })
    expect(policy.decide(failure, 1)).toMatchObject({ action: 'retry', attempt: 2 })
    expect(policy.decide(failure, 2)).toMatchObject({ action: 'stop', attempt: 2 })
  })
})
