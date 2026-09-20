import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProductionWorkflowCommandImplementations } from '../../packages/bundle/src/production-workflow-commands.js'
import { createProductionComposition } from '../../packages/core/src/production-composition.js'
import { createBackendTeamControlSurface } from '../../packages/web/src/control-surface.js'
import { CoordinatorControlAdapter } from '../../packages/web/src/coordinator-control-port.js'
import { createCoordinatorCommandHandlers } from '../../packages/web/src/coordinator-command-handlers.js'

describe('live approval control integration', () => {
  it.each(['approve', 'reject'] as const)('projects the real request and acknowledges a %s decision with its actual revision', async (decision) => {
    const root = await mkdtemp(join(tmpdir(), 'live-approval-control-'))
    const composition = await createProductionComposition({
      workspaceRoot: root, recoveryToken: 'live-approval-control-recovery',
      agents: { verifiedProvenance: true, spawnAgent: async () => { throw new Error('model is not part of this integration fixture') } },
      policyEngine: { authorize: async () => ({ effect: 'deny', reason: 'no agent execution', ruleId: 'fixture' }) },
      specification: {
        commandLoader: { load: async () => { throw new Error('command execution is not part of fixture') } },
        artifactRegistry: { snapshot: async () => ({ featureDirectory: root, artifacts: [{ path: 'spec.md', sha256: 'a'.repeat(64) }] }) },
        artifactValidator: { validateForGate: async () => ({ valid: true }) },
      },
    })
    const unavailable = async () => { throw new Error('unavailable in approval fixture') }
    const session = { sessionId: 'live-approval-session-123', workspaceId: composition.layout.root, loopback: true as const, readOnly: false }
    const surface = await createBackendTeamControlSurface({
      events: composition.events, approvals: composition.approvals, workspaceName: 'approval', workspaceId: composition.layout.root,
      authenticator: { authenticate: () => session },
      coordinator: new CoordinatorControlAdapter(createCoordinatorCommandHandlers(createProductionWorkflowCommandImplementations(composition, {
        pauseRun: unavailable, resumeRun: unavailable, openArtifact: unavailable, startDatabase: unavailable, stopDatabase: unavailable, openDatabaseGui: unavailable,
      }) as Parameters<typeof createCoordinatorCommandHandlers>[0])),
    })
    try {
      await composition.stateStore.transact(0, state => ({ ...state, phase: 'AWAIT_REQUIREMENTS_APPROVAL' }))
      let ready!: () => void
      const requested = new Promise<void>(resolve => { ready = resolve })
      const remove = composition.approvals.subscribe(() => { if (composition.approvals.listPending().length) ready() })
      const awaiting = composition.approvalService!.requestRequirementsApproval().catch((error: unknown) => error)
      await requested
      remove()
      const view = surface.service.getState(null)
      expect(view.pendingApproval).toMatchObject({ kind: 'requirements', artifactHash: 'a'.repeat(64) })
      const result = await surface.service.dispatch(null, { type: 'decide-approval', workspaceId: session.workspaceId, expectedRevision: view.stateRevision, approvalId: view.pendingApproval!.id, artifactHash: view.pendingApproval!.artifactHash, decision })
      expect(result).toEqual({ accepted: true, stateRevision: decision === 'approve' ? 2 : 1 })
      if (decision === 'reject') {
        expect(await awaiting).toBeInstanceOf(Error)
        expect(surface.service.getState(null)).toMatchObject({ phase: 'AWAIT_REQUIREMENTS_APPROVAL', stateRevision: 1, pendingApproval: undefined })
        expect((await composition.stateStore.load())?.approvals).toEqual([])
        return
      }
      await expect(awaiting).resolves.toMatchObject({ phase: 'DESIGN', revision: 2 })
      expect(surface.service.getState(null)).toMatchObject({ phase: 'DESIGN', stateRevision: 2, pendingApproval: undefined })
      expect((await composition.events.read()).some(event => event.type === 'approval-recorded')).toBe(true)
    } finally {
      await surface.dispose()
      await composition.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
