import { expect, it } from 'vitest'
import { filterWorkspaceTasks, hasBlockingCurrentTask, taskExecution, type WorkspaceTask } from '../src/task-center.js'
const tasks: WorkspaceTask[] = [
  { id: 'a', title: '客户管理', objective: '新增客户', phase: 'BUILD', arrangement: 'unfinished', current: false, createdAt: '2026-09-09T00:00:00Z', sessionId: 'old', executionStatus: 'idle' },
  { id: 'b', title: '演示接口', phase: 'VERIFY', arrangement: 'shelved', current: false, createdAt: '2026-09-08T00:00:00Z', sessionId: 'archived', executionStatus: 'saved' },
  { id: 'c', title: '连接检查', phase: 'DELIVER', arrangement: 'completed', current: false, createdAt: '2026-09-07T00:00:00Z', sessionId: 'other', executionStatus: 'passed' },
]
it('lists tasks independently of conversation binding and filters shelved and completed tasks', () => {
  expect(filterWorkspaceTasks(tasks, '全部', '').map(t => t.id)).toEqual(['a', 'b', 'c'])
  expect(filterWorkspaceTasks(tasks, '已搁置', '').map(t => t.id)).toEqual(['b'])
  expect(filterWorkspaceTasks(tasks, '已完成', '').map(t => t.id)).toEqual(['c'])
  expect(filterWorkspaceTasks(tasks, '全部', ' 新增 ')).toEqual([tasks[0]])
})
it('keeps workflow stage separate from actual running status', () => {
  expect(taskExecution(tasks[0]!)).toBe('功能开发 · 尚未运行')
  expect(taskExecution({ ...tasks[0]!, phase: 'DISCOVER', executionStatus: 'queued' })).toBe('需求收集 · 排队中')
  expect(taskExecution({ ...tasks[0]!, executionStatus: 'paused' })).toBe('功能开发 · 已暂停')
  expect(taskExecution(tasks[2]!)).toBe('已交付')
})

it('does not block adopting another task after the current task is delivered', () => {
  expect(hasBlockingCurrentTask({ ...tasks[2]!, current: true })).toBe(false)
  expect(hasBlockingCurrentTask({ ...tasks[0]!, current: true })).toBe(true)
  expect(hasBlockingCurrentTask(undefined)).toBe(false)
})
