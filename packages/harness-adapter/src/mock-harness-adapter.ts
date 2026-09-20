import type {
  HarnessMonotonicGuard,
  HarnessToolDefinition,
  HarnessToolExecution,
} from './structural-context.js'
import { isPositiveFiniteHarnessTimeout, isSupportedHarnessJsonSchema } from './structural-context.js'
import { DIAGNOSTIC_TOOL_NAME, HarnessCapabilityUnavailableError, RESERVED_TOOL_NAME } from './deepseek-harness-adapter.js'

/** Deterministic duplicate registration failure for the official tools mock. */
export class DuplicateHarnessToolError extends Error {
  constructor(name: string) {
    super(`Mock Harness tool already registered: ${name}`)
    this.name = 'DuplicateHarnessToolError'
  }
}

export interface MockHarnessAdapterOptions {
  readonly initialTools?: readonly HarnessToolDefinition[]
  readonly initialGuards?: readonly HarnessMonotonicGuard[]
}

export interface MockHarnessSnapshot {
  readonly tools: readonly string[]
  readonly guards: number
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

const MOCK_MISSING = Symbol('missing mock tool field')

function read(value: unknown, key: PropertyKey): unknown | typeof MOCK_MISSING {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return MOCK_MISSING
    return Reflect.get(value, key)
  } catch {
    return MOCK_MISSING
  }
}

function safeObjectKeys(value: object): string[] | undefined {
  try {
    return Object.keys(value)
  } catch {
    return undefined
  }
}

function validateToolDefinition(value: unknown, capability: string): asserts value is HarnessToolDefinition {
  if (!isPlainRecord(value)) throw new HarnessCapabilityUnavailableError(capability)
  const name = read(value, 'name')
  const description = read(value, 'description')
  const parameters = read(value, 'parameters')
  const output = read(value, 'output')
  const execute = read(value, 'execute')
  if (typeof name !== 'string' || name.length === 0 || typeof description !== 'string' || description.length === 0 || typeof execute !== 'function') {
    throw new HarnessCapabilityUnavailableError(capability)
  }
  if (name === RESERVED_TOOL_NAME) throw new HarnessCapabilityUnavailableError('reserved-tool-name')
  if (!isPlainRecord(parameters)) throw new HarnessCapabilityUnavailableError(`${capability}-parameters`)
  if (!isPlainRecord(output)) throw new HarnessCapabilityUnavailableError(`${capability}-output`)
  const schema = read(output, 'schema')
  if (!isPlainRecord(schema) || !isSupportedHarnessJsonSchema(schema)) throw new HarnessCapabilityUnavailableError(`${capability}-output-schema`)
  if (typeof read(output, 'render') !== 'function') {
    throw new HarnessCapabilityUnavailableError(`${capability}-output-contract`)
  }
  const presentationMeta = read(output, 'presentationMeta')
  if (presentationMeta !== MOCK_MISSING && presentationMeta !== undefined && typeof presentationMeta !== 'function') throw new HarnessCapabilityUnavailableError(`${capability}-presentationMeta`)
  const timeoutMs = read(value, 'timeoutMs')
  if (timeoutMs !== MOCK_MISSING && timeoutMs !== undefined && !isPositiveFiniteHarnessTimeout(timeoutMs)) throw new HarnessCapabilityUnavailableError(`${capability}-timeout`)
}

function validateDiagnosticDefinition(value: HarnessToolDefinition): void {
  if (read(value, 'name') !== DIAGNOSTIC_TOOL_NAME) throw new HarnessCapabilityUnavailableError('diagnostic-tool-contract')
  const parameters = read(value, 'parameters')
  if (!isPlainRecord(parameters) || read(parameters, 'type') !== 'object' || read(parameters, 'additionalProperties') !== false) {
    throw new HarnessCapabilityUnavailableError('diagnostic-tool-parameters')
  }
  const properties = read(parameters, 'properties')
  const propertyKeys = isPlainRecord(properties) ? safeObjectKeys(properties) : undefined
  if (!propertyKeys || propertyKeys.length !== 0) {
    throw new HarnessCapabilityUnavailableError('diagnostic-tool-parameters')
  }
}

function validateGuard(value: unknown): asserts value is HarnessMonotonicGuard {
  if (typeof value !== 'function') throw new HarnessCapabilityUnavailableError('monotonic-guard-contract')
}

function freezeSnapshot(snapshot: MockHarnessSnapshot): MockHarnessSnapshot {
  Object.freeze(snapshot.tools)
  return Object.freeze(snapshot)
}

/**
 * A conservative fail-closed test double for the public `ctx.tools` service.
 * Its local schema precheck is not a replacement for the rc.6 runtime: the
 * host remains authoritative for cross-realm values and extremely deep trees.
 *
 * It intentionally does not implement approvals, agents, events, or any
 * other application orchestration port. Those belong to a separate mock.
 */
export class MockHarnessAdapter {
  readonly #tools = new Map<string, HarnessToolDefinition>()
  readonly #guards = new Map<number, HarnessMonotonicGuard>()
  #sequence = 0

  constructor(options: MockHarnessAdapterOptions = {}) {
    for (const tool of options.initialTools ?? []) this.register(tool)
    for (const guard of options.initialGuards ?? []) this.guard(guard)
  }

  registerTool(definition: unknown): () => void {
    validateToolDefinition(definition, 'tool-contract')
    if (read(definition, 'name') === DIAGNOSTIC_TOOL_NAME) throw new HarnessCapabilityUnavailableError('diagnostic-registration-api')
    return this.registerDefinition(definition as HarnessToolDefinition)
  }

  /** Exact official `ctx.tools.register` test-double contract. */
  register(definition: unknown): () => void {
    validateToolDefinition(definition, 'tool-contract')
    return this.registerDefinition(definition)
  }

  registerDiagnosticTool(definition: unknown): () => void {
    validateToolDefinition(definition, 'diagnostic-tool-contract')
    validateDiagnosticDefinition(definition)
    return this.registerDefinition(definition)
  }

  registerMonotonicGuard(guard: unknown): () => void {
    return this.guard(guard)
  }

  /** Exact official `ctx.tools.guard` test-double contract. */
  guard(guard: unknown): () => void {
    validateGuard(guard)
    const sequence = this.#sequence
    this.#sequence += 1
    this.#guards.set(sequence, guard)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.#guards.delete(sequence)
    }
  }

  runGuards(execution: Readonly<HarnessToolExecution>): string | undefined {
    for (const guard of this.#guards.values()) {
      const reason = guard(execution)
      if (reason !== undefined && typeof reason !== 'string') {
        throw new HarnessCapabilityUnavailableError('monotonic-guard-result')
      }
      if (reason !== undefined) return reason
    }
    return undefined
  }

  snapshot(): MockHarnessSnapshot {
    return freezeSnapshot({ tools: [...this.#tools.keys()], guards: this.#guards.size })
  }

  private registerDefinition(definition: HarnessToolDefinition): () => void {
    const name = read(definition, 'name')
    if (typeof name !== 'string') throw new HarnessCapabilityUnavailableError('tool-contract')
    if (this.#tools.has(name)) throw new DuplicateHarnessToolError(name)
    this.#tools.set(name, definition)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#tools.get(name) === definition) this.#tools.delete(name)
    }
  }
}
