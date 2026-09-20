import { BackendTeamControlActionSchema, type BackendTeamControlAction } from '../../web/src/control-actions.js'
import type { ProductionCompositionSummary, ProductionCoordinatorCommandImplementations } from './production.js'

type Composition = Pick<ProductionCompositionSummary, 'taskId' | 'layout' | 'stateStore' | 'workflow' | 'approvals' | 'requestWorkflowApproval' | 'waitForWorkflowAdvance' | 'specification' | 'scheduler'>
type Operations = Required<Pick<ProductionCoordinatorCommandImplementations, 'openArtifact' | 'pauseRun' | 'resumeRun' | 'startDatabase' | 'stopDatabase' | 'openDatabaseGui'>> & Partial<Pick<ProductionCoordinatorCommandImplementations, 'prepareDatabaseMigration' | 'createDatabaseSnapshot' | 'restoreDatabaseSnapshot'>> & { changeRequirements?(text: string, revision: number, sessionId: string): Promise<void>; recoverRequirements?(): Promise<void> }

/** Binds real workflow and approval services; other operations remain explicit host capabilities. */
export function createProductionWorkflowCommandImplementations(composition: Composition, operations: Operations): ProductionCoordinatorCommandImplementations {
  const workflow = composition.workflow
  if (workflow === undefined) throw new Error('production workflow is required')
  for (const key of ['openArtifact', 'pauseRun', 'resumeRun', 'startDatabase', 'stopDatabase', 'openDatabaseGui'] as const) {
    if (typeof operations?.[key] !== 'function') throw new Error(`host operation is required: ${key}`)
  }
  let running = false
  const exclusive = async (operation: () => Promise<void>): Promise<void> => {
    if (running) throw new Error('workflow operation is already running')
    running = true
    try { await operation() } finally { running = false }
  }
  const current = async () => {
    const state = await composition.stateStore.load()
    if (state === null || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('workflow state is unavailable')
    return state
  }
  const check = async <T extends BackendTeamControlAction['type']>(type: T, input: unknown, context: unknown): Promise<Extract<BackendTeamControlAction, { type: T }>> => {
    const action = BackendTeamControlActionSchema.parse(input)
    const ctx = typeof context === 'object' && context !== null ? context as Record<string, unknown> : {}
    if (action.type !== type || action.workspaceId !== composition.layout.root || ctx.workspaceId !== action.workspaceId || ctx.expectedRevision !== action.expectedRevision || typeof ctx.authenticatedSessionId !== 'string' || ctx.authenticatedSessionId.length < 16) throw new Error('authenticated workflow context does not match action')
    if ((await current()).revision !== action.expectedRevision) throw new Error('stale workflow revision')
    return action as Extract<BackendTeamControlAction, { type: T }>
  }
  return {
    ...operations,
    createDatabaseSnapshot: async (input, context) => {
      const action = await check('create-database-snapshot', input, context)
      if (operations.createDatabaseSnapshot === undefined) throw new Error('数据库备份尚未配置')
      await operations.createDatabaseSnapshot(action, context)
    },
    restoreDatabaseSnapshot: async (input, context) => {
      const action = await check('restore-database-snapshot', input, context)
      if (operations.restoreDatabaseSnapshot === undefined) throw new Error('数据库恢复尚未配置')
      await operations.restoreDatabaseSnapshot(action, context)
    },
    currentRevision: async () => (await current()).revision,
    submitClarification: (input, context) => exclusive(async () => {
      const action = await check('submit-clarification', input, context)
      const state = await current()
      const pending = composition.approvals.listPending()[0]
      if (pending !== undefined) {
        if (!['requirements', 'design'].includes(pending.request.kind)) throw new Error('请先处理待确认的数据库迁移。')
        await composition.approvals.decideAndWait(pending.id, { effect: 'reject', reason: '用户补充说明，重新生成待确认版本。' }, pending.artifactHash, pending.stateRevision)
      }
      if (['BUILD', 'VERIFY'].includes(state.phase) && operations.changeRequirements) {
        await operations.changeRequirements(action.text, action.expectedRevision, Reflect.get(context as object, 'authenticatedSessionId') as string)
        return
      }
      if (state.phase === 'SPECIFY' && operations.recoverRequirements) {
        // A saved change must finish before accepting another input.
        const raw = await composition.stateStore.load()
        if (raw && Reflect.get(raw, 'requirementChanges')?.at(-1)?.status === 'preparing') throw new Error('需求变更尚未完成，请先继续恢复，再补充说明。')
      }
      if (state.phase === 'DISCOVER' || state.phase === 'SPECIFY') await workflow.start(action.text)
      else if (state.phase === 'AWAIT_REQUIREMENTS_APPROVAL') await workflow.refine(action.text)
      else if (state.phase === 'AWAIT_DESIGN_APPROVAL') await workflow.refine({ stage: 'design', text: action.text })
      else throw new Error(`requirements input is unavailable in phase ${state.phase}`)
      // This publishes a request; the user still must make the approval decision.
      await composition.requestWorkflowApproval(state.phase === 'AWAIT_DESIGN_APPROVAL' ? 'design' : 'requirements')
    }),
    decideApproval: async (input, context) => {
      const action = await check('decide-approval', input, context)
      const sessionId = Reflect.get(context as object, 'authenticatedSessionId') as string
      await composition.approvals.decideAndWait(action.approvalId, {
        effect: action.decision,
        reason: 'User decision from authenticated Backend Team control',
        provenance: { sessionId, ...(composition.taskId === undefined ? {} : { taskId: composition.taskId }) },
      }, action.artifactHash, action.expectedRevision)
      // decideAndWait already confirms that the approval transaction is durable.
      // Post-approval generation is background work; holding this control call
      // open until it finishes can exceed the host turn timeout.
    },
    retryFailedStep: (input, context) => exclusive(async () => {
      const action = await check('retry-failed-step', input, context)
      if (action.stepId === 'workflow:requirements') {
        if (!operations.recoverRequirements) throw new Error('需求变更恢复不可用')
        await operations.recoverRequirements(); return
      }
      if (action.stepId === 'workflow:design' || action.stepId === 'workflow:plan') {
        const phase = action.stepId === 'workflow:design' ? 'DESIGN' : 'PLAN'
        if ((await current()).phase !== phase) throw new Error('workflow recovery phase changed')
        const scheduler = composition.scheduler?.snapshot()
        if (scheduler === undefined || composition.specification === undefined) throw new Error('workflow recovery is unavailable')
        if (scheduler.activeExperts > 0 || scheduler.activeWriters > 0 || scheduler.queued > 0 || composition.approvals.listPending().length > 0) throw new Error('workflow operation is already running or awaiting approval')
        if (phase === 'DESIGN') {
          await composition.specification.design()
          await composition.requestWorkflowApproval('design')
        } else { await composition.specification.generateTasks(); await workflow.resume() }
        return
      }
      await workflow.resume({ stepId: action.stepId })
    }),
  }
}
