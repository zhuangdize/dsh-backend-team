import { expect, it, vi } from 'vitest'
import { createBackendTeamPanelModel } from '../src/panel-model.js'
import { createTaskProgressHome } from '../src/task-progress-home.js'

it('shows a task-scoped approval card and gates decisions on preview inspection', () => {
  const hash = 'a'.repeat(64)
  const state = {
    schemaVersion: 1 as const,
    workspaceId: '/workspace',
    workspaceName: 'T14 隔离迁移恢复演练',
    phase: 'DISCOVER' as const,
    compatibility: { mode: 'supported' as const },
    pendingApproval: { id: 'migration-1', kind: 'migration' as const, summary: '请检查数据库迁移 SQL', artifactHash: hash },
    experts: [],
    risk: { level: 'blocked' as const, messages: ['上一次恢复已暂停'] },
    database: { runtime: 'ready' as const, engine: 'PostgreSQL 18.6', guiAvailable: false, controlsAvailable: true },
    verification: { total: 0, passed: 0, failed: 0, blocked: 0 },
    usage: { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 1 },
    lastSequence: 0,
    stateRevision: 2,
  }
  const base = createBackendTeamPanelModel(state)
  const panel = { ...base, approval: { ...base.approval!, viewed: true, canConfirm: true, confirmAction: { ...base.approval!.confirmAction, enabled: true } } }
  const actions = { openResources: vi.fn(), openTechnical: vi.fn(), pause: vi.fn(), resume: vi.fn(), inspect: vi.fn(), approve: vi.fn(), reject: vi.fn() }
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => typeof type === 'function' ? (type as (props: Record<string, unknown>) => unknown)({ ...(props as Record<string, unknown> | null), children }) : ({ type, props, children }),
    useEffect: () => undefined,
    useState: <T>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, vi.fn()] as const,
  }
  const view = createTaskProgressHome(react, state, panel, actions, { artifactHash: hash, files: [{ path: 'migration.sql', content: 'CREATE TABLE accounts(id integer);' }] })
  expect(find(view, 'button', '查看方案')).toBeDefined()
  expect(find(view, 'button', '确认并继续')).toBeDefined()
  expect(find(view, 'pre')?.children).toEqual(['CREATE TABLE accounts(id integer);'])
  ;(find(view, 'button', '确认并继续')?.props as { onClick: () => void }).onClick()
  expect(actions.approve).toHaveBeenCalledTimes(1)
})

interface ElementLike { type?: unknown; props?: unknown; children?: unknown[] }
function find(root: unknown, type: string, text?: string): ElementLike | undefined {
  if (root === null || typeof root !== 'object') return undefined
  const element = root as ElementLike
  if (element.type === type && (text === undefined || element.children?.join('') === text)) return element
  for (const child of element.children ?? []) {
    const found = find(child, type, text)
    if (found !== undefined) return found
  }
  return undefined
}
