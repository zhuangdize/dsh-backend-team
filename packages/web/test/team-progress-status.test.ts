import { expect, it } from 'vitest'
import { BackendTeamViewStateSchema } from '../src/view-model.js'
import { executionStatus, progressControl, progressRows } from '../src/team-progress-card.js'
const state = BackendTeamViewStateSchema.parse({ schemaVersion:1, workspaceName:'旧客户管理任务', phase:'BUILD', compatibility:{mode:'supported'}, experts:[],risk:{level:'normal',messages:[]},database:{runtime:'stopped',engine:'PostgreSQL',guiAvailable:false},verification:{total:0,passed:0,failed:0,blocked:0},usage:{activeExperts:0,activeWorkers:0,concurrentWriters:0,remainingTaskBudget:0},lastSequence:0,stateRevision:6 })
it('does not infer approval or active execution from BUILD', () => {
  expect(progressRows(state).slice(0,3).map(row=>row.status)).toEqual(['审批待核实','审批待核实','尚未运行'])
})
it('labels recorded approvals as history, including on adopted tasks', () => {
  expect(progressRows({...state,approvalHistory:[{kind:'requirements',approvedAt:'2026-09-09T01:19:18.615Z'}]})[0]?.status).toBe('历史审批记录')
})
it('distinguishes idle, running, paused and blocked execution', () => {
  for (const [status,label] of [['idle','尚未运行'],['running','进行中'],['paused','已暂停'],['blocked','受阻待处理']] as const) expect(executionStatus({...state,developmentRun:{status}})).toBe(label)
})
it('offers a recovery control for blocked and paused execution in the progress card', () => {
  expect(progressControl({ ...state, developmentRun: { status: 'running' } })).toBe('pause')
  for (const status of ['idle', 'paused', 'failed', 'blocked'] as const) expect(progressControl({ ...state, developmentRun: { status } })).toBe('resume')
  expect(progressControl({ ...state, risk: { level: 'blocked', messages: ['budget'] } })).toBe('resume')
  expect(progressControl({ ...state, phase: 'PLAN' })).toBeUndefined()
})
