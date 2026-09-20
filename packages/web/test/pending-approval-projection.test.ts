import { describe, expect, it } from 'vitest'
import { createBackendTeamPanelModel } from '../src/panel-model.js'
import { createBackendTeamControlSurface } from '../src/control-surface.js'

describe('live approval projection', () => {
  it('shows migration approvals during development and keeps the inspect-before-confirm gate', async () => {
    const surface = await createBackendTeamControlSurface({
      events: { read: async () => [], subscribe: () => () => undefined },
      workspaceName: 'demo', workspaceId: 'ws', initialState: { phase: 'BUILD', stateRevision: 5 },
      approvals: { listPending: () => [{ id: 'migration-1', workspaceId: 'ws', stateRevision: 5, artifactHash: 'b'.repeat(64), request: { kind: 'migration', summary: 'Review SQL' } }], subscribe: () => () => undefined },
      coordinator: { dispatch: async () => ({ accepted: true, stateRevision: 5 }) }, authenticator: { authenticate: () => ({ sessionId: 'session-1234567890', workspaceId: 'ws', loopback: true, readOnly: false }) },
    })
    const model = createBackendTeamPanelModel(surface.service.getState(null))
    expect(model.approval).toMatchObject({ id: 'migration-1', summary: 'Review SQL', canConfirm: false })
    expect(model.approval?.viewAction).toMatchObject({ type: 'open-artifact', artifactId: 'b'.repeat(64) })
    await surface.dispose()
  })
  it('publishes live approvals without persisting them or projecting stale workspace/revision records', async () => {
    const listeners = new Set<() => void>()
    const request = { kind: 'requirements' as const, summary: 'Confirm requirements' }
    let pending = [{ id: 'approval-1', workspaceId: 'ws', stateRevision: 5, artifactHash: 'a'.repeat(64), request }]
    const surface = await createBackendTeamControlSurface({
      events: { read: async () => [], subscribe: () => () => undefined },
      workspaceName: 'demo', workspaceId: 'ws', initialState: { phase: 'AWAIT_REQUIREMENTS_APPROVAL', stateRevision: 5, approvalRetryAvailable: true },
      approvals: { listPending: () => pending, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
      coordinator: { dispatch: async () => ({ accepted: true, stateRevision: 5 }) }, authenticator: { authenticate: () => ({ sessionId: 'session-1234567890', workspaceId: 'ws', loopback: true, readOnly: false }) },
    })
    expect(surface.service.getState(null).pendingApproval).toMatchObject({ id: 'approval-1', summary: request.summary })
    const seen: unknown[] = []
    surface.subscriptions.subscribe('browser', state => { seen.push(state.pendingApproval) }, surface.projector.snapshot())
    pending = []; for (const listener of listeners) listener()
    await Promise.resolve()
    expect(surface.service.getState(null).pendingApproval).toBeUndefined()
    expect(seen.at(-1)).toBeUndefined()
    expect(createBackendTeamPanelModel(surface.projector.snapshot()).primaryAction).toMatchObject({ type: 'retry-failed-step', stepId: 'approval:requirements', enabled: true })
    pending = [{ id: 'foreign', workspaceId: 'other', stateRevision: 5, artifactHash: 'a'.repeat(64), request }]
    expect(surface.projector.snapshot().pendingApproval).toBeUndefined()
    pending = [{ id: 'stale', workspaceId: 'ws', stateRevision: 4, artifactHash: 'a'.repeat(64), request }]
    expect(surface.projector.snapshot().pendingApproval).toBeUndefined()
    await surface.dispose()
    expect(listeners.size).toBe(0)
  })
})
