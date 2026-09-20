import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { AgentPresentationSchema } from '../../web/src/a2ui/catalog.js'
import { pendingWorkflowQuestions, formatWorkflowAnswers, WorkflowQuestionSchema, type UserQuestionRequest, type UserQuestionAnswer } from './workflow-questions.js'
import { setTimeout as delay } from 'node:timers/promises'
import { BackendTeamViewStateSchema } from '@dsh-backend-team/web'
import type { DshControlRouteRequest, DshSessionContext } from './dsh-session-adapter.js'

const Input = z.object({ action: z.enum(['resolve-task', 'start', 'refine', 'ask', 'continue', 'wait', 'pause', 'preview', 'approve', 'reject', 'start-database', 'stop-database', 'open-database-gui', 'prepare-migration']), expectedRevision: z.number().int().nonnegative(), text: z.string().trim().min(1).max(8000).optional(), questions: z.array(WorkflowQuestionSchema).min(1).max(4).optional(), ui: AgentPresentationSchema.optional() }).strict()
interface Execution { agent?: { id?: string }; signal: AbortSignal; callId?: string }
export function createConversationWorkflowTool(options: {
  sessionInput: (request: DshControlRouteRequest) => unknown
  context: DshSessionContext
  workspaceRoot: string
  getState(session: unknown): unknown
  dispatch(session: unknown, action: unknown): Promise<unknown>
  createTask?: (session: unknown, objective: string, expectedRevision: number, taskId?: string) => Promise<unknown>
  taskChoices?: (session: unknown) => Promise<Array<{ id: string; title: string; phase: string; revision: number; sessionId: string; shelvedAt?: string }>>
  resolveTask?: (session: unknown, choice: { id: string; title: string; phase: string; revision: number; sessionId: string; shelvedAt?: string }, mode: 'shelve' | 'adopt') => Promise<unknown>
  askQuestions?: (request: UserQuestionRequest) => Promise<UserQuestionAnswer>
  requestApproval(request: { agent: unknown; toolName: string; callId?: string; reason: string; signal: AbortSignal }): Promise<string>
}) {
  const authenticate = options.sessionInput
  const previews = new Map<string, string>()
  const questions = new Map<string, ReturnType<typeof pendingWorkflowQuestions>>()
  return {
    name: 'backend_team_workflow',
    description: '遇到旧任务冲突，调用 resolve-task，在当前聊天明确确认搁置或接回已有任务；禁止要求用户寻找旧会话。一次处理一个任务，搁置不等于交付。可选 ui 使用 A2UI v0.9.1 两条消息 createSurface / updateComponents，catalogId 为 urn:dsh:backend-team:catalog:1，仅允许 Text、Badge、Column、Row；root 为根组件。用于简短方案说明，审批按钮始终由宿主生成，不能自行输出。用户在对话中提出后端开发需求时，必须调用本工具把需求交给 Backend Agent Team，不能自己代替团队开发，也不要让用户去面板启动。先查询 backend_team_status 获得 expectedRevision。start 用用户完整需求创建独立团队任务，保留历史；refine 根据用户补充意见修订当前需求或设计；开发或验收阶段会先请求用户明确选择修改当前任务，再安全暂停、撤回两项旧审批并重审。独立新需求不得自动并入当前任务；当前会话已有未交付任务时先 resolve-task，工作区被其他会话占用时 start 会持久排队，不创建审批或启动 Agent；continue 恢复任务；pause 暂停开发。出现待审批时，立即用 preview 读取内容，聊天只展示简短摘要并告知完整文档可在右侧“任务资源”查看，不要把整份文档混入正文；然后调用 approve，宿主会先逐题收集未决问题，再请求用户明确确认；确认后团队自动推进。reject 请求退回；用户提供修改意见时必须完整传入 text，以启动实际修订，不能仅重新展示旧方案。遇到其他必须由用户决定的业务问题，使用 ask 和 questions 在聊天中逐题问答，不要在正文列问题让用户手工编号回复；每次最多4题，提供具体选项。按任务需要自行准备环境，open-database-gui 会在数据库就绪后打开经认证的一次性 DbGate 页面，prepare-migration 会启动数据库并生成待审批迁移。不得自行批准或把提交成功说成完成。',
    parameters: { type: 'object', properties: { ui: z.toJSONSchema(AgentPresentationSchema, { unrepresentable: 'any' }), action: { type: 'string', enum: ['resolve-task','start','refine','ask','continue','wait','pause','preview','approve','reject','start-database','stop-database','open-database-gui','prepare-migration'], description: '团队正在工作时用 wait 等待进展（最多 30 秒），按返回状态继续等待，直到需要用户审批或交付。数据库操作由团队提交；open-database-gui 只返回本机会话的一次性页面，prepare-migration 只生成待审批预览。不要让用户反复发送“继续”。' }, expectedRevision: { type: 'integer', minimum: 0 }, text: { type: 'string', minLength: 1, maxLength: 8000 }, questions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'], additionalProperties: false } } }, required: ['id','question'], additionalProperties: false } } }, required: ['action','expectedRevision'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, message: { type: 'string' }, result: {} }, required: ['status','message'], additionalProperties: false }, render(_args: unknown, value: unknown) { return [{ type: 'text' as const, text: JSON.stringify(value) }] } },
    async execute(raw: unknown, execution: Execution) {
      execution.signal.throwIfAborted()
      const input = Input.parse(raw)
      const id = execution.agent?.id
      if (id === undefined || options.context.agents?.get(id) !== execution.agent) throw new Error('当前调用缺少有效的项目会话。')
      const session = authenticate({ method: 'GET', path: '/plugins/backend-team/control/state', query: { sessionId: id }, headers: {}, remoteAddress: '127.0.0.1' })
      const state = BackendTeamViewStateSchema.parse(await options.getState(session))
      if (state.stateRevision !== input.expectedRevision) throw new Error('项目状态已变化，请重新查询状态后再操作。')
      const base = { workspaceId: options.workspaceRoot, expectedRevision: input.expectedRevision, ...(state.taskId === undefined ? {} : { taskId: state.taskId }) }
      if (input.action === 'resolve-task') {
        if (!options.taskChoices || !options.resolveTask || !options.askQuestions) throw new Error('当前宿主不支持任务冲突确认。')
        const choices = await options.taskChoices(session)
        if (!choices.length) return { status: 'clear', message: '没有未完成的会话任务。' }
        let page = 0
        let chosen: typeof choices[number] | undefined
        while (!chosen) {
          execution.signal.throwIfAborted()
          const shown = choices.slice(page * 4, page * 4 + 4)
          const labels = shown.map((item, index) => String(page * 4 + index + 1) + '. ' + item.title)
          const questionId = 'task-conflict-select:' + randomUUID()
          const pageOptions = shown.map((item, index) => ({ label: labels[index]!, description: item.phase + (item.shelvedAt ? ' · 已搁置' : ' · 未完成') }))
          if (page > 0) pageOptions.push({ label: '上一页', description: '查看前面的任务' })
          if ((page + 1) * 4 < choices.length) pageOptions.push({ label: '下一页', description: '查看其余任务' })
          const answer = await askUser(options.askQuestions, { agent: execution.agent, signal: execution.signal, questions: [{ id: questionId, header: '已有任务', question: `选择要处理的已有任务（第 ${page + 1}/${Math.ceil(choices.length / 4)} 页），无需寻找原会话。`, options: pageOptions }] })
          if (!answer) return { status: 'deferred', message: '未选择任务，保持原状。' }
          const selection = answer.answers[0]
          if (selection?.id !== questionId || answer.answers.length !== 1 || selection.selected.length !== 1 || selection.custom?.trim()) return { status: 'not-applied', message: '尚未明确选择已有任务，未更改状态。' }
          const selected = selection.selected[0]!
          if (selected === '上一页' && page > 0) { page--; continue }
          if (selected === '下一页' && (page + 1) * 4 < choices.length) { page++; continue }
          chosen = shown[labels.indexOf(selected)]
          if (!chosen) return { status: 'not-applied', message: '尚未明确选择已有任务，未更改状态。' }
        }
        const decisionId = 'task-conflict-action:' + randomUUID()
        const decision = await askUser(options.askQuestions, { agent: execution.agent, signal: execution.signal, questions: [{ id: decisionId, header: '处理任务', question: '如何处理“' + chosen.title + '”？搁置保留代码和文档，不代表验收通过；接回后由当前对话管理原任务，不会把本次新需求并入或视为已批准。', options: [{ label: '接回当前对话' }, { label: '搁置并释放占用' }, { label: '保持原状' }] }] })
        execution.signal.throwIfAborted()
        const item = decision?.answers[0]
        if (decision?.answers.length !== 1 || item?.id !== decisionId || item.selected.length !== 1 || item.custom?.trim() || !['接回当前对话', '搁置并释放占用'].includes(item.selected[0]!)) return { status: 'deferred', message: '未明确确认变更，保持原状。' }
        const mode = item.selected[0] === '接回当前对话' ? 'adopt' : 'shelve'
        const result = await options.resolveTask(session, chosen, mode)
        const returnedStatus = taskResolutionStatus(result)
        if (returnedStatus !== undefined && returnedStatus !== (mode === 'adopt' ? 'adopted' : 'shelved')) throw new Error(`任务处置结果与用户选择不一致：已请求${mode === 'adopt' ? '接回当前对话' : '搁置并释放占用'}，服务返回${returnedStatus}。请重新查询当前任务状态后再继续，不要直接创建新任务。`)
        previews.delete(id); questions.delete(id)
        return { status: 'resolved', message: mode === 'adopt' ? `已将“${chosen.title}”接回当前对话。先查看原需求再继续；新需求尚未加入，也未获批准。` : `已搁置“${chosen.title}”，保留代码和文档。重新查询剩余冲突后，可以发起新需求；本次操作不代表交付或批准。`, result }
      }
      if (input.action === 'ask') {
        if (!options.askQuestions || !input.questions) throw new Error('请提供需要用户决定的具体业务问题。')
        if (!['AWAIT_REQUIREMENTS_APPROVAL','AWAIT_DESIGN_APPROVAL'].includes(state.phase)) {
          const message = ['BUILD', 'VERIFY'].includes(state.phase)
            ? '当前阶段不能修改方案：任务正在开发或验收。需要变更时调用 refine，由用户确认后安全暂停并重开需求/设计审批；仅等待运行用 wait，恢复中断用 continue。'
            : '当前阶段不能修改方案，请先查询团队进度。'
          throw new Error(message)
        }
        if (new Set(input.questions.map(item => item.id)).size !== input.questions.length) throw new Error('问题编号不能重复。')
        const answers = await askUser(options.askQuestions, { agent: execution.agent, signal: execution.signal, questions: input.questions.map(question => ({ ...question, header: '需求确认' })) })
        if (answers === undefined) return { status: 'deferred', message: '用户选择稍后处理。不要自动重试或再次弹窗，保留当前待确认方案，等待用户继续。' }
        execution.signal.throwIfAborted()
        const latest = BackendTeamViewStateSchema.parse(await options.getState(session))
        if (latest.taskId !== state.taskId || latest.stateRevision !== state.stateRevision || latest.pendingApproval?.artifactHash !== state.pendingApproval?.artifactHash) throw new Error('方案已更新，请重新查看后确认。')
        const text = formatWorkflowAnswers(input.questions, answers)
        const result = await waitForOperation(options.dispatch(session, { ...base, type: 'submit-clarification', text }), execution.signal)
        previews.delete(id); questions.delete(id)
        return { status: 'submitted', message: '回答已交给团队修订当前方案，尚未批准。请等待新版本并请求确认。', result }
      }
      if (input.action === 'wait') {
        if (['BUILD', 'VERIFY'].includes(state.phase) && (!state.developmentRun || state.developmentRun.status === 'idle') && !state.usage.activeExperts && !state.usage.activeWorkers) return { status: 'needs-resume', message: '当前任务没有实际运行，不要继续轮询。先核对任务名称和原方案：若用户要继续原任务，调用 continue；若是新需求，调用 resolve-task 让用户明确搁置原任务后再 start。历史审批不能用于新需求。', result: { taskId: state.taskId, title: state.workspaceName, expectedRevision: state.stateRevision } }

        if (state.developmentRun?.status === 'paused' || state.developmentRun?.status === 'pausing') return { status: 'paused', message: '任务已请求暂停。停止轮询和自动恢复，等用户明确要求继续。', result: { phase: state.phase, expectedRevision: state.stateRevision } }
        if (state.workflowRetryAvailable && ['DESIGN', 'PLAN'].includes(state.phase) && (state.taskId === undefined ? !state.experts.some(expert => expert.status === 'running') : state.usage.activeExperts === 0)) return { status: 'needs-resume', message: '当前阶段没有团队成员在运行。请调用 continue 恢复已保存的任务，不要继续等待。', result: { phase: state.phase, expectedRevision: state.stateRevision } }
        const deadline = Date.now() + 30_000
        let latest = state
        while (Date.now() < deadline && latest.taskId === state.taskId && latest.pendingApproval === undefined && latest.phase !== 'DELIVER' && latest.risk.level !== 'blocked' && !['failed', 'blocked', 'paused'].includes(latest.developmentRun?.status ?? '') && latest.stateRevision === state.stateRevision) {
          await delay(1000, undefined, { signal: execution.signal })
          latest = BackendTeamViewStateSchema.parse(await options.getState(session))
        }
        return { status: latest.risk.level === 'blocked' || ['failed', 'blocked'].includes(latest.developmentRun?.status ?? '') ? 'blocked' : latest.pendingApproval === undefined ? latest.phase === 'DELIVER' ? 'completed' : 'progress' : 'awaiting-approval', message: '以实际状态为准。有待审批时立即读取方案并请求确认；运行中继续等待；受阻时报告具体原因并停止轮询，不要在没有修复或新证据时反复 continue。', result: { phase: latest.phase, expectedRevision: latest.stateRevision, risk: latest.risk, ...(latest.taskId === undefined ? {} : { taskId: latest.taskId }), ...(latest.pendingApproval === undefined ? {} : { pendingApproval: latest.pendingApproval }), ...(latest.developmentRun === undefined ? {} : { developmentRun: latest.developmentRun }) } }
      }
      if (input.action === 'start' && options.createTask !== undefined) {
        if (!input.text) throw new Error('请提供完整需求。')
        const result = await waitForOperation(options.createTask(session, input.text, input.expectedRevision, state.taskId), execution.signal)
        if (taskCreationStatus(result) === 'queued') return { status: 'queued', message: '新需求已排队，暂不创建审批或启动 Agent。旧任务安全暂停并经聊天明确搁置后，系统会衔接该任务；请以重新查询状态为准。', result }
        return { status: 'started', message: '独立任务已创建。请检查返回状态；有待审批时立即 preview 并向用户展示，再请求明确确认。', result }
      }
      let action: Record<string, unknown>
      if (input.action === 'preview' || input.action === 'approve' || input.action === 'reject') {
        const pending = state.pendingApproval
        if (pending === undefined) throw new Error('当前没有待确认的方案。')
        const identity = `${state.taskId ?? 'legacy'}:${pending.id}:${pending.artifactHash}:${state.stateRevision}`
        if (input.action === 'preview') {
          const result = await options.dispatch(session, { ...base, type: 'open-artifact', artifactId: pending.artifactHash })
          execution.signal.throwIfAborted()
          const pendingQuestions = pending.kind === 'requirements' ? pendingWorkflowQuestions(result) : []
          previews.set(id, identity)
          questions.set(id, pendingQuestions)
          return { status: 'preview', message: pending.kind === 'design' ? '请展示当前实现方案，再请求明确确认。spec.md 和 clarification.md 是已批准的背景版本；已采用的默认决定以当前设计为准，不要为清理历史提问而重跑设计或改写已批准需求。' : '聊天仅展示简短摘要，完整文档在右侧任务资源中查看。调用 approve 会先展示待确认问题，回答后修订方案；没有问题时显示带可选补充输入的确认框。', result }
        }
        if (previews.get(id) !== identity) throw new Error('请先读取当前版本的方案并向用户展示。')
        if (options.askQuestions !== undefined && ['requirements', 'design'].includes(pending.kind)) {
          const pendingQuestions = questions.get(id) ?? []
          const approvalId = 'backend-team-review:' + pending.id
          const answer = await askUser(options.askQuestions, { agent: execution.agent, signal: execution.signal, questions: pendingQuestions.length ? pendingQuestions.map(item => ({ ...item, header: '需求确认' })) : [{ id: approvalId, header: pending.kind === 'requirements' ? '需求审批' : '设计审批', question: pending.summary, detail: '完整文档可在右侧「任务资源」查看。没有补充意见，选择确认通过；需要调整时输入修改意见。' + (input.ui ? '\n<!-- backend-team:a2ui\n' + JSON.stringify(input.ui) + '\n-->' : ''), options: [{ label: '确认通过' }, { label: '退回修改' }] }] })
          if (answer === undefined) return { status: 'deferred', message: '用户选择稍后处理。不要自动重试或再次弹窗，保留当前待确认方案，等待用户继续。' }
          execution.signal.throwIfAborted()
          const fresh = BackendTeamViewStateSchema.parse(await options.getState(session))
          if (fresh.taskId !== state.taskId || fresh.stateRevision !== state.stateRevision || fresh.pendingApproval?.artifactHash !== pending.artifactHash || fresh.pendingApproval.id !== pending.id) throw new Error('方案已更新，本次回答未应用，请查看新版本后重新确认。')
          let decision: Record<string, unknown>
          if (pendingQuestions.length) {
            decision = { ...base, type: 'submit-clarification', text: formatWorkflowAnswers(pendingQuestions, answer) + '\n请根据回答更新需求。已解决的问题移入已确认结论，未决问题只保留真正阻碍实施的业务选择，不重复询问，也不新增用户未要求的功能。' }
          } else {
            const item = answer.answers[0]
            if (answer.answers.length !== 1 || item?.id !== approvalId || item.selected.some(label => !['确认通过', '退回修改'].includes(label)) || (!item.custom?.trim() && item.selected.length !== 1)) throw new Error('请选择确认或退回，或输入修改意见。')
            decision = item.custom?.trim() ? { ...base, type: 'submit-clarification', text: item.custom.trim() } : { ...base, type: 'decide-approval', approvalId: pending.id, artifactHash: pending.artifactHash, decision: item.selected[0] === '确认通过' && input.action === 'approve' ? 'approve' : 'reject' }
          }
          previews.delete(id); questions.delete(id)
          const result = await waitForOperation(options.dispatch(session, decision), execution.signal)
          return { status: 'submitted', message: decision.type === 'submit-clarification' ? '用户意见已交给团队修订，尚未批准旧方案。等待修订后展示简短摘要并再次确认，不重复询问已回答问题。' : '用户决定已提交；请查看实际进度。', result }
        }
        const outcome = await options.requestApproval({ agent: execution.agent, toolName: 'backend_team_workflow', ...(execution.callId === undefined ? {} : { callId: execution.callId }), reason: `${input.action === 'approve' ? '批准' : '退回'}后端团队方案：${pending.summary}\n方案校验值：${pending.artifactHash}。仅对此版本生效。`, signal: execution.signal })
        execution.signal.throwIfAborted()
        if (outcome !== 'allowed-once') return { status: 'not-applied', message: '未取得本次用户确认，方案状态没有改变。' }
        previews.delete(id)
        action = input.action === 'reject' && input.text && ['requirements', 'design'].includes(pending.kind)
          ? { ...base, type: 'submit-clarification', text: input.text }
          : { ...base, type: 'decide-approval', approvalId: pending.id, artifactHash: pending.artifactHash, decision: input.action === 'approve' ? 'approve' : 'reject' }
      } else if (input.action === 'start' || input.action === 'refine') {
        if (!input.text) throw new Error('请提供需求或补充说明。')
        if (input.action === 'refine' && ['BUILD', 'VERIFY'].includes(state.phase)) {
          if (!options.askQuestions) throw new Error('当前宿主不支持需求变更确认。')
          const questionId = 'requirement-change:' + randomUUID()
          const answer = await askUser(options.askQuestions, { agent: execution.agent, signal: execution.signal, questions: [{ id: questionId, header: '需求变更', question: '如何处理本次需求？当前任务：' + state.workspaceName, detail: '本次补充：' + input.text + '\n修改当前任务将停止开发，重新生成需求和设计，并分别请求你确认。已有代码保留，旧审批不适用于新范围。', options: [{ label: '修改当前任务' }, { label: '另开新任务' }, { label: '暂不变更' }] }] })
          execution.signal.throwIfAborted()
          const choice = answer?.answers[0]
          if (!answer || answer.answers.length !== 1 || choice?.id !== questionId || choice.selected.length !== 1 || choice.custom?.trim()) return { status: 'deferred', message: '尚未明确确认，原任务保持不变。' }
          if (choice.selected[0] === '另开新任务') return { status: 'needs-task-resolution', message: '本次需求应独立建任务。请调用 resolve-task 确认处理旧任务后再 start，不要并入当前任务。' }
          if (choice.selected[0] !== '修改当前任务') return { status: 'deferred', message: '原任务保持不变。' }
          const latest = BackendTeamViewStateSchema.parse(await options.getState(session))
          if (latest.taskId !== state.taskId || latest.stateRevision !== state.stateRevision) throw new Error('任务已变化，请重新查询后确认。')
        } else if (!['DISCOVER','SPECIFY','AWAIT_REQUIREMENTS_APPROVAL','AWAIT_DESIGN_APPROVAL'].includes(state.phase)) throw new Error('当前阶段不能直接覆盖，请先查询任务状态。')
        action = { ...base, type: 'submit-clarification', text: input.text }
      } else if (input.action === 'start-database' || input.action === 'stop-database' || input.action === 'open-database-gui' || input.action === 'prepare-migration') {
        if ((input.action === 'open-database-gui' || input.action === 'prepare-migration') && state.database.runtime !== 'ready') {
          if (!state.database.controlsAvailable) throw new Error(input.action === 'open-database-gui' ? '当前项目未配置可用数据库，无法打开数据库工具。' : '当前项目未配置可用数据库，无法生成迁移。')
          await options.dispatch(session, { ...base, type: 'start-database' })
          execution.signal.throwIfAborted()
          const prepared = BackendTeamViewStateSchema.parse(await options.getState(session))
          if (prepared.stateRevision !== input.expectedRevision || prepared.database.runtime !== 'ready') throw new Error('数据库准备未完成或项目状态已变化，请重新查询状态。')
        }
        if (input.action === 'open-database-gui' && !state.database.controlsAvailable) throw new Error('当前项目未配置可用数据库，无法打开数据库工具。')
        action = { ...base, type: input.action === 'prepare-migration' ? 'prepare-database-migration' : input.action }
      } else if (input.action === 'pause') {
        if (!state.developmentRun || ['idle', 'paused', 'passed', 'failed', 'blocked'].includes(state.developmentRun.status)) return { status: 'not-running', message: '当前没有开发执行需要暂停。若要释放旧任务占用，请调用 resolve-task 请求明确搁置；不要把暂停执行当作结束任务。' }
        action = { ...base, type: 'pause-run' }
      } else {
        if (state.pendingApproval !== undefined) return { status: 'awaiting-approval', message: '请先读取并确认待处理方案。' }
        if (state.phase === 'DELIVER') return { status: 'completed', message: options.createTask === undefined ? '当前任务已交付；可查询验收结果。新任务需要另行配置项目，不能覆盖已完成记录。' : '当前任务已交付；收到新的开发需求时，用 start 创建下一项独立任务，历史记录会保留。' }
        if (state.phase === 'BUILD' || state.phase === 'VERIFY') action = { ...base, type: 'resume-run' }
        else if (state.phase === 'SPECIFY') action = { ...base, type: 'retry-failed-step', stepId: 'workflow:requirements' }
        else if (state.phase === 'DESIGN' || state.phase === 'PLAN') action = { ...base, type: 'retry-failed-step', stepId: state.phase === 'DESIGN' ? 'workflow:design' : 'workflow:plan' }
        else if (state.phase === 'AWAIT_REQUIREMENTS_APPROVAL' || state.phase === 'AWAIT_DESIGN_APPROVAL') action = { ...base, type: 'retry-failed-step', stepId: state.phase === 'AWAIT_REQUIREMENTS_APPROVAL' ? 'approval:requirements' : 'approval:design' }
        else throw new Error('请先提交需求。')
      }
      execution.signal.throwIfAborted()
      const result = await waitForOperation(options.dispatch(session, action), execution.signal)
      return { status: 'submitted', message: '操作已提交给实际团队服务。请查询状态确认进度，不能把提交成功当作开发完成。', result }
    },
  }
}

/** Stopping the chat detaches its wait; the durable team task remains visible. */
function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('operation aborted')) }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

async function askUser(ask: (request: UserQuestionRequest) => Promise<UserQuestionAnswer>, request: UserQuestionRequest): Promise<UserQuestionAnswer | undefined> {
  try { return await ask(request) }
  catch (error) {
    request.signal.throwIfAborted()
    if (error !== null && typeof error === 'object' && ['cancelled', 'ASK_CANCELLED'].includes(String(Reflect.get(error, 'code')))) return undefined
    throw error
  }
}

function taskResolutionStatus(value: unknown): 'shelved' | 'adopted' | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const status = Reflect.get(value, 'status')
  return status === 'shelved' || status === 'adopted' ? status : undefined
}

function taskCreationStatus(value: unknown): 'queued' | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, 'status') === 'queued' ? 'queued' : undefined
}
