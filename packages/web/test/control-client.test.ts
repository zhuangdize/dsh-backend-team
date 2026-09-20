import { describe, expect, it, vi } from 'vitest'
import type { BackendTeamControlAction } from '../src/control-actions.js'
import { createBackendTeamControlClient } from '../src/control-client.js'
import { BackendTeamViewProjector, type BackendTeamViewState } from '../src/view-model.js'

const workspaceId = '/workspace/demo'
const artifactHash = 'a'.repeat(64)

describe('Backend Team browser control client', () => {
  it('accepts live pause transitions without permitting durable phase changes at the same revision', () => {
    const client = createBackendTeamControlClient({ workspaceId, transport: fakeTransport({ state: baseState() }) })
    const state = { ...baseState(), phase: 'BUILD' as const }
    client.applySnapshot({ ...state, developmentRun: { status: 'running' } })
    client.applySnapshot({ ...state, developmentRun: { status: 'pausing' } })
    expect(client.model()?.primaryAction.enabled).toBe(false)
    client.applySnapshot({ ...state, developmentRun: { status: 'paused' } })
    expect(client.model()?.primaryAction.type).toBe('resume-run')
    expect(() => client.applySnapshot({ ...state, phase: 'DELIVER', developmentRun: { status: 'passed' } })).toThrow()
  })
  it('parses the host state and derives the plain-language panel model', async () => {
    const transport = fakeTransport({ state: baseState() })
    const client = createBackendTeamControlClient({ workspaceId, transport })

    await expect(client.refresh()).resolves.toMatchObject({ workspaceName: 'demo', phase: 'DISCOVER' })
    expect(client.model()).toMatchObject({ title: 'demo', phase: { label: '了解需求' } })
  })

  it('accepts live approval changes at the same durable revision while rejecting changed durable fields', () => {
    const client = createBackendTeamControlClient({ workspaceId, transport: fakeTransport({ state: baseState() }) })
    const state = { ...baseState(), phase: 'AWAIT_REQUIREMENTS_APPROVAL' as const }
    client.applySnapshot(state)
    client.applySnapshot({ ...state, pendingApproval: { id: 'approval-1', kind: 'requirements', summary: 'confirm', artifactHash } })
    expect(client.inspectApproval().canConfirm).toBe(true)
    client.applySnapshot({ ...state, pendingApproval: { id: 'approval-2', kind: 'requirements', summary: 'confirm', artifactHash } })
    expect(client.model()?.approval?.canConfirm).toBe(false)
    client.applySnapshot(state)
    expect(client.model()?.approval).toBeUndefined()
    expect(() => client.applySnapshot({ ...state, phase: 'DESIGN' })).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))
  })

  it('accepts only monotonic pushed snapshots and keeps the newest state', async () => {
    const client = createBackendTeamControlClient({ workspaceId, transport: fakeTransport({ state: baseState() }) })
    const first = client.applySnapshot({ ...baseState(), lastSequence: 2, stateRevision: 2, phase: 'PLAN' })
    expect(first).toMatchObject({ phase: 'PLAN', lastSequence: 2 })
    expect(() => client.applySnapshot({ ...baseState(), lastSequence: 1, stateRevision: 1, phase: 'SPECIFY' })).toThrowError(expect.objectContaining({ code: 'STALE_SNAPSHOT', currentRevision: 2 }))
    expect(client.snapshot()).toMatchObject({ phase: 'PLAN', lastSequence: 2, stateRevision: 2 })
  })

  it('rejects stale commands before invoking the host transport', async () => {
    const dispatch = vi.fn(async () => ({ accepted: true, stateRevision: 4 }))
    const client = createBackendTeamControlClient({ workspaceId, transport: fakeTransport({ state: baseState(), dispatch }) })
    await client.refresh()

    await expect(client.dispatch({ type: 'pause-run', workspaceId, expectedRevision: 4 })).rejects.toMatchObject({ code: 'STALE_VIEW', currentRevision: 0 })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('requires inspecting the current approval before sending a decision', async () => {
    const dispatch = vi.fn(async () => ({ accepted: true, stateRevision: 1 }))
    const state = { ...baseState(), pendingApproval: { id: 'approval-1', kind: 'requirements' as const, summary: '确认需求', artifactHash } }
    const client = createBackendTeamControlClient({ workspaceId, transport: fakeTransport({ state, dispatch }) })
    await client.refresh()

    const decision = { type: 'decide-approval' as const, workspaceId, expectedRevision: 0, approvalId: 'approval-1', decision: 'approve' as const, artifactHash }
    await expect(client.dispatch(decision)).rejects.toMatchObject({ code: 'APPROVAL_NOT_INSPECTED' })
    expect(dispatch).not.toHaveBeenCalled()

    expect(client.inspectApproval()).toMatchObject({ viewed: true, canConfirm: true })
    expect(client.model()?.approval).toMatchObject({ viewed: true, canConfirm: true, confirmAction: { enabled: true } })
    await expect(client.dispatch(decision)).resolves.toMatchObject({ response: { accepted: true }, state: { stateRevision: 1 } })
    expect(dispatch).toHaveBeenCalledWith(decision)
  })

  it('fails closed on an invalid host response', async () => {
    const client = createBackendTeamControlClient({ workspaceId, transport: fakeTransport({ state: baseState(), dispatch: async () => ({ accepted: true, stateRevision: -1 }) }) })
    await client.refresh()

    await expect(client.dispatch({ type: 'pause-run', workspaceId, expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('accepts a text preview only for the current pending artifact', async () => {
    const state = { ...baseState(), pendingApproval: { id: 'approval-1', kind: 'requirements' as const, summary: '确认需求', artifactHash } }
    const client = createBackendTeamControlClient({ workspaceId, transport: fakeTransport({ state, dispatch: async () => ({ accepted: true, stateRevision: 0, artifactPreview: { artifactHash, files: [{ path: 'specs/demo/spec.md', content: '# Requirements' }] } }) }) })
    await client.refresh()
    await expect(client.dispatch({ type: 'open-artifact', workspaceId, expectedRevision: 0, artifactId: artifactHash })).resolves.toMatchObject({ response: { artifactPreview: { artifactHash, files: [{ content: '# Requirements' }] } } })
  })

  it('rejects a preview returned for a non open-artifact action', async () => {
    const client = createBackendTeamControlClient({ workspaceId, transport: fakeTransport({ state: baseState(), dispatch: async () => ({ accepted: true, stateRevision: 0, artifactPreview: { artifactHash, files: [{ path: 'specs/demo/spec.md', content: 'x' }] } }) }) })
    await client.refresh()
    await expect(client.dispatch({ type: 'pause-run', workspaceId, expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('does not replace a successful command with an older refreshed projection', async () => {
    const client = createBackendTeamControlClient({
      workspaceId,
      transport: { getState: async () => baseState(), dispatch: async () => ({ accepted: true, stateRevision: 1 }) },
    })
    await client.refresh()

    await expect(client.dispatch({ type: 'pause-run', workspaceId, expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})

function baseState(): BackendTeamViewState {
  return new BackendTeamViewProjector({ workspaceName: 'demo' }).snapshot()
}

function fakeTransport(input: { state: BackendTeamViewState; dispatch?: (action: BackendTeamControlAction) => Promise<unknown> }) {
  let currentState = input.state
  return {
    getState: async () => currentState,
    dispatch: async (action: BackendTeamControlAction) => {
      const result = await (input.dispatch ?? (async () => ({ accepted: true, stateRevision: currentState.stateRevision })))(action)
      if (typeof result === 'object' && result !== null && 'stateRevision' in result && typeof result.stateRevision === 'number' && result.stateRevision >= 0) currentState = { ...currentState, stateRevision: result.stateRevision }
      return result
    },
  }
}

it('accepts host database transitions at the same revision while rejecting phase changes', () => {
  const client = createBackendTeamControlClient({ workspaceId, transport: fakeTransport({ state: baseState() }) })
  const state = baseState(); client.applySnapshot(state)
  for (const runtime of ['stopped', 'starting', 'ready', 'stopped'] as const) {
    client.applySnapshot({ ...state, database: { ...state.database, runtime, controlsAvailable: true } })
    expect(client.model()?.database.runtime).toBe(runtime)
  }
  expect(() => client.applySnapshot({ ...state, phase: 'DELIVER' })).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }))
})
