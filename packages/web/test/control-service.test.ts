import { describe, expect, it } from 'vitest'
import { AuthenticatedLocalSessionSchema, BackendTeamControlService, BackendTeamViewProjector } from '../src/index.js'
import type { CoordinatorControlPort, LocalSessionAuthenticator } from '../src/index.js'

const session = { sessionId: 'session-1234567890', workspaceId: 'ws', loopback: true as const, readOnly: false }
const authenticator: LocalSessionAuthenticator = { authenticate: (input) => AuthenticatedLocalSessionSchema.parse(input) }
describe('BackendTeamControlService', () => {
  it('rejects new reads and dispatches once closeAndDrain begins', async () => {
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo' }), { dispatch: async () => ({ accepted: true, stateRevision: 0 }) }, authenticator)
    const drain = service.closeAndDrain()

    expect(() => service.getState(session)).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }))
    await expect(service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 0 })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(drain).resolves.toBeUndefined()
  })

  it('drains an in-flight handler before closeAndDrain resolves', async () => {
    let releaseHandler!: () => void
    let handlerStartedResolve!: () => void
    const handlerStarted = new Promise<void>((resolve) => { handlerStartedResolve = resolve })
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve })
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo' }), {
      dispatch: async () => {
        handlerStartedResolve()
        await handlerGate
        return { accepted: true as const, stateRevision: 1 }
      },
    }, authenticator)
    const dispatch = service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 0 })
    await handlerStarted
    const drain = service.closeAndDrain()
    let drained = false
    void drain.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)

    releaseHandler()
    await expect(dispatch).resolves.toMatchObject({ accepted: true })
    await expect(drain).resolves.toBeUndefined()
  })

  it('drains a failing in-flight handler as well', async () => {
    let releaseHandler!: () => void
    let handlerStartedResolve!: () => void
    const handlerStarted = new Promise<void>((resolve) => { handlerStartedResolve = resolve })
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve })
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo' }), {
      dispatch: async () => {
        handlerStartedResolve()
        await handlerGate
        throw new Error('handler failed')
      },
    }, authenticator)
    const dispatch = service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 0 }).catch((error: unknown) => error)
    await handlerStarted
    const drain = service.closeAndDrain()
    releaseHandler()
    await expect(dispatch).resolves.toMatchObject({ message: 'handler failed' })
    await expect(drain).resolves.toBeUndefined()
  })

  it('does not self-deadlock when the active handler initiates the drain', async () => {
    const coordinator = {
      dispatch: async () => {
        await service.closeAndDrain()
        return { accepted: true as const, stateRevision: 1 }
      },
    }
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo' }), coordinator, authenticator)

    await expect(service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 0 })).resolves.toMatchObject({ accepted: true })
  })

  it('rejects cross-workspace state reads when the surface declares its workspace', () => {
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo', workspaceId: 'surface-ws' }), { dispatch: async () => ({ accepted: true, stateRevision: 0 }) }, authenticator)
    expect(() => service.getState({ ...session, workspaceId: 'other-ws' })).toThrowError(expect.objectContaining({ code: 'WORKSPACE_MISMATCH' }))
  })

  it('rejects cross-workspace dispatch against the current surface workspace', async () => {
    let called = false
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo', workspaceId: 'surface-ws' }), { dispatch: async () => { called = true; return { accepted: true, stateRevision: 0 } } }, authenticator)
    await expect(service.dispatch({ ...session, workspaceId: 'other-ws' }, { type: 'pause-run', workspaceId: 'other-ws', expectedRevision: 0 })).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
    expect(called).toBe(false)
  })

  it('enforces a read-only surface compatibility mode for mutation dispatch', async () => {
    let called = false
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo', workspaceId: 'ws', compatibility: { mode: 'read-only', reason: 'host seam unavailable' } }), { dispatch: async () => { called = true; return { accepted: true, stateRevision: 0 } } }, authenticator)
    await expect(service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 0 })).rejects.toMatchObject({ code: 'READ_ONLY' })
    expect(called).toBe(false)
  })

  it('rejects stale browser projections before coordinator dispatch', async () => { let called = false; const coordinator: CoordinatorControlPort = { dispatch: async () => { called = true; return { accepted: true, stateRevision: 2 } } }; const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo', initialState: { stateRevision: 5 } }), coordinator, authenticator); await expect(service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 4 })).rejects.toMatchObject({ code: 'STALE_VIEW', currentRevision: 5 }); expect(called).toBe(false) })
  it('uses the durable revision source when the event projection is behind it', async () => {
    let called = false
    const coordinator: CoordinatorControlPort = { dispatch: async (_action, context) => { called = true; return { accepted: true, stateRevision: context.expectedRevision } } }
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo', initialState: { stateRevision: 5 } }), coordinator, authenticator, () => 7)
    await expect(service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 7 })).resolves.toMatchObject({ accepted: true, stateRevision: 7 })
    expect(called).toBe(true)
    await expect(service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 6 })).rejects.toMatchObject({ code: 'STALE_VIEW', currentRevision: 7 })
  })
  it('allows state reads in read-only diagnostics but rejects mutation', async () => { const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo' }), { dispatch: async () => ({ accepted: true, stateRevision: 0 }) }, authenticator); expect(service.getState({ ...session, readOnly: true }).workspaceName).toBe('demo'); await expect(service.dispatch({ ...session, readOnly: true }, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 0 })).rejects.toMatchObject({ code: 'READ_ONLY' }) })
  it('does not treat the session schema as an authentication mechanism', () => {
    const rejectingAuthenticator: LocalSessionAuthenticator = { authenticate: () => { throw new Error('no trusted local session') } }
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo' }), { dispatch: async () => ({ accepted: true, stateRevision: 0 }) }, rejectingAuthenticator)
    expect(() => service.getState(session)).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
  })
  it('only permits credential-free loopback navigation for the database GUI action', async () => {
    const navigation = { kind: 'one-time-local-url' as const, url: 'http://127.0.0.1:8080/session', expiresAt: '2026-01-01T00:00:00.000Z' }
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo' }), { dispatch: async () => ({ accepted: true, stateRevision: 0, navigation }) }, authenticator)
    await expect(service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_NAVIGATION' })
    await expect(service.dispatch(session, { type: 'open-database-gui', workspaceId: 'ws', expectedRevision: 0 })).resolves.toMatchObject({ navigation })
  })
  it('rejects localhost aliases and URLs carrying credentials', async () => {
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo' }), { dispatch: async (_action, context) => ({ accepted: true, stateRevision: context.expectedRevision, navigation: { kind: 'one-time-local-url', url: context.authenticatedSessionId === 'session-localhost' ? 'http://localhost:8080/session' : 'http://user:pass@127.0.0.1:8080/session', expiresAt: '2026-01-01T00:00:00.000Z' } }) }, authenticator)
    await expect(service.dispatch({ ...session, sessionId: 'session-localhost' }, { type: 'open-database-gui', workspaceId: 'ws', expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_NAVIGATION' })
    await expect(service.dispatch(session, { type: 'open-database-gui', workspaceId: 'ws', expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_NAVIGATION' })
  })

  it('rejects an artifact preview attached to a non artifact command', async () => {
    const coordinator = {
      dispatch: async () => ({ accepted: true, stateRevision: 0, artifactPreview: { artifactHash: 'a'.repeat(64), files: [{ path: 'specs/demo/spec.md', content: 'x' }] } }),
    } as unknown as CoordinatorControlPort
    const service = new BackendTeamControlService(new BackendTeamViewProjector({ workspaceName: 'demo' }), coordinator, authenticator)
    await expect(service.dispatch(session, { type: 'pause-run', workspaceId: 'ws', expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_PREVIEW' })
  })
})
