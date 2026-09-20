/** Lossless JSON value used by official rc.6 schema annotations. */
export type HarnessJsonValue = null | boolean | number | string | HarnessJsonValue[] | { [key: string]: HarnessJsonValue }

/**
 * Conservative local shape for the output schema precheck. It intentionally
 * avoids a runtime dependency on the host package. The real rc.6 runtime is
 * authoritative for cross-realm values and extremely deep schema trees; this
 * check may reject those inputs early rather than widening its trust boundary.
 */
export interface HarnessJsonSchema {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  readonly oneOf?: HarnessJsonSchema[]
  readonly properties?: Record<string, HarnessJsonSchema>
  readonly required?: string[]
  readonly additionalProperties?: boolean
  readonly items?: HarnessJsonSchema
  readonly enum?: Array<string | number | boolean | null>
  readonly const?: string | number | boolean | null
  readonly description?: string
  readonly title?: string
  readonly default?: HarnessJsonValue
  readonly examples?: HarnessJsonValue
}

/** The adapter's diagnostic renderer consumes only the official text block. */
export interface HarnessContentBlock {
  readonly type: 'text'
  readonly text: string
}

export interface HarnessToolOutputDefinition {
  readonly schema: HarnessJsonSchema
  render(args: unknown, value: unknown): HarnessContentBlock[]
}

/** Supertype accepted by the official registry; richer host content remains host-owned. */
export interface HarnessToolRegistrationDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: HarnessJsonSchema
    render(args: unknown, value: unknown): Array<{ readonly type: string }>
    presentationMeta?(args: unknown, value: unknown): HarnessJsonValue
  }
  execute(args: unknown, execution: HarnessToolRunContext): Promise<unknown>
}

export interface HarnessToolExecution {
  readonly token: symbol
  readonly callId: string
  readonly rootCallId: string
  readonly name: string
  readonly arguments: unknown
  readonly signal: AbortSignal
  readonly agent?: unknown
  readonly parent?: symbol
}

export type HarnessToolRunContext = HarnessToolExecution

/** The raw registration contract from the official dsh-tools rc.6 host. */
export interface HarnessToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: HarnessToolOutputDefinition
  execute(args: unknown, execution: HarnessToolRunContext): Promise<unknown>
}

/** A final monotonic deny-only policy. It has no allow result by design. */
/** Bivariant callback mirrors the host's method parameter while retaining the local execution shape. */
export type HarnessMonotonicGuard = {
  bivarianceHack(execution: Readonly<HarnessToolExecution>): string | undefined
}['bivarianceHack']

export interface HarnessToolService {
  register(definition: HarnessToolRegistrationDefinition): () => void
  guard(guard: HarnessMonotonicGuard): () => void
  /** Official Agent-scoped presentation override; diagnostics do not require it. */
  presentAs?(mode: 'native' | 'code' | 'both'): () => void
}

/** The only official host service consumed by the production adapter. */
export interface HarnessStructuralContext {
  readonly tools: HarnessToolService
}

export const HARNESS_CAPABILITIES = ['register-tool', 'monotonic-guard'] as const
export type HarnessCapability = typeof HARNESS_CAPABILITIES[number]

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const SCHEMA_CONSTRAINTS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const SCHEMA_ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'] as const

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === null || prototype === Object.prototype
  } catch {
    return false
  }
}

function isJsonSchemaRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainJsonRecord(value)) return false
  try {
    return Reflect.ownKeys(value).every((key) => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key))
  } catch {
    return false
  }
}

function isPlainJsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false
    return true
  } catch {
    return false
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  try {
    return Object.hasOwn(value, key)
  } catch {
    return false
  }
}

function readOwn(value: object, key: PropertyKey): unknown | typeof MISSING_VALUE {
  try {
    return Reflect.get(value, key)
  } catch {
    return MISSING_VALUE
  }
}

const MISSING_VALUE = Symbol('missing schema value')

function isLosslessJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

function isLosslessJsonValue(value: unknown): boolean {
  const active = new Set<object>()
  const tasks: Array<{ value: unknown; leave?: object }> = [{ value }]
  try {
    while (tasks.length > 0) {
      const task = tasks.pop()!
      if (task.leave) {
        active.delete(task.leave)
        continue
      }
      const current = task.value
      if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
      if (isLosslessJsonNumber(current)) continue
      if (!isJsonSchemaRecord(current) && !isPlainJsonArray(current)) return false
      if (active.has(current)) return false
      active.add(current)
      tasks.push({ value: undefined, leave: current })
      if (isPlainJsonArray(current)) {
        for (let index = current.length - 1; index >= 0; index -= 1) {
          const child = readOwn(current, index)
          if (child === MISSING_VALUE) return false
          tasks.push({ value: child })
        }
      } else {
        const keys = Object.keys(current)
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index]
          if (key === undefined) return false
          const child = readOwn(current, key)
          if (child === MISSING_VALUE) return false
          tasks.push({ value: child })
        }
      }
    }
    return true
  } catch {
    return false
  }
}

function scalarMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return isLosslessJsonNumber(value)
    case 'integer': return isLosslessJsonNumber(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function validateOutputSchemaNode(node: unknown, active: Set<object>): boolean {
  if (!isJsonSchemaRecord(node)) return false
  if (active.has(node)) return false
  active.add(node)
  try {
    const keys = Object.keys(node)
    if (keys.some((key) => !SCHEMA_CONSTRAINTS.has(key) && !SCHEMA_ANNOTATIONS.has(key))) return false
    for (const key of keys) {
      if (key === 'description' || key === 'title') {
        const value = readOwn(node, key)
        if (value === MISSING_VALUE || typeof value !== 'string') return false
      } else if (key === 'default' || key === 'examples') {
        const value = readOwn(node, key)
        if (value === MISSING_VALUE || !isLosslessJsonValue(value)) return false
      }
    }

    const hasType = hasOwn(node, 'type')
    const hasOneOf = hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) return false
    if (!hasType && !hasOneOf) return !ONE_OF_SIBLINGS.some((key) => hasOwn(node, key))

    if (hasOneOf) {
      if (ONE_OF_SIBLINGS.some((key) => hasOwn(node, key))) return false
      const branches = readOwn(node, 'oneOf')
      return branches !== MISSING_VALUE && isPlainJsonArray(branches) && branches.length >= 2 && branches.every((branch) => validateOutputSchemaNode(branch, active))
    }

    const type = readOwn(node, 'type')
    if (type === MISSING_VALUE || typeof type !== 'string' || !SCHEMA_TYPES.has(type)) return false
    const allowedFor: Record<string, readonly string[]> = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    }
    for (const [key, types] of Object.entries(allowedFor)) if (hasOwn(node, key) && !types.includes(type)) return false

    if (type === 'object') {
      const properties = hasOwn(node, 'properties') ? readOwn(node, 'properties') : undefined
      if (properties !== undefined) {
        if (properties === MISSING_VALUE || !isJsonSchemaRecord(properties)) return false
        for (const key of Object.keys(properties)) {
          const property = readOwn(properties, key)
          if (property === MISSING_VALUE || !validateOutputSchemaNode(property, active)) return false
        }
      }
      if (hasOwn(node, 'required')) {
        const required = readOwn(node, 'required')
        if (required === MISSING_VALUE || !isPlainJsonArray(required) || required.some((key) => typeof key !== 'string')) return false
        const declaredProperties = isJsonSchemaRecord(properties) ? properties : undefined
        for (const key of required as string[]) if (!declaredProperties || !hasOwn(declaredProperties, key)) return false
      }
      if (hasOwn(node, 'additionalProperties')) {
        const additionalProperties = readOwn(node, 'additionalProperties')
        if (additionalProperties === MISSING_VALUE || typeof additionalProperties !== 'boolean') return false
      }
    }
    if (type === 'array' && hasOwn(node, 'items')) {
      const items = readOwn(node, 'items')
      if (items === MISSING_VALUE || !validateOutputSchemaNode(items, active)) return false
    }
    if (['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
      const hasEnum = hasOwn(node, 'enum')
      const values = hasEnum ? readOwn(node, 'enum') : undefined
      const enumValid = !hasEnum || (values !== MISSING_VALUE && isPlainJsonArray(values) && values.length > 0 && values.every((value) => scalarMatches(type, value)))
      if (!enumValid) return false
      if (hasOwn(node, 'const')) {
        const declared = readOwn(node, 'const')
        if (declared === MISSING_VALUE || !scalarMatches(type, declared)) return false
        if (enumValid && hasEnum && !(values as unknown[]).includes(declared)) return false
      }
    }
    return true
  } catch {
    return false
  } finally {
    active.delete(node)
  }
}

/** Conservative fail-closed registration precheck; the real rc.6 runtime remains authoritative. */
export function isSupportedHarnessJsonSchema(value: unknown): value is HarnessJsonSchema {
  return validateOutputSchemaNode(value, new Set())
}

export function isPositiveFiniteHarnessTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export interface StructuralContextReport {
  readonly availableCapabilities: readonly HarnessCapability[]
  readonly missingCapabilities: readonly HarnessCapability[]
  readonly reasons: readonly string[]
}

export class MissingHarnessMethodError extends TypeError {
  constructor(methodName: string) {
    super(`missing public Harness method ${methodName}`)
    this.name = 'MissingHarnessMethodError'
  }
}

const capabilitySpecs: readonly [HarnessCapability, keyof HarnessStructuralContext, keyof HarnessToolService][] = [
  ['register-tool', 'tools', 'register'],
  ['monotonic-guard', 'tools', 'guard'],
]

function readProperty(value: unknown, key: PropertyKey): unknown {
  try {
    return (value as Record<PropertyKey, unknown>)[key]
  } catch {
    return undefined
  }
}

export function inspectStructuralContext(context: unknown): StructuralContextReport {
  const availableCapabilities: HarnessCapability[] = []
  const missingCapabilities: HarnessCapability[] = []
  const reasons: string[] = []

  for (const [capability, serviceName, methodName] of capabilitySpecs) {
    const service = readProperty(context, serviceName)
    if ((typeof service !== 'object' && typeof service !== 'function') || service === null) {
      missingCapabilities.push(capability)
      reasons.push(`missing public service tools for ${capability}`)
      continue
    }
    const method = readProperty(service, methodName)
    if (typeof method !== 'function') {
      missingCapabilities.push(capability)
      reasons.push(`missing public method tools.${String(methodName)} for ${capability}`)
      continue
    }
    availableCapabilities.push(capability)
  }

  return Object.freeze({
    availableCapabilities: Object.freeze(availableCapabilities),
    missingCapabilities: Object.freeze(missingCapabilities),
    reasons: Object.freeze(reasons),
  })
}

export function invokeWithReceiver<T>(service: unknown, methodName: PropertyKey, args: readonly unknown[]): T {
  const method = readProperty(service, methodName)
  if (typeof method !== 'function') throw new MissingHarnessMethodError(String(methodName))
  return (method as (...values: unknown[]) => T).apply(service, [...args])
}
