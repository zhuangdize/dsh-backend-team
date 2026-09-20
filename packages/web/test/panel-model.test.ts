import { describe, expect, it } from 'vitest'
import { createBackendTeamApprovalInteraction, createBackendTeamPanelModel } from '../src/panel-model.js'

const baseState = {
  schemaVersion: 1 as const,
  workspaceName: '订单服务',
  phase: 'DESIGN' as const,
  compatibility: { mode: 'supported' as const },
  experts: [{ id: 'expert-1', role: '架构专家', status: 'running' as const, taskSummary: '整理 API 结构', childCount: 1 }],
  risk: { level: 'normal' as const, messages: [] },
  database: { runtime: 'ready' as const, engine: 'PostgreSQL 18.6', guiAvailable: true },
  verification: { total: 3, passed: 2, failed: 0, blocked: 1 },
  usage: { activeExperts: 1, activeWorkers: 1, concurrentWriters: 0, remainingTaskBudget: 50 },
  lastSequence: 4,
  stateRevision: 4,
}

describe('Backend Team panel model', () => {
  it('shows controls from actual development lifecycle state only', () => {
    const state = { ...baseState, phase: 'BUILD' as const }
    expect(createBackendTeamPanelModel({ ...state, developmentRun: { status: 'running' } }).primaryAction).toMatchObject({ type: 'pause-run', enabled: true })
    expect(createBackendTeamPanelModel({ ...state, developmentRun: { status: 'pausing' } }).primaryAction).toMatchObject({ type: 'none', label: '正在等待当前步骤结束', enabled: false })
    expect(createBackendTeamPanelModel({ ...state, developmentRun: { status: 'paused' } }).primaryAction).toMatchObject({ type: 'resume-run', enabled: true })
    expect(createBackendTeamPanelModel(state).primaryAction.type).not.toBe('resume-run')
  })
  it('allows verification retries and presents delivered projects as complete', () => {
    expect(createBackendTeamPanelModel({ ...baseState, phase: 'VERIFY', developmentRun: { status: 'blocked', message: '请重新验收' } }).primaryAction).toMatchObject({ type: 'resume-run', enabled: true })
    expect(createBackendTeamPanelModel({ ...baseState, phase: 'DELIVER', developmentRun: { status: 'passed' } }).primaryAction).toMatchObject({ type: 'none', label: '本次需求验收已完成', enabled: false })
  })
  it('uses the restored delivery review in the verification summary', () => {
    const model = createBackendTeamPanelModel({ ...baseState, phase: 'DELIVER', developmentRun: { status: 'passed', delivery: { status: 'ready', reportPath: '.backend-team/report.json', scope: 'declared tests', testStatus: 'passed', requirements: [{ requirementId: 'AC-1', status: 'passed', evidenceIds: ['one'], missingEvidenceIds: [] }], unresolvedItems: [] } } })
    expect(model.verification).toMatchObject({ summary: '1/1 项需求验收通过', total: 1, passed: 1, blocked: 0, reportPath: '.backend-team/report.json' })
  })
  it('turns technical phase and status into plain-language content', () => {
    const model = createBackendTeamPanelModel(baseState)
    expect(model.title).toBe('订单服务')
    expect(model.phase).toMatchObject({ label: '设计方案', description: expect.stringContaining('验收计划') })
    expect(model.database).toMatchObject({ label: '数据库已就绪', detail: 'PostgreSQL 18.6' })
    expect(model.verification.summary).toBe('2/3 项检查通过')
  })

  it('requires artifact inspection before exposing the approval action', () => {
    const state = { ...baseState, pendingApproval: { id: 'approval-1', kind: 'design' as const, summary: '订单 API 设计方案', artifactHash: 'a'.repeat(64) } }
    const model = createBackendTeamPanelModel(state)
    expect(model.approval).toMatchObject({ required: true, viewed: false, canConfirm: false, summary: '订单 API 设计方案' })
    expect(model.approval?.viewAction.type).toBe('open-artifact')
    const interaction = createBackendTeamApprovalInteraction(state)
    expect(interaction.snapshot().canConfirm).toBe(false)
    expect(interaction.inspect()).toMatchObject({ viewed: true, canConfirm: true, confirmAction: { type: 'decide-approval', enabled: true, approvalId: 'approval-1' } })
    expect(interaction.reset()).toMatchObject({ viewed: false, canConfirm: false })
  })

  it('exposes recovery guidance without leaking paths or credentials', () => {
    const model = createBackendTeamPanelModel({ ...baseState, compatibility: { mode: 'read-only', reason: '宿主能力未验证' }, risk: { level: 'blocked', messages: ['需要重新连接宿主'] } })
    expect(model.primaryAction).toMatchObject({ type: 'diagnose', label: '查看诊断信息' })
    expect(model.risk).toMatchObject({ level: 'blocked', messages: ['需要重新连接宿主'] })
    expect(JSON.stringify(model)).not.toMatch(/password|secret|token|\/Volumes|\.backend-team/iu)
  })
})

it('does not offer database installation when the host has not enabled execution', () => {
  const model = createBackendTeamPanelModel({ ...baseState, phase: 'BUILD', executionAvailable: false, database: { runtime: 'not-installed', engine: 'PostgreSQL 18.6', guiAvailable: false } })
  expect(model.primaryAction).toMatchObject({ type: 'none', enabled: false })
  expect(model.primaryAction.label).toContain('尚未启用')
  expect(model.phase).toMatchObject({ label: '规划已完成', description: '任务计划已通过校验。当前入口尚未启用代码执行。' })
})

it('offers document recovery only when the host supports it and no expert is running', () => {
  const state = { ...baseState, phase: 'DESIGN' as const, workflowRetryAvailable: true, experts: [] }
  expect(createBackendTeamPanelModel(state).primaryAction).toMatchObject({ label: '继续设计', stepId: 'workflow:design', enabled: true })
  expect(createBackendTeamPanelModel(state).phase.description).toContain('尚未完成')
  expect(createBackendTeamPanelModel({ ...state, phase: 'PLAN' }).primaryAction).toMatchObject({ label: '继续规划', stepId: 'workflow:plan' })
  expect(createBackendTeamPanelModel({ ...state, experts: [{ id: 'active', role: 'coordinator', status: 'running', taskSummary: 'running', childCount: 0 }] }).primaryAction.enabled).toBe(false)
  expect(createBackendTeamPanelModel({ ...state, workflowRetryAvailable: false }).primaryAction.enabled).toBe(false)
})

it('keeps accepted tests separate from unresolved delivery requirements', () => {
  const delivery = { status: 'needs-attention' as const, reportPath: '.backend-team/final-verification-1/report.json', testStatus: 'passed' as const, scope: 'declared Node tests', requirements: [{ requirementId: 'AC-001', status: 'not-run' as const, evidenceIds: ['startup'], missingEvidenceIds: ['startup'] }], unresolvedItems: ['startup not run'] }
  const model = createBackendTeamPanelModel({ ...baseState, phase: 'BUILD', developmentRun: { status: 'passed', delivery } })
  expect(model.delivery).toEqual(delivery)
  expect(model.phase.value).toBe('BUILD')
})
