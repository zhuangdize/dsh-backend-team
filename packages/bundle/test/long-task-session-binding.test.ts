import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentTaskSchema } from '@dsh-backend-team/contracts'
import { OwnershipManager, ownershipPort, type LongTaskRunLeasePort } from '@dsh-backend-team/agent-team'
import { createLongTaskExecutionSessionFactory } from '../src/long-task-session-binding.js'

class SingleRunLease implements LongTaskRunLeasePort {
  private active = false
  async acquire(): Promise<() => Promise<void>> {
    if (this.active) throw new Error('run lease is busy')
    this.active = true
    let released = false
    return async () => { if (!released) { released = true; this.active = false } }
  }
}

const task = AgentTaskSchema.parse({
  id: 'binding-task', parentTaskId: 'coordinator', depth: 1, role: 'developer', objective: 'persist context', nonGoals: ['no deployment'],
  inputArtifacts: [], readPaths: ['src'], writePaths: ['src'],
  capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, testCodeWrite: true, configurationWrite: true, commandExecution: false, networkHosts: [], install: false, migration: false, canDelegate: false, canChangePhase: false, canApprove: false, canContactUser: false, canAnnounceCompletion: true },
  budget: { maxTokens: 100, maxWallMs: 1000, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 }, doneWhen: ['context is saved'],
  verification: [{ id: 'inspect', kind: 'inspection', instruction: 'inspect', required: true }], returnSchema: 'AgentResult',
})

describe('long-task session binding', () => {
  it('binds the existing session to Harness and renders the bounded projection', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'long-task-binding-'))
    try {
      mkdirSync(resolve(root, 'src'))
      const ownership = new OwnershipManager({ workspaceRoot: root, recoveryToken: 'long-task-binding-token-1234' })
      const lease = ownership.acquire(task.id, ['src'], 'write')
      const runLease = new SingleRunLease()
      const factory = createLongTaskExecutionSessionFactory({
        workspaceRoot: root,
        runLease,
        ownership: ownershipPort(ownership),
        contextOptions: { contextWindowTokens: 300, outputLimitTokens: 30, toolBufferTokens: 20, safetyMarginTokens: 20 },
        renderPrompt: ({ prompt, projection }) => `${prompt}\ncontext-hash=${projection.contextHash}`,
      })
      const session = await factory({ request: { task: task.objective, role: task.role, context: {}, agentTask: task }, sessionId: 'harness-session', prompt: 'model request' })
      if (session === undefined) throw new Error('expected the development task to bind a long-task session')
      await session.append([{ id: 'assistant-1', role: 'assistant', content: 'checkpointed result' }])
      const preparation = await session.prepareContext()
      expect(preparation.prompt).toContain('context-hash=')
      expect(preparation.contextHash).toMatch(/^[a-f0-9]{64}$/u)
      session.consumeModelTokens(5)
      await session.close()
      ownership.release(lease)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses a second session while the host run lease is held', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'long-task-binding-lock-'))
    try {
      mkdirSync(resolve(root, 'src'))
      const ownership = new OwnershipManager({ workspaceRoot: root, recoveryToken: 'long-task-binding-token-1234' })
      const lease = ownership.acquire(task.id, ['src'], 'write')
      const runLease = new SingleRunLease()
      const factory = createLongTaskExecutionSessionFactory({ workspaceRoot: root, runLease, ownership: ownershipPort(ownership), contextOptions: { contextWindowTokens: 300, outputLimitTokens: 30, toolBufferTokens: 20, safetyMarginTokens: 20 } })
      const input = { request: { task: task.objective, role: task.role, context: {}, agentTask: task }, sessionId: 'harness-session', prompt: 'model request' }
      const first = await factory(input)
      if (first === undefined) throw new Error('expected the development task to bind a long-task session')
      await expect(factory({ ...input, sessionId: 'another-session' })).rejects.toThrow(/busy/i)
      await first.close()
      ownership.release(lease)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('can leave non-development agents on the normal Harness lifecycle', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'long-task-binding-skip-'))
    try {
      const factory = createLongTaskExecutionSessionFactory({
        workspaceRoot: root,
        runLease: new SingleRunLease(),
        ownership: { assert: () => { throw new Error('ownership should not be checked for skipped agents') } },
        contextOptions: { contextWindowTokens: 300, outputLimitTokens: 30, toolBufferTokens: 20, safetyMarginTokens: 20 },
        shouldBind: () => false,
      })
      await expect(factory({ request: { task: 'specification', role: 'backend-architect', context: {}, agentTask: task }, sessionId: 'spec-session', prompt: 'model request' })).resolves.toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
