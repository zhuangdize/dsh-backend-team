import { describe, expect, it } from 'vitest'
import {
  AgentBudgetSchema,
  AgentCapabilitySetSchema,
  AgentHandoffSchema,
  AgentResultSchema,
  AgentTaskSchema,
} from '../src/index.js'

const sha256 = 'a'.repeat(64)

const capabilities = AgentCapabilitySetSchema.parse({
  readProjectFiles: true,
  writeOwnedFiles: true,
  businessCodeWrite: true,
  commandExecution: true,
  canDelegate: true,
})

const budget = AgentBudgetSchema.parse({ maxTokens: 1_000, maxWallMs: 10_000, maxToolCalls: 10, maxRetries: 1, maxChildren: 3 })

const task = {
  id: 'task-1',
  parentTaskId: 'coordinator-task',
  depth: 1,
  role: 'developer',
  objective: 'Implement a bounded API endpoint.',
  nonGoals: ['Do not change the database schema.'],
  inputArtifacts: [{ path: 'spec.md', sha256 }],
  readPaths: ['src'],
  writePaths: ['src/users'],
  capabilities,
  budget,
  doneWhen: ['The requested endpoint has a focused test.'],
  verification: [{ id: 'unit-test', kind: 'command', instruction: 'Run the focused unit test.', required: true }],
  returnSchema: 'AgentResult',
} as const

describe('bounded agent contracts', () => {
  it('rejects a task without non-goals, evidence, verification, or return schema', () => {
    expect(() => AgentTaskSchema.parse({ id: 'task-1', objective: 'Implement API' })).toThrow()
  })

  it('defaults every omitted capability to deny', () => {
    expect(AgentCapabilitySetSchema.parse({})).toMatchObject({
      readProjectFiles: false,
      writeOwnedFiles: false,
      businessCodeWrite: false,
      commandExecution: false,
      networkHosts: [],
      install: false,
      migration: false,
      canDelegate: false,
      canChangePhase: false,
      canApprove: false,
      canContactUser: false,
      canAnnounceCompletion: false,
    })
  })

  it('accepts coordinator, expert, and worker depths but rejects worker delegation at depth two', () => {
    expect(AgentTaskSchema.parse({ ...task, depth: 0, parentTaskId: null, role: 'coordinator', capabilities: { ...capabilities, canDelegate: true } }).depth).toBe(0)
    expect(AgentTaskSchema.parse(task).depth).toBe(1)
    expect(AgentTaskSchema.parse({ ...task, depth: 2, parentTaskId: 'task-1', role: 'worker', capabilities: { ...capabilities, canDelegate: false }, budget: { ...budget, maxChildren: 0 } }).depth).toBe(2)
    expect(() => AgentTaskSchema.parse({ ...task, depth: 2, parentTaskId: 'task-1', role: 'worker', capabilities: { ...capabilities, canDelegate: true } })).toThrow(/depth two|delegate/i)
  })

  it('binds coordinator and worker roles to their topology depth and rejects workspace-root ownership', () => {
    expect(() => AgentTaskSchema.parse({ ...task, depth: 0, role: 'developer' })).toThrow(/coordinator|depth zero/i)
    expect(() => AgentTaskSchema.parse({ ...task, depth: 2, parentTaskId: 'task-1', role: 'developer', capabilities: { ...capabilities, canDelegate: false } })).toThrow(/worker|depth two/i)
    expect(() => AgentTaskSchema.parse({ ...task, depth: 1, role: 'worker' })).toThrow(/expert|depth one/i)
    expect(() => AgentTaskSchema.parse({ ...task, readPaths: ['.'] })).toThrow(/workspace-relative|path/i)
  })

  it('requires every expert and worker task to identify its parent task', () => {
    expect(() => AgentTaskSchema.parse({ ...task, parentTaskId: null })).toThrow(/parent task|depth one/i)
    expect(() => AgentTaskSchema.parse({ ...task, depth: 2, parentTaskId: null, role: 'worker', capabilities: { ...capabilities, canDelegate: false } })).toThrow(/parent task|depth two/i)
  })

  it('requires a verification record before an Agent result is accepted', () => {
    expect(() => AgentResultSchema.parse({ taskId: 'task-1', status: 'passed', summary: 'done' })).toThrow(/verification/i)
    expect(AgentResultSchema.parse({
      taskId: 'task-1',
      status: 'passed',
      summary: 'done',
      changedPaths: [{ path: 'src/users.ts', beforeSha256: sha256, afterSha256: 'b'.repeat(64) }],
      commands: [{ argv: ['npm', 'test'], exitCode: 0 }],
      evidencePaths: ['src/users.ts'],
      risks: [],
      unresolvedItems: [],
      consumedBudget: { tokens: 12, wallMs: 50, toolCalls: 1, retries: 0, children: 0 },
      childResultIds: [],
      verification: { status: 'passed', verifiedBy: 'parent-task', verifiedAt: '2026-08-27T00:00:00.000Z', records: [{ instructionId: 'unit-test', outcome: 'passed', evidencePaths: ['src/users.ts'] }] },
    }).status).toBe('passed')
  })

  it('rejects a passed result whose verification or command evidence is not fully passed', () => {
    const result = {
      taskId: 'task-1',
      status: 'passed',
      summary: 'done',
      changedPaths: [],
      commands: [{ argv: ['npm', 'test'], exitCode: 0 }],
      evidencePaths: ['src/users.ts'],
      risks: [],
      unresolvedItems: [],
      consumedBudget: { tokens: 12, wallMs: 50, toolCalls: 1, retries: 0, children: 0 },
      childResultIds: [],
      verification: { status: 'passed', verifiedBy: 'parent-task', verifiedAt: '2026-08-27T00:00:00.000Z', records: [{ instructionId: 'unit-test', outcome: 'passed', evidencePaths: ['src/users.ts'] }] },
    } as const

    expect(() => AgentResultSchema.parse({ ...result, verification: { ...result.verification, status: 'failed' } })).toThrow(/passed|verification/i)
    expect(() => AgentResultSchema.parse({ ...result, verification: { ...result.verification, records: [{ ...result.verification.records[0], outcome: 'not-run' }] } })).toThrow(/passed|outcome/i)
    expect(() => AgentResultSchema.parse({ ...result, commands: [{ argv: ['npm', 'test'], exitCode: 1 }] })).toThrow(/exit code|passed/i)
  })

  it('rejects control characters in task and handoff paths', () => {
    expect(() => AgentTaskSchema.parse({ ...task, readPaths: ['src\u0000/private'] })).toThrow(/path|control/i)
    expect(() => AgentHandoffSchema.parse({
      id: 'handoff-task-1', taskId: 'task-1', status: 'completed', summary: 'done',
      changedPaths: [{ path: 'src\u0000/private.ts', beforeSha256: sha256, afterSha256: 'b'.repeat(64) }], commands: [], evidencePaths: ['spec.md'], risks: [], unresolvedItems: [],
      consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 1, retries: 0, children: 0 }, childResultIds: [], parentVerification: { status: 'pending' },
    })).toThrow(/path|control/i)
  })

  it('requires a parent verification status in every durable handoff', () => {
    expect(() => AgentHandoffSchema.parse({ taskId: 'task-1', status: 'completed', summary: 'done' })).toThrow(/verification|changedPaths/i)
    expect(AgentHandoffSchema.parse({
      id: 'handoff-task-1',
      taskId: 'task-1',
      status: 'completed',
      summary: 'done',
      changedPaths: [],
      commands: [],
      evidencePaths: ['spec.md'],
      risks: [],
      unresolvedItems: [],
      consumedBudget: { tokens: 12, wallMs: 50, toolCalls: 1, retries: 0, children: 0 },
      childResultIds: [],
      parentVerification: { status: 'pending' },
    }).parentVerification.status).toBe('pending')
  })
})
