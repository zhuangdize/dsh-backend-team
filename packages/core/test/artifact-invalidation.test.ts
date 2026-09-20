import type { BackendTeamState, RunRecord } from '@dsh-backend-team/contracts'
import { describe, expect, it } from 'vitest'
import { invalidateChangedArtifacts } from '../src/artifact-invalidation.js'

describe('invalidateChangedArtifacts', () => {
  it('returns to SPECIFY and removes requirements/design approvals and downstream runs', () => {
    const next = invalidateChangedArtifacts(approvedState(), ['specs/001-x/spec.md'])

    expect(next.phase).toBe('SPECIFY')
    expect(next.approvals.map(({ kind }) => kind)).toEqual(['install'])
    expect(next.runs.map((run) => run.kind)).toEqual(['requirements'])
  })

  it('returns to DESIGN and removes design approval and plan/build/verify runs', () => {
    const next = invalidateChangedArtifacts(approvedState(), ['specs/001-x/architecture.md'])

    expect(next.phase).toBe('DESIGN')
    expect(next.approvals.map(({ kind }) => kind)).toEqual(['requirements', 'install'])
    expect(next.runs.map((run) => run.kind)).toEqual(['requirements', 'design'])
  })

  it('returns to PLAN for tasks edits while retaining a valid design approval', () => {
    const next = invalidateChangedArtifacts(approvedState(), ['specs/001-x/tasks.md'])

    expect(next.phase).toBe('PLAN')
    expect(next.approvals.map(({ kind }) => kind)).toEqual(['requirements', 'design', 'install'])
    expect(next.runs.map((run) => run.kind)).toEqual(['requirements', 'design'])
  })

  it('chooses the earliest affected phase when several artifact groups changed', () => {
    expect(invalidateChangedArtifacts(approvedState(), ['specs/001-x/tasks.md', 'specs/001-x/spec.md']).phase).toBe('SPECIFY')
  })

  it('leaves state unchanged for unrelated files', () => {
    const state = approvedState()
    expect(invalidateChangedArtifacts(state, ['README.md'])).toEqual(state)
  })
})

type TestRun = RunRecord & { readonly kind: 'requirements' | 'design' | 'plan' | 'build' | 'verify' }

function approvedState(): BackendTeamState {
  const run = (kind: TestRun['kind']): TestRun => ({
    id: kind,
    kind,
    status: 'passed',
    startedAt: '2026-08-27T00:00:00.000Z',
    completedAt: '2026-08-27T00:01:00.000Z',
    summary: kind,
  })
  return {
    schemaVersion: 1,
    revision: 3,
    workspaceRoot: '/tmp/backend-team-invalidation-test',
    phase: 'VERIFY',
    runs: [run('requirements'), run('design'), run('plan'), run('build'), run('verify')] as unknown as BackendTeamState['runs'],
    approvals: [
      { kind: 'requirements', artifactHashes: { 'spec.md': 'a'.repeat(64) }, approvedAt: '2026-08-27T00:00:00.000Z', tokenId: 'requirements-token-1234' },
      { kind: 'design', artifactHashes: { 'architecture.md': 'b'.repeat(64) }, approvedAt: '2026-08-27T00:00:00.000Z', tokenId: 'design-token-123456' },
      { kind: 'install', artifactHashes: { runtime: 'c'.repeat(64) }, approvedAt: '2026-08-27T00:00:00.000Z', tokenId: 'install-token-123456' },
    ],
    approvalTokens: [],
  }
}
