import { describe, expect, it } from 'vitest'
import { BackendTeamViewStateSchema } from '../src/view-model.js'
import { createBackendTeamPanelModel } from '../src/panel-model.js'
import { createTaskProgressHomeModel } from '../src/task-progress-model.js'

const base = BackendTeamViewStateSchema.parse({ schemaVersion: 1, workspaceId: 'ws', workspaceName: '客户管理', taskId: 'task-1', phase: 'BUILD', compatibility: { mode: 'supported' }, experts: [], risk: { level: 'normal', messages: [] }, database: { runtime: 'ready', engine: 'PostgreSQL', guiAvailable: false }, verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 1 }, lastSequence: 0, stateRevision: 1 })

describe('task progress home model', () => {
  it('keeps phase and task status separate for an idle build', () => {
    const model = createTaskProgressHomeModel(base, createBackendTeamPanelModel(base))
    expect(model.stageLabel).toBe('功能开发')
    expect(model.status).toBe('进行中')
    expect(model.current).toContain('开发')
    expect(model.stages.map(stage => stage.state)).toEqual(['complete', 'complete', 'current', 'future', 'future'])
  })

  it('prioritizes a current approval over an otherwise active phase', () => {
    const state = { ...base, pendingApproval: { id: 'approval-1', kind: 'design' as const, summary: '请确认方案', artifactHash: 'a'.repeat(64) } }
    const model = createTaskProgressHomeModel(state, createBackendTeamPanelModel(state))
    expect(model.status).toBe('等待你处理')
    expect(model.issue).toBe('有事项需要你处理')
  })

  it('does not call an empty verification summary complete', () => {
    const state = { ...base, phase: 'DELIVER' as const, developmentRun: { status: 'passed' as const } }
    const model = createTaskProgressHomeModel(state, createBackendTeamPanelModel(state))
    expect(model.status).not.toBe('已完成')
    expect(model.recent).toContain('暂无')
  })

  it('surfaces a persisted recovery error as a blocked task with an actionable next step', () => {
    const state = { ...base, workflowError: '数据库迁移恢复失败，已阻止自动应用：snapshot hash mismatch', risk: { level: 'blocked' as const, messages: ['数据库迁移恢复失败，已阻止自动应用：snapshot hash mismatch'] } }
    const model = createTaskProgressHomeModel(state, createBackendTeamPanelModel(state))
    expect(model.status).toBe('已受阻')
    expect(model.current).toBe('任务已受阻，处理原因后可恢复')
    expect(model.issue).toContain('snapshot hash mismatch')
    expect(model.next).toBe('查看技术详情并处理阻塞原因')
  })
})
