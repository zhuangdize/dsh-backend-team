import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HandoffStore } from '@dsh-backend-team/agent-team'
import { describe, expect, it } from 'vitest'
import { DevelopmentCoordinator } from '../../packages/development/src/development-coordinator.js'
import type { DevelopmentPlan } from '../../packages/development/src/vertical-slice.js'
import { createProductionComposition } from '../../packages/core/src/production-composition.js'

const hash = 'a'.repeat(64)
const plan: DevelopmentPlan = {
  requirements: ['AC-001'], artifactHashes: { 'spec.md': hash }, trace: { requirements: { 'AC-001': { taskIds: ['T-001'], sliceIds: ['S-001', 'S-002'], evidenceIds: ['tests'] } } }, tasks: [],
  slices: [
    { id: 'S-001', taskIds: ['T-001'], layers: ['contract'], requirementIds: ['AC-001'], inputs: {}, expectedPaths: ['src/one.ts'], apiOperations: [], dataChanges: [], testEvidence: ['tests'], dependencies: [], rollbackBoundary: 'slice:S-001', completionConditions: ['tests pass'] },
    { id: 'S-002', taskIds: ['T-002'], layers: ['domain'], requirementIds: ['AC-001'], inputs: {}, expectedPaths: ['src/two.ts'], apiOperations: [], dataChanges: [], testEvidence: ['tests'], dependencies: ['S-001'], rollbackBoundary: 'slice:S-002', completionConditions: ['tests pass'] },
  ],
}

describe('development recovery', () => {
  it('recovers after a persisted tester failure through the real production coordinator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'production-development-recovery-'))
    let blocked = true
    const taskIds: string[] = []
    const composition = await createProductionComposition({
      workspaceRoot: root, recoveryToken: 'production-recovery-test-token', currentArtifactHashes: plan.artifactHashes,
      policyEngine: { authorize: async () => ({ effect: 'allow', reason: 'isolated fixture', ruleId: 'fixture' }) },
      agents: { verifiedProvenance: true, spawnAgent: async request => {
        const task = request.agentTask!
        taskIds.push(task.id)
        const fail = blocked && task.role === 'tester' && task.objective.includes('S-002')
        return { id: task.id, cancel: async () => {}, result: async () => ({
          taskId: task.id, status: fail ? 'blocked' : 'passed', summary: fail ? 'permission denied' : 'fixture verified',
          changedPaths: [], commands: [{ argv: ['fixture-test'], exitCode: fail ? 1 : 0 }], evidencePaths: [], risks: [], unresolvedItems: [],
          consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0, children: 0 }, childResultIds: [],
          verification: { status: fail ? 'failed' : 'passed', verifiedBy: 'expert', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'slice-tests', outcome: fail ? 'failed' : 'passed', evidencePaths: [] }] },
        }) }
      } },
    })
    try {
      await composition.stateStore.transact(0, state => ({ ...state, phase: 'BUILD', approvals: [{ kind: 'design', artifactHashes: plan.artifactHashes, approvedAt: '2026-01-01T00:00:00.000Z', tokenId: 'fixture-design-token' }] }))
      const coordinator = new DevelopmentCoordinator({
        handoffStore: new HandoffStore(root), teamCoordinator: composition.coordinator,
        approvals: { verifyActiveApproval: async () => {} }, patchTracker: { begin: async () => {} },
      })
      const first = await coordinator.execute(plan)
      expect(first.status, JSON.stringify(first)).toBe('blocked')
      expect(first.slices[1]?.handoffs).toHaveLength(2)
      blocked = false
      const resumed = await coordinator.resume(plan, first.checkpoint)
      expect(resumed.status).toBe('passed')
      expect(taskIds).toHaveLength(6)
      expect(new Set(taskIds).size).toBe(6)
      await expect(coordinator.resume(plan, resumed.checkpoint)).resolves.toMatchObject({ status: 'passed' })
      expect(taskIds).toHaveLength(6)
    } finally { await composition.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('resumes from persisted accepted evidence without rerunning the verified slice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'development-recovery-'))
    try {
      const store = new HandoffStore(root)
      const roles: string[] = []
      let blocked = true
      let counter = 0
      const coordinator = new DevelopmentCoordinator({
        handoffStore: store, approvals: { verifyActiveApproval: async () => {} }, patchTracker: { begin: async () => ({}) },
        teamCoordinator: { dispatchExpert: async input => {
          if (blocked && input.role === 'tester' && input.objective.includes('S-002')) throw new Error('permission denied')
          roles.push(input.objective)
          const id = 'handoff-' + input.id
          if (store.exists(id)) throw new Error('expert task ID is already in use')
          counter++
          store.write({ id, taskId: input.id, status: 'completed', summary: 'verified fixture', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [], consumedBudget: { tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0 }, childResultIds: [], parentVerification: { status: 'pending' } }, 'parent')
          return store.acknowledge(id, 'parent')
        } },
      })
      const interrupted = await coordinator.execute(plan)
      expect(interrupted.status).toBe('blocked')
      const before = roles.length
      blocked = false
      const resumed = await coordinator.resume(plan, interrupted.checkpoint)
      expect(resumed.status).toBe('passed')
      expect(resumed.checkpoint.slices.map(slice => slice.sliceId)).toEqual(['S-001', 'S-002'])
      expect(roles.slice(before).every(role => role.includes('S-002'))).toBe(true)
      expect(counter).toBe(5)
      const completed = roles.length
      await coordinator.resume(plan, resumed.checkpoint)
      expect(roles).toHaveLength(completed)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
