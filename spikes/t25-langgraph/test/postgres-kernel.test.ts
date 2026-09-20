import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { dirname } from 'node:path'
import { createPostgresKernel } from '../src/kernel.js'

test('PostgreSQL LangGraph checkpointer survives a process restart and preserves context compaction', async () => {
  const connectionString = process.env.T25_POSTGRES_URL ?? 'postgresql:///postgres?host=/tmp'
  const threadId = `t25-postgres-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let toolRuns = 0
  const firstHandle = await createPostgresKernel({ connectionString, tool: async () => { toolRuns += 1 } })
  try {
    await firstHandle.kernel.appendContext(threadId, Array.from({ length: 10 }, (_, index) => ({
      id: `pg-history-${index}`,
      role: index === 0 ? 'system' as const : index % 2 === 0 ? 'assistant' as const : 'user' as const,
      content: index >= 8 ? 'recent continuation' : `${index === 1 ? 'OBJECTIVE: persist this task.' : 'VERIFY: keep the approved checkpoint.'} ${'long context '.repeat(42)}`,
    })))
    const first = await firstHandle.kernel.run(threadId, { userMessage: 'Inspect the production-like database and request approval.' })
    assert.equal(first.interrupted, true)
    assert.ok(first.projection.actions.includes('compacted'))
    assert.equal(toolRuns, 1)
    await firstHandle.kernel.close()

    const secondHandle = await createPostgresKernel({ connectionString, tool: async () => { toolRuns += 1 } })
    try {
      const recovered = await secondHandle.kernel.getState(threadId)
      assert.equal(recovered.toolExecutions, 1)
      const resumed = await secondHandle.kernel.run(threadId, { resume: 'approved' })
      assert.equal(resumed.interrupted, false)
      assert.equal(resumed.state.result, 'approved:approved')
      assert.equal(resumed.state.toolExecutions, 1)
      assert.equal(toolRuns, 1)
      const snapshot = await secondHandle.kernel.managerSnapshot(threadId)
      assert.equal(snapshot.transcript.length, 11)
      assert.ok(snapshot.compactions.length >= 1)
      await writeEvidence({
        status: 'passed',
        scope: 'T25 isolated LangGraph.js execution kernel with PostgreSQL checkpoint recovery',
        implementation: {
          kernel: 'spikes/t25-langgraph/src/kernel.ts',
          contextManager: 'packages/agent-team/src/context-manager.ts',
          executionSession: 'packages/agent-team/src/long-task-execution-session.ts',
          langgraph: '1.4.15',
          postgresCheckpointer: '1.0.5',
        },
        checks: {
          contextCompaction: true,
          canonicalTranscriptMessages: snapshot.transcript.length,
          compactionArtifacts: snapshot.compactions.length,
          humanApprovalInterruptAndResume: true,
          completedToolRunsBeforeAndAfterRestart: toolRuns,
          duplicateToolExecution: false,
          postgresCheckpointSetup: true,
        },
        database: {
          engine: (await secondHandle.pool.query<{ version: string }>('SELECT version() AS version', [])).rows[0]?.version ?? 'unknown',
          connection: 'local Unix socket (peer authentication)',
          architecture: process.arch,
        },
        threadId,
        verifiedAt: new Date().toISOString(),
      })
      await secondHandle.kernel.deleteThread(threadId)
      await secondHandle.pool.query('DELETE FROM backend_team_context_checkpoints WHERE thread_id = $1', [threadId])
    } finally {
      await secondHandle.kernel.close()
    }
  } catch (error) {
    await firstHandle.pool.query('DELETE FROM backend_team_context_checkpoints WHERE thread_id = $1', [threadId]).catch(() => undefined)
    throw error
  }
})

async function writeEvidence(evidence: Record<string, unknown>): Promise<void> {
  const path = process.env.T25_EVIDENCE_PATH
  if (path === undefined) return
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}
