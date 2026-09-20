import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ContextManager, MemoryContextCheckpointStore } from '../src/context-manager.js'
import { LongTaskExecutionSession, SharedLongTaskRunLease, ownershipPort, type LongTaskRunLeasePort } from '../src/long-task-execution-session.js'
import { DurableBudgetLedger } from '../src/durable-budget-ledger.js'
import { OwnershipManager } from '../src/ownership-manager.js'

const contextOptions = {
  contextWindowTokens: 300,
  outputLimitTokens: 30,
  toolBufferTokens: 20,
  safetyMarginTokens: 20,
  retainRecentMessages: 2,
  maxSummaryTokens: 40,
}
const budget = { taskMaxTokens: 20, windowMaxTokens: 10, compactionMaxTokens: 8 }

class SingleRunLease implements LongTaskRunLeasePort {
  active = false
  async acquire(): Promise<() => Promise<void>> {
    if (this.active) throw new Error('run lease is busy')
    this.active = true
    let released = false
    return async () => {
      if (released) return
      released = true
      this.active = false
    }
  }
}

function openOptions(lease: SingleRunLease, store: MemoryContextCheckpointStore) {
  return {
    taskId: 'long-task-1',
    runLease: lease,
    ownership: { assert: () => {} },
    contextStore: store,
    contextOptions,
    budget,
  }
}

describe('LongTaskExecutionSession', () => {
  it('shares one underlying run lock across concurrent in-process sessions', async () => {
    let acquisitions = 0
    let releases = 0
    const shared = new SharedLongTaskRunLease({
      acquire: async () => {
        acquisitions += 1
        return async () => { releases += 1 }
      },
    })
    const [first, second] = await Promise.all([shared.acquire(), shared.acquire()])
    expect(acquisitions).toBe(1)
    await first()
    expect(releases).toBe(0)
    await first()
    expect(releases).toBe(0)
    await second()
    expect(releases).toBe(1)
    const third = await shared.acquire()
    expect(acquisitions).toBe(2)
    await third()
    expect(releases).toBe(2)
  })

  it('requires the host run lease, restores context, and does not repeat a completed tool', async () => {
    const store = new MemoryContextCheckpointStore()
    const lease = new SingleRunLease()
    const first = await LongTaskExecutionSession.open(openOptions(lease, store))
    await expect(LongTaskExecutionSession.open(openOptions(lease, store))).rejects.toThrow(/busy/i)
    await first.append([{ id: 'user-1', role: 'user', content: 'Inspect the project.' }])
    let executions = 0
    expect(await first.runTool('inspect:v1', async () => { executions += 1 })).toEqual({ executed: true })
    expect(await first.runTool('inspect:v1', async () => { executions += 1 })).toEqual({ executed: false })
    expect(executions).toBe(1)
    expect((await first.snapshot()).context.transcript).toHaveLength(1)
    await first.close()
    expect(lease.active).toBe(false)

    const resumed = await LongTaskExecutionSession.open(openOptions(lease, store))
    expect((await resumed.snapshot()).context.toolCalls).toMatchObject([{ idempotencyKey: 'inspect:v1', status: 'completed' }])
    await resumed.close()
  })

  it('persists a failed tool as retryable and keeps the cumulative token ceiling across windows', async () => {
    const store = new MemoryContextCheckpointStore()
    const lease = new SingleRunLease()
    const session = await LongTaskExecutionSession.open(openOptions(lease, store))
    let attempts = 0
    await expect(session.runTool('flaky:v1', async () => { attempts += 1; throw new Error('temporary failure') })).rejects.toThrow(/temporary failure/i)
    expect((await session.snapshot()).context.toolCalls).toMatchObject([{ idempotencyKey: 'flaky:v1', status: 'failed' }])
    expect(await session.runTool('flaky:v1', async () => { attempts += 1 })).toEqual({ executed: true })
    expect(attempts).toBe(2)
    session.consumeModelTokens(10)
    session.openNextContextWindow()
    session.consumeModelTokens(10)
    expect(() => session.openNextContextWindow()).toThrow(/task token budget exhausted/i)
    await session.close()
  })

  it('adapts OwnershipManager leases into the host ownership assertion', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'long-task-session-'))
    try {
      const manager = new OwnershipManager({ workspaceRoot: root, recoveryToken: 'long-task-test-token-1234' })
      const lease = manager.acquire('long-task-1', ['src'], 'write')
      const port = ownershipPort(manager)
      expect(() => port.assert('long-task-1', ['src/index.ts'], ['src/index.ts'])).not.toThrow()
      expect(() => port.assert('other-task', [], ['src/index.ts'])).toThrow(/write lease is missing/i)
      manager.release(lease)
      expect(() => port.assert('long-task-1', [], ['src/index.ts'])).toThrow(/write lease is missing/i)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('uses ContextManager options from the host and rejects operations after close', async () => {
    const store = new MemoryContextCheckpointStore()
    const lease = new SingleRunLease()
    const session = await LongTaskExecutionSession.open(openOptions(lease, store))
    const direct = await ContextManager.open('long-task-1', store, contextOptions)
    expect(direct.snapshot().threadId).toBe('long-task-1')
    await session.close()
    await expect(session.append([{ id: 'late', role: 'user', content: 'late' }])).rejects.toThrow(/closed/i)
    expect(lease.active).toBe(false)
  })

  it('charges model and compaction usage to the existing durable task ledger', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'long-task-budget-'))
    try {
      const ledger = new DurableBudgetLedger(root)
      ledger.register('long-task-1', { maxTokens: 20, maxWallMs: 100, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 })
      const session = await LongTaskExecutionSession.open({
        ...openOptions(new SingleRunLease(), new MemoryContextCheckpointStore()),
        budgetLedger: ledger,
      })
      session.consumeModelTokens(6)
      session.consumeCompactionTokens(4)
      expect(ledger.snapshot('long-task-1').consumed.tokens).toBe(10)
      await session.close()

      const recovered = new DurableBudgetLedger(root)
      expect(recovered.snapshot('long-task-1').consumed.tokens).toBe(10)
      expect(() => recovered.record('long-task-1', { tokens: 11, wallMs: 0, toolCalls: 0, retries: 0, children: 0 })).toThrow(/task budget exhausted/i)
      expect(recovered.snapshot('long-task-1').status).toBe('blocked:budget-exhausted')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
