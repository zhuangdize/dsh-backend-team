import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySaver } from '@langchain/langgraph'
import { MemoryContextCheckpointStore, type ContextMessage } from '../../../packages/agent-team/src/context-manager.js'
import { LongTaskKernel } from '../src/kernel.js'

const limits = {
  contextWindowTokens: 420,
  outputLimitTokens: 40,
  toolBufferTokens: 20,
  safetyMarginTokens: 20,
  retainRecentMessages: 2,
  maxSummaryTokens: 96,
}

test('LangGraph interrupt resumes from a checkpoint without repeating a completed tool', async () => {
  const store = new MemoryContextCheckpointStore()
  let toolRuns = 0
  const kernel = new LongTaskKernel({
    checkpointer: new MemorySaver(),
    contextStore: store,
    contextOptions: limits,
    tool: async () => { toolRuns += 1 },
  })
  const first = await kernel.run('memory-thread', { userMessage: 'Inspect the database and wait for approval.' })
  assert.equal(first.interrupted, true)
  assert.equal(toolRuns, 1)
  assert.equal(first.state.toolExecutions, 1)
  assert.match(JSON.stringify(first.state.__interrupt__), /database result/i)

  const resumed = await kernel.run('memory-thread', { resume: 'approved' })
  assert.equal(resumed.interrupted, false)
  assert.equal(resumed.state.result, 'approved:approved')
  assert.equal(resumed.state.toolExecutions, 1)
  assert.equal(toolRuns, 1)
  assert.equal((await kernel.managerSnapshot('memory-thread')).toolCalls[0]?.status, 'completed')
})

test('ContextManager compacts before the graph and keeps the canonical transcript across HITL', async () => {
  const store = new MemoryContextCheckpointStore()
  const kernel = new LongTaskKernel({
    checkpointer: new MemorySaver(),
    contextStore: store,
    contextOptions: limits,
    tool: async () => undefined,
  })
  const messages: ContextMessage[] = Array.from({ length: 10 }, (_, index) => ({
    id: `history-${index}`,
    role: index === 0 ? 'system' : index % 2 === 0 ? 'assistant' : 'user',
    content: index >= 8 ? 'recent continuation' : `${index === 1 ? 'OBJECTIVE: preserve the approved plan.' : 'DECISION: keep the current implementation.'} ${'long context '.repeat(42)}`,
  }))
  await kernel.appendContext('compact-thread', messages)

  const first = await kernel.run('compact-thread')
  const snapshot = await kernel.managerSnapshot('compact-thread')
  assert.equal(first.interrupted, true)
  assert.ok(first.projection.actions.includes('compacted'))
  assert.ok(snapshot.compactions.length >= 1)
  assert.equal(snapshot.transcript.length, messages.length)
  assert.equal(first.state.contextHash, first.projection.contextHash)

  const resumed = await kernel.run('compact-thread', { resume: 'approved' })
  assert.equal(resumed.state.result, 'approved:approved')
  assert.equal((await kernel.managerSnapshot('compact-thread')).transcript.length, messages.length)
})

test('concurrent prepare calls for one thread serialize and keep one compaction artifact', async () => {
  const store = new MemoryContextCheckpointStore()
  const kernel = new LongTaskKernel({
    checkpointer: new MemorySaver(),
    contextStore: store,
    contextOptions: limits,
    tool: async () => undefined,
  })
  await kernel.appendContext('concurrent-thread', Array.from({ length: 10 }, (_, index) => ({
    id: `concurrent-${index}`,
    role: index === 0 ? 'system' as const : index % 2 === 0 ? 'assistant' as const : 'user' as const,
    content: index >= 8 ? 'recent continuation' : `${'long context '.repeat(42)}`,
  })))

  const projections = await Promise.all([
    kernel.prepareContext('concurrent-thread'),
    kernel.prepareContext('concurrent-thread'),
  ])
  const snapshot = await kernel.managerSnapshot('concurrent-thread')
  assert.equal(snapshot.compactions.length, 1)
  assert.equal(projections[0]?.contextHash, projections[1]?.contextHash)
  assert.equal(snapshot.transcript.length, 10)
})
