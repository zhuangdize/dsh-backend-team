import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ContextBudgetError, ContextBudgetWindow, ContextCompactionError, ContextManager, FileContextCheckpointStore, MemoryContextCheckpointStore, PostgresContextCheckpointStore } from '../src/context-manager.js'
import type { ContextCheckpoint, PostgresCheckpointQueryPort } from '../src/context-manager.js'

const limits = { contextWindowTokens: 300, outputLimitTokens: 30, toolBufferTokens: 15, safetyMarginTokens: 15 }

describe('ContextManager', () => {
  it('splits model windows while charging compaction to the cumulative task ceiling', () => {
    const budget = new ContextBudgetWindow({ taskMaxTokens: 100, windowMaxTokens: 50, compactionMaxTokens: 20 })
    budget.consumeModel(45)
    expect(() => budget.consumeModel(6)).toThrowError(new ContextBudgetError('window-exhausted', 'model window budget exhausted; open the next context window'))
    budget.openNextWindow()
    budget.consumeModel(30)
    budget.consumeCompaction(10)
    expect(budget.snapshot()).toEqual({ windowIndex: 1, taskMaxTokens: 100, taskConsumedTokens: 85, windowMaxTokens: 50, windowConsumedTokens: 30, compactionMaxTokens: 20, compactionConsumedTokens: 10 })
    expect(() => budget.consumeCompaction(11)).toThrowError(/compaction budget exhausted/u)
    budget.openNextWindow()
    budget.consumeModel(15)
    expect(() => budget.openNextWindow()).toThrowError(/task token budget exhausted/u)
  })

  it('cleans old tool output before summarizing and keeps the canonical transcript intact', async () => {
    const store = new MemoryContextCheckpointStore()
    const manager = await ContextManager.open('tool-cleanup', store, { ...limits, retainRecentMessages: 2 })
    manager.append([
      { id: 'system-1', role: 'system', content: 'You are a backend agent.' },
      { id: 'user-1', role: 'user', content: 'OBJECTIVE: ship the approved feature.' },
      { id: 'tool-1', role: 'tool', toolCallId: 'call-1', content: 'x'.repeat(2_000) },
      { id: 'assistant-1', role: 'assistant', content: 'The tool result was inspected.' },
      { id: 'user-2', role: 'user', content: 'Continue from the checkpoint.' },
    ])

    const projection = await manager.prepare()

    expect(projection.estimatedTokens).toBeLessThanOrEqual(projection.safeLimitTokens)
    expect(projection.actions).toContain('tool-output-pruned')
    expect(projection.messages.find(message => message.id === 'tool-1')?.content).toContain('archived')
    expect(manager.snapshot().transcript.find(message => message.id === 'tool-1')?.content).toBe('x'.repeat(2_000))
    expect(manager.snapshot().compactions).toHaveLength(0)
  })

  it('creates an agentic compaction artifact with a canonical prefix hash', async () => {
    const store = new MemoryContextCheckpointStore()
    const manager = await ContextManager.open('agentic', store, {
      ...limits,
      retainRecentMessages: 2,
      summarizer: async () => ({
        objective: 'ship the approved feature',
        constraints: ['write only owned files'],
        decisions: ['use the existing repository'],
        approvedArtifacts: ['specs/feature.md'],
        pendingApprovals: ['design'],
        blockers: [],
        verification: ['focused tests'],
        nextAction: 'resume the next slice',
      }),
    })
    manager.append(Array.from({ length: 10 }, (_, index) => ({ id: `message-${index}`, role: index === 0 ? 'system' as const : index % 2 === 0 ? 'assistant' as const : 'user' as const, content: index >= 8 ? 'recent continuation' : `${index === 1 ? 'OBJECTIVE: original objective' : 'DECISION: keep the current plan'} ${'detail '.repeat(40)}` })))

    const projection = await manager.prepare()
    const checkpoint = manager.snapshot()
    const artifact = checkpoint.compactions.at(-1)

    expect(projection.actions).toEqual(expect.arrayContaining(['compacted', 'agentic']))
    expect(artifact).toBeDefined()
    expect(artifact?.sourceMessageIds.length).toBeGreaterThan(0)
    expect(artifact?.canonicalPrefixHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(projection.messages.some(message => message.content.includes('ship the approved feature'))).toBe(true)
    expect(checkpoint.transcript).toHaveLength(10)
  })

  it('falls back deterministically when a provider and agentic summarizer fail', async () => {
    const store = new MemoryContextCheckpointStore()
    const manager = await ContextManager.open('fallback', store, {
      ...limits,
      retainRecentMessages: 1,
      summarizer: async () => { throw new Error('summary provider unavailable') },
      nativeCompaction: {
        id: 'qwen-compatible',
        supports: async () => true,
        compact: async () => { throw new Error('native endpoint has no compact operation') },
      },
    })
    manager.append(Array.from({ length: 8 }, (_, index) => ({ id: `fallback-${index}`, role: index === 0 ? 'user' as const : 'assistant' as const, content: index === 7 ? 'recent continuation' : `${index === 0 ? 'OBJECTIVE: retain this' : 'CONSTRAINT: keep auditability'} ${'long '.repeat(80)}` })))

    const projection = await manager.prepare()

    expect(projection.actions).toEqual(expect.arrayContaining(['compacted', 'fallback']))
    expect(manager.snapshot().compactions.at(-1)?.strategy).toBe('deterministic')
    expect(projection.messages.some(message => message.content.includes('Objective: OBJECTIVE: retain this'))).toBe(true)
  })

  it('persists a thread checkpoint and does not repeat completed tools after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-manager-'))
    try {
      const store = new FileContextCheckpointStore(root)
      const first = await ContextManager.open('restart-thread', store, { ...limits })
      first.append([{ id: 'user-1', role: 'user', content: 'continue the task' }])
      first.recordToolCall('tool-complete', 'completed')
      first.recordToolCall('tool-retry', 'failed')
      await first.saveCheckpoint()

      const resumed = await ContextManager.open('restart-thread', store, { ...limits })
      expect(resumed.shouldExecuteTool('tool-complete')).toBe(false)
      expect(resumed.shouldExecuteTool('tool-retry')).toBe(true)
      expect(resumed.snapshot().transcript).toEqual(first.snapshot().transcript)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not create checkpoint directories during a read-only load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-manager-read-'))
    try {
      const store = new FileContextCheckpointStore(root)
      expect(await store.load('missing-thread')).toBeNull()
      await expect(lstat(join(root, '.backend-team'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses a monotonic PostgreSQL checkpoint contract without owning the database connection', async () => {
    const database = new FakeCheckpointDatabase()
    const store = new PostgresContextCheckpointStore(database)
    const manager = await ContextManager.open('postgres-thread', store, { ...limits })
    manager.append([{ id: 'pg-user', role: 'user', content: 'resume the PostgreSQL-backed thread' }])
    await manager.saveCheckpoint()

    const resumed = await ContextManager.open('postgres-thread', store, { ...limits })
    expect(resumed.snapshot().transcript[0]?.content).toBe('resume the PostgreSQL-backed thread')
    expect(database.schemaCalls).toBe(1)
    expect(database.statements.some(statement => statement.includes('revision <= EXCLUDED.revision'))).toBe(true)
  })

  it('rolls back when no complete context group can be compacted', async () => {
    const store = new MemoryContextCheckpointStore()
    const manager = await ContextManager.open('rollback', store, { ...limits, retainRecentMessages: 20 })
    manager.append(Array.from({ length: 4 }, (_, index) => ({ id: `rollback-${index}`, role: 'user' as const, content: 'large context '.repeat(60) })))
    await manager.saveCheckpoint()
    const before = manager.snapshot()

    await expect(manager.prepare()).rejects.toBeInstanceOf(ContextCompactionError)
    expect(manager.snapshot()).toEqual(before)
    expect((await store.load('rollback'))?.compactions).toHaveLength(0)
  })

  it('never cuts an assistant tool call away from its tool result', async () => {
    const store = new MemoryContextCheckpointStore()
    const manager = await ContextManager.open('tool-pair', store, { ...limits, retainRecentMessages: 1 })
    manager.append([
      { id: 'pair-user', role: 'user', content: 'OBJECTIVE: inspect the database.' },
      { id: 'pair-assistant', role: 'assistant', toolCallId: 'pair-call', content: 'call the database tool' },
      { id: 'pair-tool', role: 'tool', toolCallId: 'pair-call', content: 'database result '.repeat(200) },
      { id: 'pair-final', role: 'assistant', content: 'NEXT: report the result.' },
      { id: 'pair-next', role: 'user', content: 'continue' },
    ])

    await manager.prepare()
    const source = manager.snapshot().compactions.at(-1)?.sourceMessageIds ?? []
    expect(source.includes('pair-assistant')).toBe(source.includes('pair-tool'))
  })

  it('does not reuse a compaction artifact after its canonical prefix is tampered with', async () => {
    const store = new MemoryContextCheckpointStore()
    const tamperLimits = { ...limits, contextWindowTokens: 420, outputLimitTokens: 40, toolBufferTokens: 20, safetyMarginTokens: 20, maxSummaryTokens: 96 }
    const manager = await ContextManager.open('tamper', store, { ...tamperLimits, retainRecentMessages: 2 })
    manager.append(Array.from({ length: 10 }, (_, index) => ({
      id: `tamper-${index}`,
      role: index === 0 ? 'system' as const : index % 2 === 0 ? 'assistant' as const : 'user' as const,
      content: index >= 8 ? 'recent continuation' : `${'long context '.repeat(42)}`,
    })))
    await manager.prepare()
    const saved = manager.snapshot()
    await store.save({ ...saved, transcript: saved.transcript.map((message, index) => index === 1 ? { ...message, content: 'tampered canonical prefix' } : message) })

    const resumed = await ContextManager.open('tamper', store, { ...tamperLimits, retainRecentMessages: 2 })
    await resumed.prepare()
    expect(resumed.snapshot().compactions.length).toBe(2)
  })
})

class FakeCheckpointDatabase implements PostgresCheckpointQueryPort {
  private checkpoint: ContextCheckpoint | undefined
  schemaCalls = 0
  readonly statements: string[] = []

  async query<T extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<readonly T[]> {
    this.statements.push(text)
    if (text.startsWith('CREATE TABLE')) { this.schemaCalls += 1; return [] }
    if (text.startsWith('SELECT payload')) return this.checkpoint === undefined ? [] : [{ payload: this.checkpoint } as T]
    if (text.startsWith('INSERT INTO')) {
      const revision = values[1]
      const payload = values[2]
      if (typeof revision !== 'number' || typeof payload !== 'string') throw new Error('fake query received invalid values')
      if (this.checkpoint === undefined || revision >= this.checkpoint.revision) this.checkpoint = JSON.parse(payload) as ContextCheckpoint
      return []
    }
    throw new Error(`unexpected SQL: ${text}`)
  }
}
