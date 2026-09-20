import { AgentResultSchema, AgentTaskSchema } from '@dsh-backend-team/contracts'
import type { AgentResult, AgentTask } from '@dsh-backend-team/contracts'
import type { HandoffStore } from './handoff-store.js'
import { isPathWithin } from './path-overlap.js'

export interface ResultVerificationOptions {
  /** The coordinator's current workspace hashes; every declared input is checked. */
  readonly currentArtifactHashes: Readonly<Record<string, string>>
  /** Durable handoff store used to verify child result IDs at the parent boundary. */
  readonly handoffStore?: Pick<HandoffStore, 'read'>
}

export interface VerificationDecision {
  readonly status: 'accepted' | 'needs-rework' | 'rejected'
  readonly result: AgentResult
  readonly issues: readonly string[]
}

/** Verifies an agent result at the parent boundary before it can reach the coordinator. */
export class ResultVerifier {
  async verify(inputTask: AgentTask, inputResult: unknown, options: ResultVerificationOptions): Promise<VerificationDecision> {
    const task = AgentTaskSchema.parse(inputTask)
    const parsed = AgentResultSchema.safeParse(inputResult)
    if (!parsed.success) throw new Error('invalid agent result')
    const result = parsed.data
    if (result.taskId !== task.id) throw new Error('result task ID does not match task')

    verifyInputFreshness(task, options.currentArtifactHashes)
    verifyChangedPaths(task, result)
    verifyEvidencePaths(task, result)
    verifyBudget(task, result)
    verifyChildAcknowledgements(task, result, options.handoffStore)
    verifyRequiredInstructions(task, result)

    if (result.status === 'passed') return { status: 'accepted', result, issues: [] }
    return {
      status: 'needs-rework',
      result,
      issues: [result.status === 'failed' ? 'agent execution failed' : `agent execution is ${result.status}`],
    }
  }
}

function verifyInputFreshness(task: AgentTask, current: Readonly<Record<string, string>>): void {
  if (current === undefined || current === null || typeof current !== 'object') throw new Error('current artifact hashes are required')
  for (const artifact of task.inputArtifacts) {
    const actual = current[artifact.path]
    if (actual === undefined || actual !== artifact.sha256) throw new Error(`stale input artifact: ${artifact.path}`)
  }
}

function verifyChangedPaths(task: AgentTask, result: AgentResult): void {
  const seen = new Set<string>()
  if (new Set(result.childResultIds).size !== result.childResultIds.length) throw new Error('duplicate child result ID')
  for (const changed of result.changedPaths) {
    if (seen.has(changed.path)) throw new Error(`duplicate changed path: ${changed.path}`)
    seen.add(changed.path)
    if (!task.writePaths.some((scope) => isPathWithin(changed.path, scope))) throw new Error(`undeclared change: ${changed.path}`)
  }
}

function verifyEvidencePaths(task: AgentTask, result: AgentResult): void {
  const declared = [...task.readPaths, ...task.writePaths]
  for (const evidence of result.evidencePaths) {
    if (!declared.some((scope) => isPathWithin(evidence, scope)) && !isRunEvidencePath(evidence)) throw new Error(`undeclared evidence path: ${evidence}`)
  }
  for (const record of result.verification.records) {
    for (const evidence of record.evidencePaths) {
      if (!declared.some((scope) => isPathWithin(evidence, scope)) && !isRunEvidencePath(evidence)) throw new Error(`undeclared evidence path: ${evidence}`)
    }
  }
}

function verifyBudget(task: AgentTask, result: AgentResult): void {
  const usage = result.consumedBudget
  const limits: readonly [number, number, string][] = [
    [usage.tokens, task.budget.maxTokens, 'tokens'],
    [usage.wallMs, task.budget.maxWallMs, 'wall-clock milliseconds'],
    [usage.toolCalls, task.budget.maxToolCalls, 'tool calls'],
    [usage.retries, task.budget.maxRetries, 'retries'],
    [usage.children, task.budget.maxChildren, 'children'],
  ]
  for (const [actual, limit, label] of limits) if (actual > limit) throw new Error(`budget exceeded: ${label}`)
  if (result.childResultIds.length > task.budget.maxChildren) throw new Error('budget exceeded: children')
}

function verifyChildAcknowledgements(task: AgentTask, result: AgentResult, handoffStore: ResultVerificationOptions['handoffStore']): void {
  if (result.childResultIds.length === 0) return
  if (handoffStore === undefined) throw new Error('durable child acknowledgement store is missing')
  for (const childId of result.childResultIds) {
    let handoff
    try { handoff = handoffStore.read(childId) } catch { throw new Error(`durable child acknowledgement is missing: ${childId}`) }
    if (handoff.parentTaskId !== task.id || handoff.acknowledgedBy !== task.id || handoff.parentVerification.status !== 'accepted' || handoff.status !== 'completed') {
      throw new Error(`child acknowledgement is missing or not accepted: ${childId}`)
    }
  }
}

function verifyRequiredInstructions(task: AgentTask, result: AgentResult): void {
  if (result.status !== 'passed') return
  const records = new Map(result.verification.records.map((record) => [record.instructionId, record]))
  if (result.verification.records.some((record) => !task.verification.some((instruction) => instruction.id === record.instructionId))) throw new Error('verification contains an unknown instruction')
  for (const instruction of task.verification) {
    if (!instruction.required) continue
    const record = records.get(instruction.id)
    if (record === undefined || record.outcome !== 'passed') throw new Error(`required verification did not pass: ${instruction.id}`)
    if (['command', 'test', 'typecheck', 'build', 'lint'].includes(instruction.kind) && result.commands.length === 0) throw new Error(`command evidence is missing: ${instruction.id}`)
  }
}

function isRunEvidencePath(path: string): boolean {
  return /^\.backend-team\/runs\/[^/]+\/verification(?:\/|$)/u.test(path)
}
