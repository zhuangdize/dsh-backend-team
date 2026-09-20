import { describe, expect, it } from 'vitest'
import type { DevelopmentPlan } from '../src/vertical-slice.js'
import { DevelopmentCoordinator, developmentPlanHash } from '../src/development-coordinator.js'

const hash = 'a'.repeat(64)
const plan: DevelopmentPlan = {
  requirements: ['AC-001'],
  artifactHashes: { 'specs/feature.md': hash },
  trace: { requirements: { 'AC-001': { taskIds: ['T-001'], sliceIds: ['S-001'], evidenceIds: ['tests'] } } },
  tasks: [],
  slices: [{
    id: 'S-001', taskIds: ['T-001'], layers: ['contract'], requirementIds: ['AC-001'], inputs: {}, expectedPaths: ['src/orders.ts'],
    apiOperations: ['GET /orders'], dataChanges: [], testEvidence: ['tests'], dependencies: [], rollbackBoundary: 'slice:S-001', completionConditions: ['tests pass'],
  }],
}

describe('DevelopmentCoordinator', () => {
  it('refuses business writes when design approval is stale', async () => {
    let began = false
    const coordinator = new DevelopmentCoordinator({
      approvals: { verifyActiveApproval: async () => { throw new Error('approval is stale') } },
      patchTracker: { begin: async () => { began = true; throw new Error('must not begin') } },
      teamCoordinator: { dispatchExpert: async () => { throw new Error('must not dispatch') } },
    })

    await expect(coordinator.execute(plan)).rejects.toThrow('design approval is stale')
    expect(began).toBe(false)
  })

  it('hands a slice from developer to tester and records a passing slice', async () => {
    const roles: string[] = []
    const coordinator = new DevelopmentCoordinator({
      approvals: { verifyActiveApproval: async () => {} },
      patchTracker: { begin: async () => ({}) },
      teamCoordinator: {
        dispatchExpert: async (input) => {
          roles.push(input.role)
          return { parentVerification: { status: 'accepted' }, status: 'completed', taskId: input.id, id: `handoff-${input.id}` } as never
        },
      },
    })

    const result = await coordinator.execute(plan)
    expect(result.status).toBe('passed')
    expect(result.slices[0]?.status).toBe('passed')
    expect(roles).toEqual(['developer', 'tester'])
  })

  it('retries a transient dispatch failure and then completes the slice', async () => {
    let calls = 0
    const coordinator = new DevelopmentCoordinator({
      approvals: { verifyActiveApproval: async () => {} },
      patchTracker: { begin: async () => ({}) },
      teamCoordinator: {
        dispatchExpert: async (input) => {
          calls += 1
          if (calls === 1) throw new Error('network timeout')
          return { parentVerification: { status: 'accepted' }, status: 'completed', taskId: input.id, id: `handoff-${input.id}` } as never
        },
      },
    })

    await expect(coordinator.execute(plan)).resolves.toMatchObject({ status: 'passed' })
    expect(calls).toBe(3)
  })

  it('stops deterministically on a permission dispatch failure', async () => {
    const coordinator = new DevelopmentCoordinator({
      approvals: { verifyActiveApproval: async () => {} },
      patchTracker: { begin: async () => ({}) },
      teamCoordinator: { dispatchExpert: async () => { throw new Error('permission denied') } },
    })

    await expect(coordinator.execute(plan)).resolves.toMatchObject({ status: 'blocked', slices: [{ status: 'blocked' }] })
  })

  it('creates a separate fixer handoff for a failed test before retesting', async () => {
    const roles: string[] = []
    let testRuns = 0
    const coordinator = new DevelopmentCoordinator({
      approvals: { verifyActiveApproval: async () => {} },
      patchTracker: { begin: async () => ({}) },
      teamCoordinator: {
        dispatchExpert: async (input) => {
          roles.push(input.role)
          if (input.role === 'tester' && testRuns++ === 0) return { parentVerification: { status: 'needs-rework' }, status: 'failed', summary: 'test assertion failed', risks: [], taskId: input.id, id: `handoff-${input.id}` } as never
          return { parentVerification: { status: 'accepted' }, status: 'completed', summary: 'done', risks: [], taskId: input.id, id: `handoff-${input.id}` } as never
        },
      },
    })

    await expect(coordinator.execute(plan)).resolves.toMatchObject({ status: 'passed' })
    expect(roles).toEqual(['developer', 'tester', 'fixer', 'tester'])
  })

  it('resumes after an interruption without rerunning an accepted slice', async () => {
    const roles: string[] = []
    const planTwo = { ...plan, slices: [plan.slices[0]!, { ...plan.slices[0]!, id: 'S-002', taskIds: ['T-002'], dependencies: ['S-001'] }] }
    const handoffs = ['developer', 'tester'].map(role => ({ id: role + '-record', taskId: role + '-' + developmentPlanHash(planTwo) + '-S-001-0', status: 'completed', parentVerification: { status: 'accepted' }, acknowledgedBy: 'parent', acknowledgedAt: '2026-01-01T00:00:00.000Z' }))
    const coordinator = new DevelopmentCoordinator({
      handoffStore: { read: id => handoffs.find(record => record.id === id)! as never },
      approvals: { verifyActiveApproval: async () => {} },
      patchTracker: { begin: async () => ({}) },
      teamCoordinator: { dispatchExpert: async (input) => { roles.push(input.role); return { parentVerification: { status: 'accepted' }, status: 'completed', taskId: input.id, id: `handoff-${input.id}` } as never } },
    })
    const checkpoint = { planHash: developmentPlanHash(planTwo), slices: [{ sliceId: 'S-001', status: 'passed', attempts: 0, handoffs }] as never }
    const result = await coordinator.resume(planTwo, checkpoint)
    expect(result.status).toBe('passed')
    expect(result.checkpoint.slices.map(slice => slice.sliceId)).toEqual(['S-001', 'S-002'])
    expect(roles).toEqual(['developer', 'tester'])
  })
})
