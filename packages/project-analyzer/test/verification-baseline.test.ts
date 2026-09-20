import { describe, expect, it } from 'vitest'
import type { DetectedCommand } from '../src/index.js'
import { VerificationBaseline } from '../src/index.js'

const evidence = [{ kind: 'script', path: 'package.json', fact: 'declares a test script', excerptHash: 'a'.repeat(64) }] as const

function candidate(script: string, argv: readonly string[], purpose: DetectedCommand['purpose']): DetectedCommand {
  return { script, argv, purpose, status: 'unverified', evidence, conflicts: [] }
}

describe('VerificationBaseline', () => {
  it('retains exact candidate argv for every package manager and keeps unknown scripts approval-gated', () => {
    const plan = new VerificationBaseline([
      candidate('test:npm', ['npm', 'run', 'test:npm'], 'unit'),
      candidate('test:pnpm', ['pnpm', 'run', 'test:pnpm'], 'unit'),
      candidate('test:yarn', ['yarn', 'run', 'test:yarn'], 'unit'),
      candidate('test:bun', ['bun', 'run', 'test:bun'], 'unit'),
      candidate('deploy', ['npm', 'run', 'deploy'], 'unknown'),
    ]).plan()

    expect(plan.map((item) => item.argv)).toEqual([
      ['npm', 'run', 'test:npm'], ['pnpm', 'run', 'test:pnpm'], ['yarn', 'run', 'test:yarn'], ['bun', 'run', 'test:bun'], ['npm', 'run', 'deploy'],
    ])
    expect(plan.every((item) => item.status === 'unverified')).toBe(true)
    expect(plan.at(-1)).toMatchObject({ script: 'deploy', purpose: 'unknown', approvalRequired: true, risk: 'unknown' })
  })

  it('records externally supplied outcomes without executing or mutating the original candidate', () => {
    const baseline = new VerificationBaseline([candidate('typecheck', ['npm', 'run', 'typecheck'], 'typecheck')])
    const plan = baseline.plan()

    const recorded = baseline.record(plan, [{ script: 'typecheck', exitCode: 0, durationMs: 34 }])

    expect(recorded).toEqual([expect.objectContaining({ argv: ['npm', 'run', 'typecheck'], status: 'unverified', result: { exitCode: 0, durationMs: 34 } })])
    expect(plan).toEqual([expect.objectContaining({ argv: ['npm', 'run', 'typecheck'], status: 'unverified' })])
  })

  it('does not apply a script-only result to multiple workspace candidates with the same script name', () => {
    const workspaceEvidence = (path: string) => [{ kind: 'script' as const, path, fact: 'declares a test script', excerptHash: 'a'.repeat(64) }]
    const baseline = new VerificationBaseline([
      { ...candidate('test', ['npm', 'run', 'test'], 'unit'), evidence: workspaceEvidence('services/api/package.json') },
      { ...candidate('test', ['pnpm', 'run', 'test'], 'unit'), evidence: workspaceEvidence('apps/web/package.json') },
    ])
    const plan = baseline.plan()

    const ambiguous = baseline.record(plan, [{ script: 'test', exitCode: 0, durationMs: 1 }])
    const identified = baseline.record(plan, [{ candidateId: plan[0]?.candidateId ?? '', exitCode: 0, durationMs: 1 }])

    expect(new Set(plan.map((entry) => entry.candidateId)).size).toBe(2)
    expect(ambiguous.every((entry) => entry.result === undefined)).toBe(true)
    expect(identified).toEqual([
      expect.objectContaining({ candidateId: plan[0]?.candidateId, result: { exitCode: 0, durationMs: 1 } }),
      expect.objectContaining({ candidateId: plan[1]?.candidateId }),
    ])
    expect(identified[1]?.result).toBeUndefined()
  })

  it('requires approval for candidates carrying package-manager conflict evidence', () => {
    const plan = new VerificationBaseline([{ ...candidate('test', [], 'unit'), conflicts: evidence }]).plan()

    expect(plan).toEqual([expect.objectContaining({ approvalRequired: true, status: 'unverified' })])
  })
})
