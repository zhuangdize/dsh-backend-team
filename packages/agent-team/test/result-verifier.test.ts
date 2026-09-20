import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentHandoffSchema, AgentResultSchema, AgentTaskSchema, type AgentResult } from '@dsh-backend-team/contracts'
import { HandoffStore } from '../src/handoff-store.js'
import { ResultVerifier } from '../src/result-verifier.js'

const hash = 'a'.repeat(64)
const task = AgentTaskSchema.parse({
  id: 'worker-verify', parentTaskId: 'expert-1', depth: 2, role: 'worker', objective: 'Implement endpoint.', nonGoals: ['Do not touch unrelated files.'],
  inputArtifacts: [{ path: 'specs/users.md', sha256: hash }], readPaths: ['src', 'specs'], writePaths: ['src/users'], capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true },
  budget: { maxTokens: 100, maxWallMs: 1000, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 }, doneWhen: ['Tests pass.'], verification: [{ id: 'tests', kind: 'test', instruction: 'Run tests.', required: true }], returnSchema: 'handoff-v1',
})
const validResult: AgentResult = AgentResultSchema.parse({
  taskId: task.id, status: 'passed', summary: 'Done.', changedPaths: [{ path: 'src/users/service.ts', beforeSha256: null, afterSha256: 'b'.repeat(64) }],
  commands: [{ argv: ['npm', 'test'], exitCode: 0 }], evidencePaths: ['src/users/service.ts'], risks: [], unresolvedItems: [], consumedBudget: { tokens: 10, wallMs: 20, toolCalls: 1, retries: 0, children: 0 }, childResultIds: [],
  verification: { status: 'passed', verifiedBy: 'worker-verify', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'tests', outcome: 'passed', evidencePaths: ['src/users/service.ts'] }] },
})

describe('ResultVerifier', () => {
  it('accepts a fresh, owned, fully evidenced result', async () => {
    const decision = await new ResultVerifier().verify(task, validResult, { currentArtifactHashes: { 'specs/users.md': hash } })
    expect(decision.status).toBe('accepted')
  })

  it('rejects a passed result with an undeclared changed file', async () => {
    const result = { ...validResult, changedPaths: [{ path: 'src/outside-owner.ts', beforeSha256: null, afterSha256: 'b'.repeat(64) }] }
    await expect(new ResultVerifier().verify(task, result, { currentArtifactHashes: { 'specs/users.md': hash } })).rejects.toThrow('undeclared change')
  })

  it('rejects stale inputs and missing child acknowledgements', async () => {
    await expect(new ResultVerifier().verify(task, validResult, { currentArtifactHashes: { 'specs/users.md': 'c'.repeat(64) } })).rejects.toThrow(/stale input/i)
    const parent = AgentTaskSchema.parse({ ...task, id: 'expert-1', parentTaskId: 'coordinator-1', depth: 1, role: 'developer', writePaths: ['src/users'], capabilities: { readProjectFiles: true, canDelegate: true }, budget: { maxTokens: 100, maxWallMs: 1000, maxToolCalls: 10, maxRetries: 1, maxChildren: 3 } })
    const childResult = { ...validResult, taskId: parent.id, childResultIds: ['child-1'] }
    await expect(new ResultVerifier().verify(parent, childResult, { currentArtifactHashes: { 'specs/users.md': hash } })).rejects.toThrow(/acknowledg/i)

    const root = mkdtempSync(resolve(tmpdir(), 'agent-verifier-'))
    try {
      const handoffStore = new HandoffStore(root)
      const childHandoff = AgentHandoffSchema.parse({
        id: 'child-1', taskId: 'child-worker', status: 'completed', summary: 'Child complete.', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [],
        consumedBudget: { tokens: 1, wallMs: 2, toolCalls: 1, retries: 0, children: 0 }, childResultIds: [], parentVerification: { status: 'pending' },
      })
      handoffStore.write(childHandoff, parent.id)
      handoffStore.acknowledge(childHandoff.id, parent.id)
      const decision = await new ResultVerifier().verify(parent, childResult, { currentArtifactHashes: { 'specs/users.md': hash }, handoffStore })
      expect(decision.status).toBe('accepted')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns needs-rework for a valid but failed execution', async () => {
    const failed = AgentResultSchema.parse({ ...validResult, status: 'failed', summary: 'Tests failed.', commands: [{ argv: ['npm', 'test'], exitCode: 1 }], verification: { ...validResult.verification, status: 'failed', records: [{ instructionId: 'tests', outcome: 'failed', evidencePaths: [] }] } })
    const decision = await new ResultVerifier().verify(task, failed, { currentArtifactHashes: { 'specs/users.md': hash } })
    expect(decision.status).toBe('needs-rework')
  })
})
