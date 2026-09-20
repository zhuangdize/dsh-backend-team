import { describe, expect, it } from 'vitest'
import { AgentResultSchema, type AgentSpawnRequest } from '@dsh-backend-team/contracts'
import { AgentResultFormatError, decodeHarnessAgentResult } from '../src/agent-result-decoder.js'

const task: AgentSpawnRequest = {
  task: 'implement API',
  role: 'worker',
  context: {},
  agentTask: { id: 'task-1', parentTaskId: 'parent-1', depth: 1, role: 'worker', objective: 'implement API', nonGoals: [], readPaths: ['src'], writePaths: ['src'], inputArtifacts: [], capabilities: { filesystem: { read: true, write: true }, network: { enabled: false, hosts: [] }, processes: { enabled: false }, database: { enabled: false } }, budget: { maxTokens: 100, maxWallMs: 100, maxToolCalls: 10, maxRetries: 1, maxChildren: 2 }, doneWhen: ['tests pass'], verification: [{ id: 'tests', kind: 'test', instruction: 'Run tests', required: true }], returnSchema: 'AgentResult', childTaskIds: [] },
}

function resultPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: 'task-1',
    status: 'passed',
    summary: 'done',
    changedPaths: [],
    commands: [{ argv: ['npm', 'test'], exitCode: 0 }],
    evidencePaths: [],
    risks: [],
    unresolvedItems: [],
    consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 1, retries: 0, children: 0 },
    childResultIds: [],
    verification: { status: 'passed', verifiedBy: 'worker', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'tests', outcome: 'passed', evidencePaths: [] }] },
    ...overrides,
  }
}

describe('decodeHarnessAgentResult', () => {
  it('tolerates one redundant closing brace without relaxing result or outcome validation', () => {
    const decode = (payload: Record<string, unknown>, suffix: string) => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: JSON.stringify(payload) + suffix }] }, hostUsage: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0 } })
    expect(decode(resultPayload(), '}').status).toBe('passed')
    expect(() => decode(resultPayload({ taskId: 'wrong' }), '}')).toThrow('task ID')
    expect(() => decode(resultPayload({ commands: [{ argv: ['test'], exitCode: 1 }] }), '}')).toThrow()
    expect(() => decode(resultPayload(), '{}')).toThrow(AgentResultFormatError)
  })
  it('parses structured assistant JSON and replaces self-reported usage with host usage', () => {
    const result = decodeHarnessAgentResult({
      request: task,
      assistant: { content: [{ type: 'text', text: JSON.stringify(resultPayload()) }] },
      hostUsage: { tokens: 12, wallMs: 34, toolCalls: 2, retries: 1 },
    })

    expect(result).toMatchObject({ taskId: 'task-1', consumedBudget: { tokens: 12, wallMs: 34, toolCalls: 2, retries: 1, children: 0 } })
    expect(AgentResultSchema.parse(result).taskId).toBe('task-1')
  })

  it('accepts one JSON code fence but rejects prose around the payload', () => {
    const fenced = decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(resultPayload())}\n\`\`\`` }] }, hostUsage: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0 } })
    expect(fenced.taskId).toBe('task-1')
    expect(() => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: `Done:\n${JSON.stringify(resultPayload())}` }] }, hostUsage: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0 } })).toThrow(AgentResultFormatError)
  })

  it('rejects a result for a different scheduled task', () => {
    expect(() => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: JSON.stringify(resultPayload({ taskId: 'other-task' })) }] }, hostUsage: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0 } })).toThrow(/task ID/i)
  })

  it('does not repair a wrong task ID even when the result has an extra top-level field', () => {
    const error = captureError(() => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: JSON.stringify(resultPayload({ taskId: 'other-task', verificationNote: 'extra' })) }] }, hostUsage: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0 } }))

    expect(error).not.toBeInstanceOf(AgentResultFormatError)
    expect(error.message).toMatch(/task ID/i)
  })

  it('marks a result with only unrecognized fields as repairable and exposes generic guidance', () => {
    const error = captureError(() => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: JSON.stringify(resultPayload({ verificationNote: 'model-specific detail' })) }] }, hostUsage: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0 } }))

    expect(error).toBeInstanceOf(AgentResultFormatError)
    expect(error.repairInstruction).toMatch(/AgentResult schema/i)
    expect(error.repairInstruction).not.toContain('model-specific detail')
    expect(error.repairInstruction).not.toContain('task-1')
  })

  it('marks malformed JSON syntax as repairable', () => {
    const error = captureError(() => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: '{"taskId":"task-1"' }] }, hostUsage: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0 } }))

    expect(error).toBeInstanceOf(AgentResultFormatError)
  })

  it.each(['failed', 'not-run'])('explains non-pass verification (%s) without allowing semantic repair', outcome => {
    const error = captureError(() => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: JSON.stringify(resultPayload({ verification: { status: 'passed', verifiedBy: 'worker', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'tests', outcome, evidencePaths: [] }] } })) }] }, hostUsage: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0 } }))

    expect(error).not.toBeInstanceOf(AgentResultFormatError)
    expect(error.message).toContain('Agent 声明通过，但验证记录包含未通过或未执行的检查')
  })

  it('does not repair semantic non-pass verification records hidden by an extra top-level field', () => {
    const error = captureError(() => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: JSON.stringify(resultPayload({ verificationNote: 'extra', verification: { status: 'passed', verifiedBy: 'worker', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'tests', outcome: 'failed', evidencePaths: [] }] } })) }] }, hostUsage: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0 } }))

    expect(error).not.toBeInstanceOf(AgentResultFormatError)
    expect(error.message).toMatch(/schema/i)
  })

  it('does not mark invalid host usage as repairable', () => {
    const error = captureError(() => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: JSON.stringify(resultPayload()) }] }, hostUsage: { tokens: -1, wallMs: 1, toolCalls: 0, retries: 0 } }))

    expect(error).not.toBeInstanceOf(AgentResultFormatError)
    expect(error.message).toMatch(/host usage/i)
  })

  it('rejects invalid host usage before classifying malformed JSON as repairable', () => {
    const error = captureError(() => decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: '{"taskId":"task-1"' }] }, hostUsage: { tokens: -1, wallMs: 1, toolCalls: 0, retries: 0 } }))

    expect(error).not.toBeInstanceOf(AgentResultFormatError)
    expect(error.message).toMatch(/host usage/i)
  })

  it('keeps valid strict results unchanged', () => {
    const result = decodeHarnessAgentResult({ request: task, assistant: { content: [{ type: 'text', text: JSON.stringify(resultPayload()) }] }, hostUsage: { tokens: 12, wallMs: 34, toolCalls: 2, retries: 1 } })

    expect(result.taskId).toBe('task-1')
    expect(result.consumedBudget).toEqual({ tokens: 12, wallMs: 34, toolCalls: 2, retries: 1, children: 0 })
  })
})

function captureError(operation: () => unknown): AgentResultFormatError | Error {
  try { operation() } catch (error) { if (error instanceof Error) return error; return new Error(String(error)) }
  throw new Error('expected operation to throw')
}
