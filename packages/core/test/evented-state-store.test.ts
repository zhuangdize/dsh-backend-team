import type { BackendTeamState, StateStore } from '@dsh-backend-team/contracts'
import { describe, expect, it } from 'vitest'
import { EventedStateStore, MemoryPersistedEventStore, PersistedEventPort } from '../src/index.js'

describe('EventedStateStore', () => {
  it('publishes the new revision when verification changes without a phase change', async () => {
    const events = new PersistedEventPort('/workspace', new MemoryPersistedEventStore())
    const store = new EventedStateStore(memoryStore(initialState('VERIFY')), events)
    await store.transact(0, (state) => ({ ...state, finalVerification: {
      reportSha256: 'a'.repeat(64), delivery: { status: 'needs-attention', reportPath: '.backend-team/report.json', testStatus: 'passed', scope: 'tests', requirements: [], unresolvedItems: ['pending'] },
    } }))
    await expect(events.read()).resolves.toEqual([expect.objectContaining({ type: 'phase-changed', phase: 'VERIFY', revision: 1 })])
    await store.transact(1, (state) => { const next = { ...state }; delete next.finalVerification; return next })
    expect((await events.read()).at(-1)).toMatchObject({ type: 'phase-changed', phase: 'VERIFY', revision: 2 })
  })

  it('publishes a phase event after a committed phase change', async () => {
    const base = memoryStore(initialState('DISCOVER'))
    const events = new PersistedEventPort('/workspace', new MemoryPersistedEventStore())
    const store = new EventedStateStore(base, events)

    await store.transact(0, (state) => ({ ...state, phase: 'SPECIFY' }))

    await expect(events.read()).resolves.toEqual([
      expect.objectContaining({
        type: 'phase-changed',
        sequence: 1,
        revision: 1,
        phase: 'SPECIFY',
      }),
    ])
  })

  it('publishes newly recorded approvals without replaying unchanged approvals', async () => {
    const approval = {
      kind: 'requirements' as const,
      artifactHashes: { 'spec.md': 'a'.repeat(64) },
      approvedAt: '2026-01-01T00:00:00.000Z',
      tokenId: 'requirements-token',
    }
    const base = memoryStore(initialState('AWAIT_REQUIREMENTS_APPROVAL'))
    const events = new PersistedEventPort('/workspace', new MemoryPersistedEventStore())
    const store = new EventedStateStore(base, events)

    await store.transact(0, (state) => ({ ...state, phase: 'DESIGN', approvals: [approval] }))
    await store.transact(1, (state) => ({ ...state }))

    const persisted = await events.read()
    expect(persisted).toHaveLength(2)
    expect(persisted[0]).toMatchObject({ type: 'phase-changed', phase: 'DESIGN', revision: 1 })
    expect(persisted[1]).toMatchObject({ type: 'approval-recorded', approval, revision: 1 })
  })

  it('does not publish events when the revision fence rejects a stale writer', async () => {
    const base = memoryStore(initialState('DISCOVER'))
    const events = new PersistedEventPort('/workspace', new MemoryPersistedEventStore())
    const store = new EventedStateStore(base, events)

    await store.transact(0, (state) => ({ ...state, phase: 'SPECIFY' }))
    await expect(store.transact(0, (state) => ({ ...state, phase: 'DISCOVER' }))).rejects.toThrow(/revision/i)

    await expect(events.read()).resolves.toHaveLength(1)
  })

  it('publishes newly added and status-changed runs for the live projection', async () => {
    const run = {
      id: 'agent-1',
      status: 'running' as const,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      summary: 'Agent running',
    }
    const base = memoryStore(initialState('BUILD'))
    const events = new PersistedEventPort('/workspace', new MemoryPersistedEventStore())
    const store = new EventedStateStore(base, events)

    await store.transact(0, (state) => ({ ...state, runs: [run] }))
    await store.transact(1, (state) => ({
      ...state,
      runs: [{ ...run, status: 'interrupted', completedAt: '2026-01-01T00:00:01.000Z', summary: 'Agent interrupted' }],
    }))

    await expect(events.read()).resolves.toEqual([
      expect.objectContaining({ type: 'run-recorded', revision: 1, run }),
      expect.objectContaining({ type: 'run-recorded', revision: 2, run: { ...run, status: 'interrupted', completedAt: '2026-01-01T00:00:01.000Z', summary: 'Agent interrupted' } }),
    ])
  })
})

function memoryStore(initial: BackendTeamState): StateStore {
  let state: BackendTeamState | null = structuredClone(initial)
  return {
    load: async () => state === null ? null : structuredClone(state),
    create: async (next) => { if (state !== null) throw new Error('state already exists'); state = structuredClone(next) },
    transact: async (expectedRevision, change) => {
      if (state === null) throw new Error('state has not been created')
      if (state.revision !== expectedRevision) throw new Error(`revision conflict: ${state.revision}`)
      state = { ...change(structuredClone(state)), revision: state.revision + 1 }
      return structuredClone(state)
    },
  }
}

function initialState(phase: BackendTeamState['phase']): BackendTeamState {
  return { schemaVersion: 1, revision: 0, workspaceRoot: '/workspace', phase, runs: [], approvals: [], approvalTokens: [] }
}
