import { expect, it, vi } from 'vitest'
import { createProductionWorkflowCommandImplementations } from '../src/production-workflow-commands.js'

function fixture(changes: { changeRequirements?(text: string, revision: number, sessionId: string): Promise<void>; recoverRequirements?(): Promise<void>; waitForWorkflowAdvance?(): Promise<void>; pendingKind?: 'requirements' | 'design'; taskId?: string } = {}) {
  let phase = 'DISCOVER'
  const start = vi.fn(async () => { phase = 'AWAIT_REQUIREMENTS_APPROVAL' })
  const refine = vi.fn(async () => {})
  const decideAndWait = vi.fn(async () => {})
  const requestWorkflowApproval = vi.fn(async () => {})
  let busy = false
  const design = vi.fn(async () => {})
  const generateTasks = vi.fn(async () => {})
  const composition = { ...(changes.taskId === undefined ? {} : { taskId: changes.taskId }), specification: { design, generateTasks }, scheduler: { snapshot: () => ({ activeExperts: busy ? 1 : 0, activeWriters: 0, queued: 0 }) }, stateStore: { load: async () => ({ phase, revision: 0 }) }, layout: { root: '/workspace' }, workflow: { start, refine, resume: vi.fn(async () => {}), approve: vi.fn(async () => {}), status: () => ({}) }, approvals: { decideAndWait, listPending: () => changes.pendingKind === undefined ? [] : [{ id: 'approval-1', workspaceId: '/workspace', stateRevision: 0, artifactHash: 'a'.repeat(64), request: { kind: changes.pendingKind, summary: 'approval' } }], subscribe: () => () => {} }, requestWorkflowApproval, ...(changes.waitForWorkflowAdvance === undefined ? {} : { waitForWorkflowAdvance: changes.waitForWorkflowAdvance }) }
  const unavailable = async () => { throw new Error('fixture operation unavailable') }
  const commands = createProductionWorkflowCommandImplementations(composition, { ...changes, openArtifact: unavailable, pauseRun: unavailable, resumeRun: unavailable, startDatabase: unavailable, stopDatabase: unavailable, openDatabaseGui: unavailable })
  return { commands, start, refine, decideAndWait, requestWorkflowApproval, design, generateTasks, setBusy: (value: boolean) => { busy = value }, setPhase: (value: string) => { phase = value } }
}
const base = { workspaceId: '/workspace', expectedRevision: 0 }
const context = { workspaceId: '/workspace', expectedRevision: 0, authenticatedSessionId: 'session-1234567890' }
it('starts requirements and exposes a real approval request without approving it', async () => {
  const f = fixture()
  await f.commands.submitClarification({ ...base, type: 'submit-clarification', text: 'Build health API' }, context)
  expect(f.start).toHaveBeenCalledWith('Build health API')
  expect(f.requestWorkflowApproval).toHaveBeenCalledWith('requirements')
  expect(f.decideAndWait).not.toHaveBeenCalled()
})
it('uses refinement only at its phase and rejects start from BUILD', async () => {
  const f = fixture(); f.setPhase('AWAIT_REQUIREMENTS_APPROVAL')
  await f.commands.submitClarification({ ...base, type: 'submit-clarification', text: 'Return 200' }, context)
  expect(f.refine).toHaveBeenCalledWith('Return 200')
  f.setPhase('BUILD')
  await expect(f.commands.submitClarification({ ...base, type: 'submit-clarification', text: 'again' }, context)).rejects.toThrow('phase')
  expect(f.start).not.toHaveBeenCalled()
})
it('passes the exact revision and artifact hash to approval settlement', async () => {
  const f = fixture()
  await f.commands.decideApproval({ ...base, type: 'decide-approval', decision: 'reject', approvalId: 'approval-1', artifactHash: 'a'.repeat(64) }, context)
  expect(f.decideAndWait).toHaveBeenCalledWith('approval-1', { effect: 'reject', reason: 'User decision from authenticated Backend Team control', provenance: { sessionId: context.authenticatedSessionId } }, 'a'.repeat(64), 0)
})
it('binds a production approval decision to the current task as well as the session', async () => {
  const f = fixture({ taskId: '22222222-2222-4222-8222-222222222222', pendingKind: 'design' })
  await f.commands.decideApproval({ ...base, type: 'decide-approval', decision: 'approve', approvalId: 'approval-1', artifactHash: 'a'.repeat(64) }, context)
  expect(f.decideAndWait).toHaveBeenCalledWith('approval-1', expect.objectContaining({ provenance: { sessionId: context.authenticatedSessionId, taskId: '22222222-2222-4222-8222-222222222222' } }), 'a'.repeat(64), 0)
})
it('returns after approval settlement while post-approval generation continues in the background', async () => {
  let release!: () => void
  const background = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ pendingKind: 'requirements', waitForWorkflowAdvance: async () => background })
  const response = f.commands.decideApproval({ ...base, type: 'decide-approval', decision: 'approve', approvalId: 'approval-1', artifactHash: 'a'.repeat(64) }, context)
  const timedOut = Symbol('timed-out')
  const result = await Promise.race([response, new Promise<typeof timedOut>(resolve => setTimeout(() => resolve(timedOut), 50))])
  release()
  await response
  expect(result).not.toBe(timedOut)
  expect(f.decideAndWait).toHaveBeenCalledOnce()
})
it('rejects fabricated context and stale revisions before workflow execution', async () => {
  const f = fixture()
  await expect(f.commands.submitClarification({ ...base, type: 'submit-clarification', text: 'x' }, { ...context, workspaceId: '/elsewhere' })).rejects.toThrow('context')
  await expect(f.commands.submitClarification({ ...base, expectedRevision: 1, type: 'submit-clarification', text: 'x' }, { ...context, expectedRevision: 1 })).rejects.toThrow('stale')
  expect(f.start).not.toHaveBeenCalled()
})

it('recovers only the current idle document phase through the real coordinator seam', async () => {
  const f = fixture()
  const action = { ...base, type: 'retry-failed-step', stepId: 'workflow:design' }
  await expect(f.commands.retryFailedStep(action, context)).rejects.toThrow('phase changed')
  f.setPhase('DESIGN'); f.setBusy(true)
  await expect(f.commands.retryFailedStep(action, context)).rejects.toThrow('already running')
  expect(f.design).not.toHaveBeenCalled()
  f.setBusy(false)
  await f.commands.retryFailedStep(action, context)
  expect(f.design).toHaveBeenCalledOnce()
  expect(f.requestWorkflowApproval).toHaveBeenCalledWith('design')
  f.setPhase('PLAN')
  await f.commands.retryFailedStep({ ...action, stepId: 'workflow:plan' }, context)
  expect(f.generateTasks).toHaveBeenCalledOnce()
})

it('routes authenticated development changes and recovery to the durable host service', async () => {
  const changeRequirements = vi.fn(async () => {}), recoverRequirements = vi.fn(async () => {})
  const f = fixture({ changeRequirements, recoverRequirements }); f.setPhase('BUILD')
  await f.commands.submitClarification({ ...base, type: 'submit-clarification', text: '增加跟进' }, context)
  expect(changeRequirements).toHaveBeenCalledWith('增加跟进', 0, context.authenticatedSessionId)
  expect(f.start).not.toHaveBeenCalled(); expect(f.requestWorkflowApproval).not.toHaveBeenCalled()
  f.setPhase('SPECIFY')
  await f.commands.retryFailedStep({ ...base, type: 'retry-failed-step', stepId: 'workflow:requirements' }, context)
  expect(recoverRequirements).toHaveBeenCalledOnce()
})
