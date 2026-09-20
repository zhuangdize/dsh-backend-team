import { AgentResultSchema } from '@dsh-backend-team/contracts'
import type { AgentResult, AgentSpawnRequest, ConsumedBudget } from '@dsh-backend-team/contracts'
import { ZodError } from 'zod'

/** A result can be retried once when its envelope is malformed or has extra fields only. */
export class AgentResultFormatError extends Error {
  readonly repairInstruction = 'Return exactly one JSON object matching the declared AgentResult schema. Remove unrecognized fields while preserving all required fields and actual verification outcomes. Do not include prose or markdown fences.'

  constructor() {
    super('assistant result has a repairable format error')
    this.name = 'AgentResultFormatError'
  }
}

export interface HarnessResultDecoderInput {
  readonly request: AgentSpawnRequest
  readonly assistant: { readonly content: readonly unknown[] }
  readonly hostUsage: Pick<ConsumedBudget, 'tokens' | 'wallMs' | 'toolCalls' | 'retries'>
}

/** Decode one model response without trusting model-reported resource usage. */
export function decodeHarnessAgentResult(input: HarnessResultDecoderInput): AgentResult {
  // Validate host-observed usage before parsing model content so malformed output
  // cannot mask a budget or accounting violation.
  assertHostUsage(input.hostUsage)
  const text = extractText(input.assistant.content)
  const payload = parseJson(text)
  if (!isRecord(payload)) throw new Error('assistant result must be a JSON object')
  const expectedTaskId = input.request.agentTask?.id
  if (expectedTaskId !== undefined && payload.taskId !== expectedTaskId) throw new Error('agent result task ID does not match scheduled task')
  const childResultIds = Array.isArray(payload.childResultIds) ? payload.childResultIds.length : 0
  const candidate = {
    ...payload,
    consumedBudget: { ...input.hostUsage, children: childResultIds },
  }
  const parsed = AgentResultSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  // Strict parsing can report only an unknown top-level field before running
  // semantic checks. Classify as repairable only when the known-field projection
  // also satisfies the complete schema. The projection is never returned.
  if (isTopLevelUnrecognizedKeysOnly(parsed.error) && hasValidKnownFieldsProjection(candidate)) {
    throw new AgentResultFormatError()
  }
  const nonPassVerification = parsed.error.issues.some(issue => issue.code === 'custom' && issue.message === 'a passed result requires every verification outcome to pass')
  throw new Error(nonPassVerification ? 'Agent 声明通过，但验证记录包含未通过或未执行的检查（AgentResult schema）' : 'assistant result does not match the AgentResult schema', { cause: parsed.error })
}

function extractText(content: readonly unknown[]): string {
  const text = content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return []
    return [block.text]
  }).join('')
  if (text.trim().length === 0) throw new Error('assistant result has no text content')
  return text.trim()
}

function parseJson(text: string): unknown {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text)?.[1]
  const source = (fenced ?? text).trim()
  try {
    return JSON.parse(source) as unknown
  } catch (error) {
    // Some providers append one redundant closing brace. Accept only a complete
    // JSON object before that brace; the full result schema still validates it.
    if (source.endsWith('}}')) {
      try { const value: unknown = JSON.parse(source.slice(0, -1)); if (isRecord(value)) return value } catch { /* Other malformed output requires model correction. */ }
    }
    if (error instanceof SyntaxError) throw new AgentResultFormatError()
    throw error
  }
}

function isTopLevelUnrecognizedKeysOnly(error: unknown): boolean {
  return error instanceof ZodError && error.issues.length > 0 && error.issues.every((issue) => issue.code === 'unrecognized_keys' && issue.path.length === 0)
}

const AGENT_RESULT_FIELDS = new Set(Object.keys(AgentResultSchema.shape))

function hasValidKnownFieldsProjection(candidate: Record<string, unknown>): boolean {
  const projection = Object.fromEntries(Object.entries(candidate).filter(([key]) => AGENT_RESULT_FIELDS.has(key)))
  return AgentResultSchema.safeParse(projection).success
}

function assertHostUsage(usage: HarnessResultDecoderInput['hostUsage']): void {
  const fields = new Set(['tokens', 'wallMs', 'toolCalls', 'retries'])
  for (const [name, value] of Object.entries(usage)) {
    if (!fields.has(name) || !Number.isSafeInteger(value) || value < 0) throw new Error(`host usage field ${name} is invalid`)
  }
  for (const name of fields) if (!(name in usage)) throw new Error(`host usage field ${name} is invalid`)
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
