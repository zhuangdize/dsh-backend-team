import { assessHarnessCompatibility } from './compatibility.js'
import type { CompatibilityMode, HarnessCapabilityReport } from './compatibility.js'
import type {
  HarnessJsonSchema,
  HarnessMonotonicGuard,
  HarnessStructuralContext,
  HarnessToolDefinition,
} from './structural-context.js'
import {
  invokeWithReceiver,
  isPositiveFiniteHarnessTimeout,
  isSupportedHarnessJsonSchema,
  MissingHarnessMethodError,
} from './structural-context.js'

export const DIAGNOSTIC_TOOL_NAME = 'backend_team_status'
export const RESERVED_TOOL_NAME = 'run_code'
const UNKNOWN_RUNTIME_VERSION = 'unknown'
const CONSTRUCTION_TOKEN = Symbol('DeepSeekHarnessAdapter construction token')
const MISSING = Symbol('missing')

export class HarnessCapabilityUnavailableError extends Error {
  constructor(capability: string) {
    super(`Harness capability unavailable: ${capability}`)
    this.name = 'HarnessCapabilityUnavailableError'
  }
}

export class HarnessReadOnlyError extends Error {
  constructor(operation: string) {
    super(`Harness is read-only; ${operation} is disabled`)
    this.name = 'HarnessReadOnlyError'
  }
}

function safeGet(value: unknown, key: PropertyKey): unknown | typeof MISSING {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return MISSING
    return Reflect.get(value, key)
  } catch {
    return MISSING
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === null || prototype === Object.prototype
  } catch {
    return false
  }
}

function assertSchema(value: unknown, capability: string): asserts value is HarnessJsonSchema {
  if (!isPlainRecord(value)) throw new HarnessCapabilityUnavailableError(capability)
}

function assertToolDefinition(value: unknown, capability = 'tool-contract'): asserts value is HarnessToolDefinition {
  if (!isPlainRecord(value)) throw new HarnessCapabilityUnavailableError(capability)
  const name = safeGet(value, 'name')
  const description = safeGet(value, 'description')
  const parameters = safeGet(value, 'parameters')
  const output = safeGet(value, 'output')
  const execute = safeGet(value, 'execute')
  if (typeof name !== 'string' || name.length === 0 || typeof description !== 'string' || description.length === 0 || execute === MISSING || typeof execute !== 'function') throw new HarnessCapabilityUnavailableError(capability)
  if (name === RESERVED_TOOL_NAME) throw new HarnessCapabilityUnavailableError('reserved-tool-name')
  assertSchema(parameters, `${capability}-parameters`)
  if (!isPlainRecord(output)) throw new HarnessCapabilityUnavailableError(`${capability}-output`)
  const schema = safeGet(output, 'schema')
  const render = safeGet(output, 'render')
  assertSchema(schema, `${capability}-output-schema`)
  if (!isSupportedHarnessJsonSchema(schema)) throw new HarnessCapabilityUnavailableError(`${capability}-output-schema`)
  if (render === MISSING || typeof render !== 'function') throw new HarnessCapabilityUnavailableError(`${capability}-output-render`)
  const presentationMeta = safeGet(output, 'presentationMeta')
  if (presentationMeta !== MISSING && presentationMeta !== undefined && typeof presentationMeta !== 'function') throw new HarnessCapabilityUnavailableError(`${capability}-presentationMeta`)
  const timeoutMs = safeGet(value, 'timeoutMs')
  if (timeoutMs !== MISSING && timeoutMs !== undefined && !isPositiveFiniteHarnessTimeout(timeoutMs)) throw new HarnessCapabilityUnavailableError(`${capability}-timeout`)
}

function assertDiagnosticDefinition(value: HarnessToolDefinition): void {
  const parameters = safeGet(value, 'parameters')
  if (parameters === MISSING) throw new HarnessCapabilityUnavailableError('diagnostic-tool-parameters')
  const type = safeGet(parameters, 'type')
  const properties = safeGet(parameters, 'properties')
  const additionalProperties = safeGet(parameters, 'additionalProperties')
  let propertyCount = -1
  try {
    if (isPlainRecord(properties)) propertyCount = Object.keys(properties).length
  } catch {
    propertyCount = -1
  }
  if (type !== 'object' || !isPlainRecord(properties) || propertyCount !== 0 || additionalProperties !== false) {
    throw new HarnessCapabilityUnavailableError('diagnostic-tool-parameters')
  }
}

function assertMonotonicGuard(value: unknown): asserts value is HarnessMonotonicGuard {
  if (typeof value !== 'function') throw new HarnessCapabilityUnavailableError('monotonic-guard-contract')
}

function snapshotContext(context: HarnessStructuralContext): HarnessStructuralContext {
  const tools = safeGet(context, 'tools')
  return { tools: tools === MISSING ? undefined as never : tools as HarnessStructuralContext['tools'] }
}

export class DeepSeekHarnessAdapter {
  static async create(context: HarnessStructuralContext): Promise<DeepSeekHarnessAdapter> {
    return createAdapter(context)
  }

  readonly #mode: CompatibilityMode
  readonly #report: HarnessCapabilityReport
  readonly #tools: unknown
  readonly #version: string

  private constructor(token: symbol, version: string, report: HarnessCapabilityReport, tools: unknown) {
    if (token !== CONSTRUCTION_TOKEN) throw new TypeError('use DeepSeekHarnessAdapter.create()')
    this.#version = version
    this.#mode = report.mode
    this.#report = report
    this.#tools = tools
  }

  async getRuntimeVersion(): Promise<string> {
    return this.#version
  }

  getCapabilityReport(): HarnessCapabilityReport {
    return this.#report
  }

  registerTool(definition: unknown): () => void {
    this.ensureWritable('registerTool')
    assertToolDefinition(definition)
    return this.registerDefinition(definition)
  }

  registerDiagnosticTool(definition: unknown): () => void {
    assertToolDefinition(definition, 'diagnostic-tool-contract')
    const name = safeGet(definition, 'name')
    if (name !== DIAGNOSTIC_TOOL_NAME) throw new HarnessCapabilityUnavailableError('diagnostic-tool-contract')
    assertDiagnosticDefinition(definition)
    return this.registerDefinition(definition)
  }

  registerMonotonicGuard(guard: unknown): () => void {
    this.ensureWritable('registerMonotonicGuard')
    assertMonotonicGuard(guard)
    const wrapped: HarnessMonotonicGuard = (execution) => {
      const reason = guard(execution)
      if (reason !== undefined && typeof reason !== 'string') throw new HarnessCapabilityUnavailableError('monotonic-guard-result')
      return reason
    }
    return this.callDisposer('monotonic-guard', 'guard', [wrapped])
  }

  private ensureWritable(operation: string): void {
    if (this.#mode === 'read-only') throw new HarnessReadOnlyError(operation)
  }

  private registerDefinition(definition: HarnessToolDefinition): () => void {
    return this.callDisposer('register-tool', 'register', [definition])
  }

  private callDisposer(capability: string, methodName: 'register' | 'guard', args: readonly unknown[]): () => void {
    if (this.#tools === undefined || this.#tools === null) throw new HarnessCapabilityUnavailableError(capability)
    try {
      const disposer = invokeWithReceiver<unknown>(this.#tools, methodName, args)
      if (typeof disposer !== 'function') throw new HarnessCapabilityUnavailableError(`${capability}-disposer`)
      return disposer as () => void
    } catch (error) {
      if (error instanceof MissingHarnessMethodError) throw new HarnessCapabilityUnavailableError(capability)
      throw error
    }
  }
}

async function createAdapter(context: HarnessStructuralContext): Promise<DeepSeekHarnessAdapter> {
  const snapshot = snapshotContext(context)
  const report = fallbackCapabilityReport(snapshot)
  return Reflect.construct(DeepSeekHarnessAdapter, [CONSTRUCTION_TOKEN, UNKNOWN_RUNTIME_VERSION, report, snapshot.tools]) as DeepSeekHarnessAdapter
}

function fallbackCapabilityReport(context: HarnessStructuralContext): HarnessCapabilityReport {
  const report = assessHarnessCompatibility(context)
  return Object.freeze({ ...report, reasons: Object.freeze([...report.reasons, 'runtime-version-unavailable']) })
}
