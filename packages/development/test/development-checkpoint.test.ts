import { describe, expect, it } from 'vitest'
import { DevelopmentCoordinator, developmentPlanHash } from '../src/development-coordinator.js'
import { sliceTaskId } from '../src/slice-task-id.js'
import type { DevelopmentPlan } from '../src/vertical-slice.js'

const slice = { id: 'S1', taskIds: [], layers: [], requirementIds: [], inputs: {}, expectedPaths: ['src/a.ts'], apiOperations: [], dataChanges: [], testEvidence: ['tests'], dependencies: [], rollbackBoundary: 'slice', completionConditions: ['tests pass'] }
const plan: DevelopmentPlan = { slices: [slice], tasks: [], trace: { requirements: {} }, artifactHashes: { 'spec.md': 'a'.repeat(64) }, requirements: [] }
const passed = { sliceId: 'S1', status: 'passed' as const, attempts: 0, handoffs: [] }
function fixture() {
  let writes = 0
  const coordinator = new DevelopmentCoordinator({ approvals: { verifyActiveApproval: async () => undefined }, patchTracker: { begin: async () => { writes++ } }, teamCoordinator: { dispatchExpert: async () => { throw new Error('should not dispatch') } } })
  return { coordinator, writes: () => writes }
}
describe('development recovery checkpoint', () => {
  it('refuses a passed checkpoint without durable verification evidence', async () => {
    const { coordinator, writes } = fixture()
    await expect(coordinator.resume(plan, { planHash: developmentPlanHash(plan), slices: [passed] })).rejects.toThrow(/handoff|verification/i)
    expect(writes()).toBe(0)
  })
  it('refuses checkpoints created for a different plan before writing', async () => {
    const { coordinator, writes } = fixture()
    await expect(coordinator.resume({ ...plan, artifactHashes: { 'spec.md': 'b'.repeat(64) } }, { planHash: developmentPlanHash(plan), slices: [] })).rejects.toThrow(/plan/i)
    expect(writes()).toBe(0)
  })
  it('rejects old handoffs even when a checkpoint claims the new plan hash', async () => {
    const oldHash = developmentPlanHash(plan)
    const changed = { ...plan, artifactHashes: { 'spec.md': 'b'.repeat(64) } }
    const handoffs = ['developer', 'tester'].map(role => ({ id: role, taskId: role + '-' + oldHash + '-S1-0', status: 'completed', parentVerification: { status: 'accepted' }, acknowledgedBy: 'parent', acknowledgedAt: '2026-01-01T00:00:00.000Z' }))
    const coordinator = new DevelopmentCoordinator({
      handoffStore: { read: id => handoffs.find(record => record.id === id)! as never },
      approvals: { verifyActiveApproval: async () => undefined }, patchTracker: { begin: async () => { throw new Error('must not write') } }, teamCoordinator: { dispatchExpert: async () => { throw new Error('must not dispatch') } },
    })
    await expect(coordinator.resume(changed, { planHash: developmentPlanHash(changed), slices: [{ ...passed, handoffs: handoffs as never }] })).rejects.toThrow(/evidence/i)
  })

  it('rejects duplicate and out-of-order dependencies before writing any slice', async () => {
    const { coordinator, writes } = fixture()
    await expect(coordinator.execute({ ...plan, slices: [slice, slice] })).rejects.toThrow(/duplicate/i)
    await expect(coordinator.execute({ ...plan, slices: [{ ...slice, dependencies: ['missing'] }] })).rejects.toThrow(/dependenc/i)
    expect(writes()).toBe(0)
  })

  it('accepts tester-only checkpoint evidence when declared developer files are materialized', async () => {
    const recoverySlice = {
      ...slice,
      taskIds: ['T-developer', 'T-tester'],
      expectedPaths: ['packages/development/src/development-coordinator.ts', 'test/personnel-validation.test.mjs'],
    }
    const recoveryPlan: DevelopmentPlan = {
      ...plan,
      slices: [recoverySlice],
      tasks: [
        { id: 'T-developer', sliceId: 'S1', requirementIds: [], owner: 'developer', risk: 'standard', dependencies: [], layer: 'domain', evidence: ['tests'], files: ['packages/development/src/development-coordinator.ts'], objective: 'Keep the coordinator.' },
        { id: 'T-tester', sliceId: 'S1', requirementIds: [], owner: 'developer', risk: 'standard', dependencies: ['T-developer'], layer: 'test', evidence: ['tests'], files: ['test/personnel-validation.test.mjs'], objective: 'Run the tests.' },
      ],
    }
    const hash = developmentPlanHash(recoveryPlan)
    const testerTaskId = sliceTaskId('tester', hash, 'S1', 0)
    const handoff = {
      id: 'materialized-tester', taskId: testerTaskId, status: 'completed', summary: 'tests passed', changedPaths: [], commands: [], evidencePaths: ['test/personnel-validation.test.mjs'], risks: [], unresolvedItems: [], consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 1, retries: 0, children: 0 }, childResultIds: [], parentVerification: { status: 'accepted', verifiedBy: 'parent', verifiedAt: '2026-01-01T00:00:00.000Z' }, parentTaskId: 'parent', acknowledgedBy: 'parent', acknowledgedAt: '2026-01-01T00:00:00.000Z',
    } as never
    const coordinator = new DevelopmentCoordinator({
      workspaceRoot: process.cwd(),
      handoffStore: { read: () => handoff },
      approvals: { verifyActiveApproval: async () => undefined },
      patchTracker: { begin: async () => { throw new Error('must not write') } },
      teamCoordinator: { dispatchExpert: async () => { throw new Error('must not dispatch') } },
    })
    const checkpoint = { planHash: hash, slices: [{ sliceId: 'S1', status: 'passed', attempts: 0, handoffs: [handoff] }] as never }
    await expect(coordinator.resume(recoveryPlan, checkpoint)).resolves.toMatchObject({ status: 'passed' })
  })
})
