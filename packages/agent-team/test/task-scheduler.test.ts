import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { AgentTaskSchema, type AgentHandle, type AgentResult, type AgentSpawnRequest, type BackendTeamOrchestrationPort } from '@dsh-backend-team/contracts'
import { BudgetLedger } from '../src/budget-ledger.js'
import { TaskScheduler } from '../src/task-scheduler.js'

const hash = 'a'.repeat(64)

function task(id: string, overrides: Record<string, unknown> = {}) {
  return AgentTaskSchema.parse({
    id, parentTaskId: 'coordinator-1', depth: 1, role: 'developer', objective: `Complete ${id}.`, nonGoals: ['Do not exceed scope.'],
    inputArtifacts: [{ path: 'specs/feature.md', sha256: hash }], readPaths: ['src'], writePaths: [],
    capabilities: { readProjectFiles: true, canDelegate: true }, budget: { maxTokens: 100, maxWallMs: 100, maxToolCalls: 10, maxRetries: 1, maxChildren: 3 },
    doneWhen: ['Focused tests pass.'], verification: [{ id: 'focused', kind: 'test', instruction: 'Run focused tests.', required: true }], returnSchema: 'handoff-v1',
    ...overrides,
  })
}

interface ControlledHandle extends AgentHandle { complete(): void; readonly cancelled: boolean }

function deferredHandle(id: string, taskId: string): ControlledHandle {
  let resolve: (() => void) | undefined
  let cancelled = false
  const result = new Promise<AgentResult>((done) => { resolve = () => done({
    taskId, status: 'passed', summary: 'done', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [],
    consumedBudget: { tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0 }, childResultIds: [],
    verification: { status: 'passed', verifiedBy: 'scheduler-test', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'focused', outcome: 'passed', evidencePaths: [] }] },
  }) })
  return {
    id,
    get cancelled() { return cancelled },
    complete: () => resolve?.(),
    result: async () => result,
    cancel: async () => { cancelled = true; resolve?.() },
  }
}

class ControlledPort implements BackendTeamOrchestrationPort {
  readonly requests: AgentSpawnRequest[] = []
  readonly handles: ControlledHandle[] = []
  async requestApproval(): Promise<never> { throw new Error('not used') }
  async emit(): Promise<void> {}
  async spawnAgent(request: AgentSpawnRequest): Promise<AgentHandle> {
    const handle = deferredHandle(`agent-${this.handles.length + 1}`, request.agentTask?.id ?? request.task)
    this.requests.push(request)
    this.handles.push(handle)
    return handle
  }
  completeAll(): void { for (const handle of this.handles) handle.complete() }
}

async function settled(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
async function completeQueued(port: ControlledPort): Promise<void> { for (let index = 0; index < 8; index += 1) { port.completeAll(); await settled() } }

describe('TaskScheduler', () => {
  it('runs at most three experts and two writer workers while passing agentTask to the mock port', async () => {
    const port = new ControlledPort()
    const ledger = new BudgetLedger()
    const scheduler = new TaskScheduler({ orchestration: port, ledger })
    const experts = Array.from({ length: 4 }, (_, index) => scheduler.submit(task(`expert-${index}`)))
    const parent = task('parent')
    ledger.register(parent.id, parent.budget)
    const writers = Array.from({ length: 3 }, (_, index) => scheduler.submit(task(`writer-${index}`, { parentTaskId: parent.id, depth: 2, role: 'worker', capabilities: { readProjectFiles: true, writeOwnedFiles: true }, writePaths: [`src/users/${index}.ts`], budget: { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } })))

    await settled()
    expect(scheduler.snapshot()).toMatchObject({ activeExperts: 3, activeWriters: 2 })
    expect(port.requests).toHaveLength(5)
    expect(port.requests.every((request) => request.agentTask !== undefined)).toBe(true)

    await completeQueued(port)
    await Promise.all([...experts, ...writers])
  })

  it('starts blocking work before later normal work and releases leases after cancellation', async () => {
    const port = new ControlledPort()
    const scheduler = new TaskScheduler({ orchestration: port, ledger: new BudgetLedger() })
    const running = ['running-1', 'running-2', 'running-3'].map((id) => scheduler.submit(task(id)))
    const normal = scheduler.submit(task('normal'), 'normal')
    const blocking = scheduler.submit(task('blocking'), 'blocking')

    await settled()
    await scheduler.cancel('running-1')
    await settled()
    expect(port.requests.map((request) => request.agentTask?.id)).toEqual(['running-1', 'running-2', 'running-3', 'blocking'])
    expect(port.handles[0]?.cancelled).toBe(true)
    await completeQueued(port)
    await Promise.all([...running, normal, blocking])
    expect(scheduler.snapshot()).toMatchObject({ activeExperts: 0, activeWriters: 0 })
  })

  it('cancels the Agent and rejects when the task wall-clock budget expires', async () => {
    let cancelled = false
    const ledger = new BudgetLedger()
    const port = {
      spawnAgent: async (): Promise<AgentHandle> => ({
        id: 'agent-timeout',
        result: async () => new Promise<never>(() => {}),
        cancel: async () => { cancelled = true },
      }),
    }
    const scheduler = new TaskScheduler({ orchestration: port, ledger })

    await expect(scheduler.submit(task('timeout', { budget: { maxTokens: 100, maxWallMs: 10, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 } }))).rejects.toThrow(/wall-clock budget exhausted/i)
    expect(cancelled).toBe(true)
    expect(ledger.snapshot('timeout')).toMatchObject({
      status: 'blocked:budget-exhausted',
      consumed: { wallMs: 10 },
      remaining: { maxWallMs: 0 },
    })
    expect(scheduler.snapshot()).toMatchObject({ activeExperts: 0, activeWriters: 0 })
  })

  it('persists wall-clock exhaustion so a restarted scheduler reports the same terminal reason', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'task-scheduler-timeout-'))
    let cancelled = false
    try {
      const port = {
        spawnAgent: async (): Promise<AgentHandle> => ({
          id: 'agent-timeout-durable',
          result: async () => new Promise<never>(() => {}),
          cancel: async () => { cancelled = true },
        }),
      }
      const scheduler = new TaskScheduler({ orchestration: port, workspaceRoot: root })
      await expect(scheduler.submit(task('timeout-durable', { budget: { maxTokens: 100, maxWallMs: 10, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 } }))).rejects.toThrow(/wall-clock budget exhausted/i)
      expect(cancelled).toBe(true)

      const recovered = new TaskScheduler({ orchestration: port, workspaceRoot: root })
      expect(recovered.budgetSnapshot('timeout-durable')).toMatchObject({ status: 'blocked:budget-exhausted', consumed: { wallMs: 10 }, overrun: { exceeded: ['wallMs'] } })
      await expect(recovered.submit(task('timeout-durable', { budget: { maxTokens: 100, maxWallMs: 10, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 } }))).rejects.toThrow(/parent budget exhausted/i)
      await scheduler.dispose()
      await recovered.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('applies the wall-clock budget while the Agent is being created', async () => {
    const ledger = new BudgetLedger()
    let aborted = false
    const port = {
      spawnAgent: async (_request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle> => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) { aborted = true; resolve(); return }
          signal?.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
        })
        return { id: 'agent-never-created', result: async () => undefined, cancel: async () => {} }
      },
    }
    const scheduler = new TaskScheduler({ orchestration: port, ledger })

    await expect(scheduler.submit(task('creation-timeout', { budget: { maxTokens: 100, maxWallMs: 10, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 } }))).rejects.toThrow(/wall-clock budget exhausted/i)
    expect(aborted).toBe(true)
    expect(ledger.snapshot('creation-timeout')).toMatchObject({ status: 'blocked:budget-exhausted', consumed: { wallMs: 10 }, remaining: { maxWallMs: 0 } })
  })

  it('accounts for a runtime-reported wall-clock exhaustion even if its timer wins first', async () => {
    const ledger = new BudgetLedger()
    let cancelled = false
    const port = {
      spawnAgent: async (): Promise<AgentHandle> => ({
        id: 'agent-runtime-timeout',
        result: async () => { throw new Error('managed Agent wall-time budget exhausted') },
        cancel: async () => { cancelled = true },
      }),
    }
    const scheduler = new TaskScheduler({ orchestration: port, ledger })

    await expect(scheduler.submit(task('runtime-timeout', { budget: { maxTokens: 100, maxWallMs: 100, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 } }))).rejects.toThrow(/wall-time budget exhausted/i)
    expect(cancelled).toBe(true)
    expect(ledger.snapshot('runtime-timeout')).toMatchObject({ status: 'blocked:budget-exhausted', consumed: { wallMs: 100 }, remaining: { maxWallMs: 0 } })
  })

  it('rejects malformed tasks and children whose parent budget has already been exhausted', async () => {
    const port = new ControlledPort()
    const ledger = new BudgetLedger()
    ledger.register('parent', { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 1 })
    const reservation = ledger.reserve('parent', 'used', { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 })
    ledger.consume(reservation, { tokens: 10, wallMs: 10, toolCalls: 1, retries: 0, children: 0 })
    const scheduler = new TaskScheduler({ orchestration: port, ledger })

    await expect(scheduler.submit({})).rejects.toThrow(/invalid task/i)
    await expect(scheduler.submit(task('child', { parentTaskId: 'parent', depth: 2, role: 'worker', capabilities: { readProjectFiles: true, canDelegate: false }, budget: { maxTokens: 1, maxWallMs: 1, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } }))).rejects.toThrow(/parent budget exhausted/i)
  })

  it('surfaces observed usage when a completed Agent result exceeds its task budget', async () => {
    const ledger = new BudgetLedger()
    const port = {
      spawnAgent: async (request: AgentSpawnRequest): Promise<AgentHandle> => ({
        id: 'agent-overrun',
        result: async () => ({
          taskId: request.agentTask!.id, status: 'passed', summary: 'done', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [], childResultIds: [],
          consumedBudget: { tokens: 15, wallMs: 20, toolCalls: 1, retries: 0, children: 0 },
          verification: { status: 'passed', verifiedBy: 'scheduler-test', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'focused', outcome: 'passed', evidencePaths: [] }] },
        }),
        cancel: async () => {},
      }),
    }
    const scheduler = new TaskScheduler({ orchestration: port, ledger })
    const scheduled = task('overrun', { budget: { maxTokens: 10, maxWallMs: 100, maxToolCalls: 2, maxRetries: 1, maxChildren: 0 } })

    await expect(scheduler.submit(scheduled)).rejects.toThrow(/task budget exhausted.*tokens used 15 > remaining 10/i)
    expect(ledger.snapshot(scheduled.id)).toMatchObject({ status: 'blocked:budget-exhausted', consumed: { tokens: 15 }, overrun: { exceeded: ['tokens'] } })
  })

  it('does not double-count child reservations reported by a completed parent', async () => {
    const ledger = new BudgetLedger()
    const parent = task('delegating-parent', { budget: { maxTokens: 100, maxWallMs: 100, maxToolCalls: 10, maxRetries: 1, maxChildren: 1 } })
    ledger.register(parent.id, parent.budget)
    const childBudget = { maxTokens: 20, maxWallMs: 20, maxToolCalls: 2, maxRetries: 0, maxChildren: 0 }
    const reservation = ledger.reserve(parent.id, 'delegating-worker', childBudget)
    ledger.consume(reservation, { tokens: 5, wallMs: 5, toolCalls: 1, retries: 0, children: 0 })
    const port = {
      spawnAgent: async (request: AgentSpawnRequest): Promise<AgentHandle> => ({
        id: 'agent-delegating-parent',
        result: async () => ({
          taskId: request.agentTask!.id, status: 'passed', summary: 'done', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [],
          consumedBudget: { tokens: 10, wallMs: 10, toolCalls: 1, retries: 0, children: 1 }, childResultIds: ['handoff-delegating-worker'],
          verification: { status: 'passed', verifiedBy: 'scheduler-test', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'focused', outcome: 'passed', evidencePaths: [] }] },
        }),
        cancel: async () => {},
      }),
    }
    const scheduler = new TaskScheduler({ orchestration: port, ledger })

    await expect(scheduler.submit(parent)).resolves.toMatchObject({ taskId: parent.id, status: 'passed' })
    expect(ledger.snapshot(parent.id)).toMatchObject({ status: 'ready', consumed: { tokens: 15, wallMs: 15, toolCalls: 2, retries: 0, children: 1 }, remaining: { maxChildren: 0 } })
  })

  it('does not let a direct scheduler caller bypass writer overlap with a guessed parent ID', async () => {
    const port = new ControlledPort()
    const ledger = new BudgetLedger()
    const scheduler = new TaskScheduler({ orchestration: port, ledger })
    const parent = scheduler.submit(task('parent', { writePaths: ['src/scope'] }))
    const child = scheduler.submit(task('child', { parentTaskId: 'parent', depth: 2, role: 'worker', writePaths: ['src/scope'], capabilities: { readProjectFiles: true, writeOwnedFiles: true, canDelegate: false }, budget: { maxTokens: 1, maxWallMs: 1, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } }))

    await settled()
    expect(port.requests.map((request) => request.agentTask?.id)).toEqual(['parent'])
    port.completeAll()
    await completeQueued(port)
    await Promise.all([parent, child])
    expect(port.requests.map((request) => request.agentTask?.id)).toEqual(['parent', 'child'])
  })

  it('uses a workspace durable budget ledger by default and recovers a parent for a restarted scheduler', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'task-scheduler-durable-'))
    try {
      const firstPort = new ControlledPort()
      const first = new TaskScheduler({ orchestration: firstPort, workspaceRoot: root })
      const parentRun = first.submit(task('parent'))
      await settled()

      const restartedPort = new ControlledPort()
      const restarted = new TaskScheduler({ orchestration: restartedPort, workspaceRoot: root })
      const childRun = restarted.submit(task('child', { parentTaskId: 'parent', depth: 2, role: 'worker', capabilities: { readProjectFiles: true, canDelegate: false }, budget: { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } }))
      await settled()

      expect(restarted.budgetSnapshot('parent').reserved).toEqual({ tokens: 10, wallMs: 10, toolCalls: 1, retries: 0, children: 1 })

      firstPort.completeAll()
      restartedPort.completeAll()
      await completeQueued(firstPort)
      await completeQueued(restartedPort)
      await Promise.all([parentRun, childRun])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('disposes queued and active work without leaving Agent handles running', async () => {
    const port = new ControlledPort()
    const scheduler = new TaskScheduler({ orchestration: port, ledger: new BudgetLedger() })
    const runs = Array.from({ length: 4 }, (_, index) => scheduler.submit(task(`dispose-${index}`)))

    await settled()
    expect(scheduler.snapshot()).toMatchObject({ activeExperts: 3, queued: 1 })

    await scheduler.dispose()

    expect(port.handles.every((handle) => handle.cancelled)).toBe(true)
    await expect(runs[3]).rejects.toThrow(/disposed/i)
    await expect(Promise.all(runs.slice(0, 3))).resolves.toEqual([undefined, undefined, undefined])
    expect(scheduler.snapshot()).toMatchObject({ activeExperts: 0, activeWriters: 0, queued: 0 })
    await expect(scheduler.submit(task('after-dispose'))).rejects.toThrow(/disposed/i)
    await scheduler.dispose()
  })
})
