import { describe, expect, it } from 'vitest'
import { BackendTeamViewProjector } from '../src/index.js'
import type { BackendTeamEvent } from '@dsh-backend-team/contracts'

const at = '2026-08-28T00:00:00.000Z'
const event1: BackendTeamEvent = { id: 'event-1', sequence: 1, occurredAt: at, type: 'phase-changed', revision: 1, phase: 'SPECIFY' }
const event2: BackendTeamEvent = { id: 'event-2', sequence: 2, occurredAt: at, type: 'run-recorded', revision: 2, run: { id: 'run-1', status: 'running', startedAt: at, completedAt: null, summary: '需求澄清' } }

describe('BackendTeamViewProjector', () => {
  it('projects duplicate and out-of-order events idempotently', () => {
    const result = new BackendTeamViewProjector({ workspaceName: 'demo' }).replay([event2, event1, event2])
    expect(result.lastSequence).toBe(2); expect(result.appliedEventIds).toEqual(['event-1', 'event-2']); expect(result.state.phase).toBe('SPECIFY')
  })
  it('rejects conflicting sequence ownership', () => {
    const conflict: BackendTeamEvent = { ...event1, id: 'event-other', sequence: 1 }
    expect(() => new BackendTeamViewProjector({ workspaceName: 'demo' }).replay([event1, conflict])).toThrow(/conflicting event sequence/)
  })
  it('clears the matching pending approval when an approval is recorded', () => {
    const hash = 'a'.repeat(64)
    const approval: BackendTeamEvent = {
      id: 'event-approval', sequence: 3, occurredAt: at, type: 'approval-recorded', revision: 3,
      approval: { kind: 'requirements', artifactHashes: { 'spec.md': hash }, approvedAt: at, tokenId: 'token-1234567890' },
    }
    const projector = new BackendTeamViewProjector({ workspaceName: 'demo', initialState: { pendingApproval: { id: 'approval-1', kind: 'requirements', summary: '确认需求', artifactHash: hash } } })
    expect(projector.replay([approval]).state.pendingApproval).toBeUndefined()
  })
  it('projects a new approval into history with its source and document hashes', () => {
    const hash = 'a'.repeat(64)
    const approval: BackendTeamEvent = {
      id: 'event-approval-provenance', sequence: 3, occurredAt: at, type: 'approval-recorded', revision: 3,
      approval: { kind: 'requirements', artifactHashes: { 'spec.md': hash }, approvedAt: at, tokenId: 'token-1234567890', provenance: { sessionId: 'session-approval-123456' , taskId: '11111111-1111-4111-8111-111111111111' } },
    }
    const projector = new BackendTeamViewProjector({ workspaceName: 'demo' })
    expect(projector.replay([approval]).state.approvalHistory).toEqual([{ kind: 'requirements', approvedAt: at, artifactHashes: { 'spec.md': hash }, provenance: { status: 'verified', sessionId: 'session-approval-123456', taskId: '11111111-1111-4111-8111-111111111111' } }])
  })
  it('replaces the current gate record instead of duplicating it on a later approval', () => {
    const first: BackendTeamEvent = { id: 'event-approval-first', sequence: 1, occurredAt: at, type: 'approval-recorded', revision: 1, approval: { kind: 'design', artifactHashes: { 'plan.md': 'a'.repeat(64) }, approvedAt: at, tokenId: 'token-first-123456' } }
    const second: BackendTeamEvent = { id: 'event-approval-second', sequence: 2, occurredAt: '2026-08-28T00:01:00.000Z', type: 'approval-recorded', revision: 2, approval: { kind: 'design', artifactHashes: { 'plan.md': 'b'.repeat(64) }, approvedAt: '2026-08-28T00:01:00.000Z', tokenId: 'token-second-123456', provenance: { sessionId: 'session-approval-123456' } } }
    const projector = new BackendTeamViewProjector({ workspaceName: 'demo' })
    const history = projector.replay([first, second]).state.approvalHistory
    expect(history).toHaveLength(1)
    expect(history?.[0]).toMatchObject({ kind: 'design', artifactHashes: { 'plan.md': 'b'.repeat(64) }, provenance: { status: 'verified', sessionId: 'session-approval-123456' } })
  })
  it('does not regress the projection when a late lower-sequence event arrives', () => {
    const projector = new BackendTeamViewProjector({ workspaceName: 'demo' })
    projector.replay([event2])
    const result = projector.replay([event1])
    expect(result.lastSequence).toBe(2)
    expect(result.appliedEventIds).toEqual([])
    expect(result.state.phase).toBe('DISCOVER')
  })
})
