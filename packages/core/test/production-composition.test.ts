import { access, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentHandle, AgentSpawnRequest, PolicyDecision, PolicyEngine } from '@dsh-backend-team/contracts'
import { OwnershipManager } from '@dsh-backend-team/agent-team/ownership-manager'
import { createProductionComposition } from '../src/production-composition.js'

describe('createProductionComposition', () => {
  it('creates workspace-local durable state and wires the production ports', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-composition-'))
    const composition = await createProductionComposition({
      workspaceRoot,
      recoveryToken: 'composition-test-recovery-token',
      agents: verifiedAgents(),
      policyEngine: allowingPolicy(),
    })

    expect(composition.layout.root).toBe(await realpath(workspaceRoot))
    expect(await composition.stateStore.load()).toMatchObject({
      schemaVersion: 1,
      phase: 'DISCOVER',
      workspaceRoot: await realpath(workspaceRoot),
    })
    expect(composition.actions.get('backend_team_status')).toBeDefined()

    await composition.stateStore.transact(0, (state) => ({ ...state, phase: 'SPECIFY' }))
    expect(await composition.events.read()).toEqual([
      expect.objectContaining({ type: 'phase-changed', revision: 1, phase: 'SPECIFY' }),
    ])

    await composition.events.emit({
      id: 'composition-event-1',
      sequence: 2,
      occurredAt: '2026-01-01T00:00:00.000Z',
      type: 'phase-changed',
      revision: 1,
      phase: 'SPECIFY',
    })
    const eventLog = await readFile(join(workspaceRoot, '.backend-team', 'events', 'events.jsonl'), 'utf8')
    expect(eventLog).toContain('composition-event-1')
  })

  it('is idempotent when two startup paths initialize the same workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-composition-race-'))
    const options = {
      workspaceRoot,
      recoveryToken: 'composition-race-recovery-token',
      agents: verifiedAgents(),
      policyEngine: allowingPolicy(),
    } as const

    const [first, second] = await Promise.all([
      createProductionComposition(options),
      createProductionComposition(options),
    ])

    expect(first.layout.root).toBe(second.layout.root)
    expect(await first.stateStore.load()).toMatchObject({ revision: 0, phase: 'DISCOVER' })
    expect(await second.stateStore.load()).toMatchObject({ revision: 0, phase: 'DISCOVER' })
  })

  it('rejects unverified Agent provenance before mutating the workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-composition-provenance-'))
    const unverified = { verifiedProvenance: false, spawnAgent: async () => ({ id: 'agent', result: async () => undefined, cancel: async () => {} }) }

    await expect(createProductionComposition({
      workspaceRoot,
      recoveryToken: 'composition-provenance-token',
      agents: unverified as never,
      policyEngine: allowingPolicy(),
    })).rejects.toThrow(/verified Agent provenance/i)
    await expect(access(join(workspaceRoot, '.backend-team'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('disposes active runtime state and pending approvals idempotently', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-composition-dispose-'))
    const composition = await createProductionComposition({
      workspaceRoot,
      recoveryToken: 'composition-dispose-token',
      agents: verifiedAgents(),
      policyEngine: allowingPolicy(),
    })
    const pending = composition.approvals.requestApproval({ kind: 'design', summary: 'review', artifactHashes: { 'architecture.md': 'b'.repeat(64) } }, { workspaceId: composition.layout.root, stateRevision: 0 })
    const first = composition.dispose()
    expect(composition.dispose()).toBe(first)

    await first
    await expect(pending).rejects.toMatchObject({ name: 'ApprovalPortClosedError' })
    expect(composition.scheduler.snapshot()).toMatchObject({ activeExperts: 0, activeWriters: 0, queued: 0 })
    await expect(composition.scheduler.submit({})).rejects.toThrow(/disposed/i)
    await expect(composition.approvals.requestApproval({ kind: 'design', summary: 'review', artifactHashes: { 'architecture.md': 'b'.repeat(64) } }, { workspaceId: composition.layout.root, stateRevision: 0 })).rejects.toMatchObject({ name: 'ApprovalPortClosedError' })
  })

  it('releases recovered ownership only while the composition is idle', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-composition-recovery-'))
    const recoveryToken = 'composition-recovery-token'
    const composition = await createProductionComposition({ workspaceRoot, recoveryToken, agents: verifiedAgents(), policyEngine: allowingPolicy() })
    try {
      const recovered = new OwnershipManager({ workspaceRoot, recoveryToken })
      recovered.acquire('interrupted-agent', ['src/recovered.ts'], 'write')
      expect(composition.recoverAbandonedOwnership()).toBe(1)
      expect(recovered.snapshot()).toEqual([])
    } finally { await composition.dispose() }
  })
})

function verifiedAgents(): { readonly verifiedProvenance: true; spawnAgent(request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle> } {
  return {
    verifiedProvenance: true,
    async spawnAgent() {
      return { id: 'agent', result: async () => undefined, cancel: async () => {} }
    },
  }
}

function allowingPolicy(): PolicyEngine {
  return { authorize: async (): Promise<PolicyDecision> => ({ effect: 'allow', reason: 'test', ruleId: 'test-allow' }) }
}
