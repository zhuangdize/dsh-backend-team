import type { DshControlRouteRequest, DshSessionContext } from './dsh-session-adapter.js'

/** The same authenticated state projection used by the browser control panel. */
export function createProductionStatusTool(options: {
  sessionInput: (request: DshControlRouteRequest) => unknown
  context: DshSessionContext
  workspaceRoot: string
  getState: (session: unknown) => unknown
}) {
  const authenticate = options.sessionInput
  return {
    name: 'backend_team_status',
    description: 'Read the configured Backend Agent Team service status for the calling Agent workspace. This is a status query only; use backend_team_workflow for workflow actions. It does not assess generic Harness version compatibility.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { mode: { type: 'string' }, message: { type: 'string' }, taskId: { type: 'string' }, taskHistory: { type: 'array' }, workspaceName: { type: 'string' }, phase: { type: 'string' }, expectedRevision: { type: 'integer' }, pendingApproval: { type: 'object' }, database: { type: 'object' }, delivery: { type: 'object' } }, required: ['mode', 'message'], additionalProperties: false },
      render(_args: unknown, value: unknown) { return [{ type: 'text' as const, text: JSON.stringify(value) }] },
    },
    async execute(args: unknown, execution: { readonly agent?: { readonly id?: string }; readonly signal: AbortSignal }) {
      execution.signal.throwIfAborted()
      if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length > 0) throw new TypeError('status parameters must be an empty object')
      const id = execution.agent?.id
      let session: unknown
      try {
        if (id === undefined || options.context.agents?.get(id) !== execution.agent) throw new Error('live calling Agent is required')
        session = authenticate({ method: 'GET', path: '/plugins/backend-team/control/state', query: { sessionId: id }, headers: {}, remoteAddress: '127.0.0.1' })
      } catch {
        return { mode: 'unavailable', message: '当前会话未连接到已配置的后端团队项目。请切换到对应工作区的会话。此结果不代表模型或 Harness 不兼容。' }
      }
      const { BackendTeamViewStateSchema } = await import('../../web/src/view-model.js')
      const state = BackendTeamViewStateSchema.parse(await options.getState(session))
      execution.signal.throwIfAborted()
      const delivery = state.developmentRun?.delivery
      const documentPaused = state.workflowRetryAvailable && ['DESIGN', 'PLAN'].includes(state.phase) && (state.taskId === undefined ? !state.experts.some(expert => expert.status === 'running') : state.usage.activeExperts === 0)
      return {
        mode: state.compatibility.mode,
        ...(state.taskId === undefined ? {} : { taskId: state.taskId, taskHistory: state.taskHistory ?? [] }),
        message: state.risk.level === 'blocked' ? state.risk.messages.join('\n') : documentPaused ? '当前文档阶段尚未运行或已中断，没有团队成员在运行。请调用 backend_team_workflow 的 continue 恢复当前任务，不能用 wait 等待尚未启动的任务。' : '此结果来自后端团队面板使用的实际服务。查询不启动团队任务；请使用 backend_team_workflow 发起或推进团队任务；审批需要聊天中的用户确认。验收结果仅覆盖报告注明的范围。',
        workspaceName: state.workspaceName,
        phase: state.phase,
        expectedRevision: state.stateRevision,
        database: { runtime: state.database.runtime, configured: state.database.controlsAvailable ?? false, migrationAvailable: state.database.migrationAvailable ?? false },
        ...(state.pendingApproval === undefined ? {} : { pendingApproval: { kind: state.pendingApproval.kind, summary: state.pendingApproval.summary } }),
        ...(delivery === undefined ? {} : { delivery: { status: delivery.status, scope: delivery.scope, passed: delivery.requirements.filter(item => item.status === 'passed').length, total: delivery.requirements.length, unresolved: delivery.unresolvedItems.length, reportPath: delivery.reportPath } }),
      }
    },
  }
}
