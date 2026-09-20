import { createHash } from 'node:crypto'
import { AgentTaskSchema } from '@dsh-backend-team/contracts'
import type { AgentCapabilitySet, AgentTask, JsonValue } from '@dsh-backend-team/contracts'
import { assertSafeWorkspacePath } from './path-overlap.js'

export interface ApprovedArtifactExcerpt {
  readonly path: string
  readonly sha256: string
  readonly excerpt: string
}

export interface ContextBuildInput {
  readonly roleInstructions?: string
  readonly approvedArtifacts?: readonly ApprovedArtifactExcerpt[]
  readonly projectFacts?: Readonly<Record<string, unknown>>
  readonly policySummary?: Readonly<Record<string, unknown>>
}

export interface ContextBuilderOptions {
  readonly maxArtifactBytes?: number
  readonly maxPacketBytes?: number
}

export interface ContextPacket {
  readonly schemaVersion: 1
  readonly taskId: string
  readonly objective: string
  readonly nonGoals: readonly string[]
  readonly role: AgentTask['role']
  readonly roleInstructions?: string
  readonly inputArtifacts: readonly { readonly path: string; readonly sha256: string }[]
  readonly approvedArtifacts: readonly { readonly path: string; readonly sha256: string; readonly excerpt: string }[]
  readonly projectFacts: Readonly<Record<string, JsonValue>>
  readonly policySummary: Readonly<Record<string, JsonValue>>
  readonly ownedPaths: { readonly read: readonly string[]; readonly write: readonly string[] }
  readonly capabilities: AgentCapabilitySet
  readonly budget: AgentTask['budget']
  readonly doneWhen: readonly string[]
  readonly returnSchema: string
}

const secretKey = /(?:password|secret|token|credential|private[._-]?key|api[._-]?key|authorization|connection[._-]?string|database[._-]?url)/iu
const secretAssignment = /\b(?:database[._-]?password|password|secret|token|credential|private[._-]?key|api[._-]?key|authorization|connection[._-]?string|database[._-]?url)\b\s*[:=]\s*[^\s,;]+/giu
const secretWord = /\b(?:database[._-]?password|password|secret|token|credential|private[._-]?key|api[._-]?key|authorization|connection[._-]?string|database[._-]?url)\b/giu
const rawConversationMarker = /\braw\s+user\s+conversation\b/giu

/** Builds a small, serialized context packet; raw conversation is intentionally not an accepted input. */
export class ContextBuilder {
  private readonly maxArtifactBytes: number
  private readonly maxPacketBytes: number

  constructor(options: ContextBuilderOptions = {}) {
    this.maxArtifactBytes = positiveLimit(options.maxArtifactBytes, 64 * 1024)
    this.maxPacketBytes = positiveLimit(options.maxPacketBytes, 256 * 1024)
  }

  build(inputTask: AgentTask, input: ContextBuildInput = {}): string {
    const task = AgentTaskSchema.parse(inputTask)
    for (const path of [...task.readPaths, ...task.writePaths, ...task.inputArtifacts.map((artifact) => artifact.path)]) assertSafeWorkspacePath(path)
    const requestedArtifacts = new Map(task.inputArtifacts.map((artifact) => [artifact.path, artifact.sha256]))
    const artifactPaths = new Set<string>()
    const artifacts = (input.approvedArtifacts ?? []).map((artifact) => {
      if (typeof artifact !== 'object' || artifact === null || typeof artifact.excerpt !== 'string') throw new Error('artifact excerpt is invalid')
      const path = assertSafeWorkspacePath(artifact.path)
      if (artifactPaths.has(path)) throw new Error(`duplicate approved artifact: ${path}`)
      artifactPaths.add(path)
      if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error('artifact hash is invalid')
      if (requestedArtifacts.get(path) !== artifact.sha256) throw new Error(`artifact hash does not match task input: ${path}`)
      assertTextExcerpt(artifact.excerpt, this.maxArtifactBytes)
      return { path, sha256: artifact.sha256, excerpt: redactString(artifact.excerpt) }
    })
    const packet: ContextPacket = {
      schemaVersion: 1,
      taskId: task.id,
      objective: redactString(task.objective),
      nonGoals: task.nonGoals.map(redactString),
      role: task.role,
      ...(input.roleInstructions === undefined ? {} : { roleInstructions: redactString(input.roleInstructions) }),
      inputArtifacts: task.inputArtifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
      approvedArtifacts: artifacts,
      projectFacts: sanitizeRecord(input.projectFacts ?? {}),
      policySummary: sanitizeRecord(input.policySummary ?? {}),
      ownedPaths: { read: [...task.readPaths], write: [...task.writePaths] },
      capabilities: task.capabilities,
      budget: task.budget,
      doneWhen: task.doneWhen.map(redactString),
      returnSchema: redactString(task.returnSchema),
    }
    const serialized = JSON.stringify(packet)
    if (Buffer.byteLength(serialized, 'utf8') > this.maxPacketBytes) throw new Error('context packet is oversized')
    return serialized
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 ? value : (() => { throw new Error('context size limit is invalid') })()
}

function assertTextExcerpt(value: string, maxBytes: number): void {
  const bytes = Buffer.from(value, 'utf8')
  let controls = 0
  for (const byte of bytes) {
    if (byte === 0) throw new Error('binary artifact excerpts are not allowed')
    if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) controls += 1
  }
  if (controls > 0 && controls / Math.max(bytes.length, 1) > 0.01) throw new Error('binary artifact excerpts are not allowed')
  if (bytes.length > maxBytes) throw new Error('artifact excerpt is oversized')
}

function redaction(value: string): string {
  return `<redacted:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}>`
}

function redactString(value: string): string {
  return value.replace(secretAssignment, (match) => redaction(match)).replace(secretWord, (match) => redaction(match)).replace(rawConversationMarker, (match) => redaction(match))
}

function sanitizeRecord(input: Readonly<Record<string, unknown>>, seen = new WeakSet<object>(), depth = 0): Readonly<Record<string, JsonValue>> {
  if (depth > 32) throw new Error('context metadata is too deeply nested')
  if (seen.has(input)) throw new Error('context metadata contains a cycle')
  seen.add(input)
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const [key, value] of Object.entries(input)) {
    result[key] = secretKey.test(key) ? redaction(key) : sanitizeValue(value, seen, depth + 1)
  }
  seen.delete(input)
  return result
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): JsonValue {
  if (depth > 32) throw new Error('context metadata is too deeply nested')
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('context metadata contains a non-finite number')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('context metadata contains a cycle')
    seen.add(value)
    const sanitized = value.map((item) => sanitizeValue(item, seen, depth + 1))
    seen.delete(value)
    return sanitized
  }
  if (typeof value === 'object') return sanitizeRecord(value as Readonly<Record<string, unknown>>, seen, depth)
  return redaction(String(value))
}
