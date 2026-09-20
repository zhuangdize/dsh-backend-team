import { describe, expect, it } from 'vitest'
import type { BackendTeamControlAction } from '../src/control-actions.js'
import type { CoordinatorControlContext } from '../src/coordinator-control-port.js'
import { createCoordinatorCommandHandlers, type CoordinatorCommandImplementations } from '../src/coordinator-command-handlers.js'

describe('createCoordinatorCommandHandlers', () => {
  it('routes typed actions and acknowledges the authoritative post-command revision', async () => {
    const calls: string[] = []
    let revision = 4
    const handlers = createCoordinatorCommandHandlers(implementations({
      currentRevision: () => revision,
      submitClarification: async (action) => { calls.push(`clarify:${action.text}`); revision = 5 },
    }))
    const action: BackendTeamControlAction = { type: 'submit-clarification', workspaceId: 'ws', expectedRevision: 4, text: 'add pagination' }

    await expect(handlers['submit-clarification'](action, context(4))).resolves.toEqual({ accepted: true, stateRevision: 5 })
    expect(calls).toEqual(['clarify:add pagination'])
  })

  it('fails closed before invoking a command when the authoritative revision is stale', async () => {
    let called = false
    const handlers = createCoordinatorCommandHandlers(implementations({
      currentRevision: () => 9,
      submitClarification: async () => { called = true },
    }))
    const action: BackendTeamControlAction = { type: 'submit-clarification', workspaceId: 'ws', expectedRevision: 4, text: 'clarify' }

    await expect(handlers['submit-clarification'](action, context(4))).rejects.toThrow(/stale.*revision/i)
    expect(called).toBe(false)
  })

  it('preserves a loopback GUI navigation returned by the explicit database port', async () => {
    const handlers = createCoordinatorCommandHandlers(implementations({
      openDatabaseGui: async () => ({ navigation: { kind: 'one-time-local-url', url: 'http://127.0.0.1:18080/', expiresAt: '2026-09-04T00:05:00.000Z' } }),
    }))
    const action: BackendTeamControlAction = { type: 'open-database-gui', workspaceId: 'ws', expectedRevision: 4 }

    await expect(handlers['open-database-gui'](action, context(4))).resolves.toMatchObject({ accepted: true, stateRevision: 4, navigation: { url: 'http://127.0.0.1:18080/' } })
  })

  it('accepts a bounded preview only when its hash is the open artifact id', async () => {
    const hash = 'a'.repeat(64)
    const handlers = createCoordinatorCommandHandlers(implementations({
      openArtifact: async () => ({ artifactPreview: { artifactHash: hash, files: [{ path: 'specs/demo/spec.md', content: '# Requirements' }] } }),
    }))
    const action: BackendTeamControlAction = { type: 'open-artifact', workspaceId: 'ws', expectedRevision: 4, artifactId: hash }
    await expect(handlers['open-artifact'](action, context(4))).resolves.toMatchObject({ artifactPreview: { artifactHash: hash } })
  })

  it('routes database snapshot actions through the revision fence', async () => {
    const calls: string[] = []
    const handlers = createCoordinatorCommandHandlers(implementations({
      createDatabaseSnapshot: async action => { calls.push(`create:${action.kind ?? 'data'}:${action.reason ?? ''}`) },
      restoreDatabaseSnapshot: async action => { calls.push(`restore:${action.snapshotId}:${action.targetDatabase}`) },
    }))
    await expect(handlers['create-database-snapshot']!({ type: 'create-database-snapshot', workspaceId: 'ws', expectedRevision: 4, reason: 'before migration', kind: 'data' }, context(4))).resolves.toEqual({ accepted: true, stateRevision: 4 })
    await expect(handlers['restore-database-snapshot']!({ type: 'restore-database-snapshot', workspaceId: 'ws', expectedRevision: 4, snapshotId: `20260914T000000Z-p_demo_dev-${'a'.repeat(8)}`, targetDatabase: 'p_restore' }, context(4))).resolves.toEqual({ accepted: true, stateRevision: 4 })
    expect(calls).toEqual(['create:data:before migration', `restore:20260914T000000Z-p_demo_dev-${'a'.repeat(8)}:p_restore`])
  })

  it('rejects a preview returned by a non open-artifact command', async () => {
    const hash = 'a'.repeat(64)
    const handlers = createCoordinatorCommandHandlers(implementations({
      pauseRun: async () => ({ artifactPreview: { artifactHash: hash, files: [{ path: 'specs/demo/spec.md', content: 'x' }] } }),
    }))
    const action: BackendTeamControlAction = { type: 'pause-run', workspaceId: 'ws', expectedRevision: 4 }
    await expect(handlers['pause-run'](action, context(4))).rejects.toThrow(/invalid effect/i)
  })
})

function context(expectedRevision: number): CoordinatorControlContext {
  return { workspaceId: 'ws', expectedRevision, authenticatedSessionId: 'session-1234567890' }
}

function implementations(overrides: Partial<CoordinatorCommandImplementations> = {}): CoordinatorCommandImplementations {
  const callback = async () => undefined
  return {
    currentRevision: () => 4,
    submitClarification: callback,
    decideApproval: callback,
    pauseRun: callback,
    resumeRun: callback,
    retryFailedStep: callback,
    openArtifact: callback,
    startDatabase: callback,
    stopDatabase: callback,
    openDatabaseGui: callback,
    ...overrides,
  }
}
