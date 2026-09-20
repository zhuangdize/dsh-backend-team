import type { HarnessCapabilityReport, HarnessToolDefinition } from '@dsh-backend-team/harness-adapter'

export interface BundleDiagnosticReport {
  readonly version: string
  readonly mode: 'read-only'
  readonly reasons: readonly string[]
  readonly missing: readonly string[]
  readonly evidenceStatus: string
}

const PARAMETERS = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  additionalProperties: false,
})

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    version: Object.freeze({ type: 'string' }),
    mode: Object.freeze({ type: 'string', const: 'read-only' }),
    reasons: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
    missing: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
    evidenceStatus: Object.freeze({ type: 'string' }),
  }),
  required: ['version', 'mode', 'reasons', 'missing', 'evidenceStatus'],
  additionalProperties: false,
})

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
  }
  return value
}

export function makeDiagnosticReport(report: HarnessCapabilityReport): BundleDiagnosticReport {
  return freezeDeep({
    version: report.version,
    mode: 'read-only',
    reasons: [...report.reasons],
    missing: [...report.missingCapabilities],
    evidenceStatus: report.entryStatus,
  })
}

function isPlainEmptyObject(value: unknown): value is Record<string, never> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === 0
  } catch {
    return false
  }
}

function abortError(): Error {
  const error = new Error('diagnostic execution aborted')
  error.name = 'AbortError'
  return error
}

function renderDiagnosticValue(value: unknown): Array<{ readonly type: 'text'; readonly text: string }> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ type: 'text', text: 'Backend Team status unavailable.' }]
    const record = value as Record<string, unknown>
    const version = typeof record.version === 'string' ? record.version : 'unknown'
    const mode = record.mode === 'read-only' ? 'read-only' : 'unknown'
    const evidenceStatus = typeof record.evidenceStatus === 'string' ? record.evidenceStatus : 'unknown'
    const missing = safeTextList(record.missing)
    const reasons = safeTextList(record.reasons)
    const details = [
      ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
      ...(reasons.length > 0 ? [`reason: ${reasons.join('; ')}`] : []),
    ]
    const suffix = details.length > 0 ? ` ${details.join(' ')}` : ''
    return [{ type: 'text', text: `Backend Team Harness status: ${mode} (version ${version}, evidence ${evidenceStatus}).${suffix}` }]
  } catch {
    return [{ type: 'text', text: 'Backend Team status unavailable.' }]
  }
}

function safeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, 8).map((item) => item.slice(0, 200))
}

function readSignal(execution: unknown): AbortSignal {
  try {
    if (typeof execution !== 'object' || execution === null) throw new TypeError('official execution context is required')
    const signal = Reflect.get(execution, 'signal')
    if (typeof signal !== 'object' || signal === null || typeof Reflect.get(signal, 'aborted') !== 'boolean') throw new TypeError('official execution signal is required')
    return signal as AbortSignal
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error
    throw new TypeError('official execution signal is required')
  }
}

export function createDiagnosticTool(report: BundleDiagnosticReport): HarnessToolDefinition {
  return {
    name: 'backend_team_status',
    description: 'Reports Backend Agent Team Harness compatibility without changing the workspace.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown) {
        return renderDiagnosticValue(value)
      },
    },
    async execute(args: unknown, execution: unknown) {
      const signal = readSignal(execution)
      if (signal.aborted) throw abortError()
      if (!isPlainEmptyObject(args)) throw new TypeError('diagnostic parameters must be an empty object')
      return report
    },
  }
}
