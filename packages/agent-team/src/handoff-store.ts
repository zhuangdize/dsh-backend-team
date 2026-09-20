import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { AgentHandoffSchema } from '@dsh-backend-team/contracts'
import type { AgentHandoff } from '@dsh-backend-team/contracts'
import { ownershipLockDirectory, withOwnershipMutex } from './path-overlap.js'

export type ParentAcknowledgementStatus = 'accepted' | 'needs-rework' | 'rejected'

export interface DurableHandoff extends AgentHandoff {
  readonly parentTaskId: string
  readonly acknowledgedBy?: string
  readonly acknowledgedAt?: string
}

export interface HandoffStoreOptions {
  readonly handoffDirectory?: string
}

interface HandoffEnvelope {
  readonly schemaVersion: 1
  readonly parentTaskId: string
  readonly handoff: AgentHandoff
  readonly acknowledgedBy?: string
  readonly acknowledgedAt?: string
}

/** Atomic workspace-local handoff persistence. Records remain until explicit parent acknowledgement. */
export class HandoffStore {
  private readonly root: string
  private readonly directory: string
  private readonly mutexDirectory: string

  constructor(workspaceRoot: string, options: HandoffStoreOptions = {}) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) throw new Error('workspace root is required')
    this.root = realpathSync(workspaceRoot)
    const directory = options.handoffDirectory === undefined ? join(this.root, '.backend-team', 'handoff') : options.handoffDirectory
    this.directory = options.handoffDirectory === undefined ? ensureHandoffDirectory(this.root) : ensureCustomDirectory(this.root, directory)
    this.mutexDirectory = ownershipLockDirectory(this.root)
  }

  write(input: AgentHandoff, parentTaskId: string): DurableHandoff {
    const handoff = AgentHandoffSchema.parse(input)
    const parent = assertId(parentTaskId)
    if (handoff.parentVerification.status !== 'pending') throw new Error('a new handoff must await parent acknowledgement')
    return withOwnershipMutex(this.mutexDirectory, () => {
      if (this.exists(handoff.id)) throw new Error('handoff already exists')
      const envelope: HandoffEnvelope = { schemaVersion: 1, parentTaskId: parent, handoff }
      this.writeEnvelope(handoff.id, envelope, false)
      return toDurableHandoff(envelope)
    })
  }

  exists(id: string): boolean {
    const safeId = assertId(id)
    const path = this.fileFor(safeId)
    let metadata
    try { metadata = lstatSync(path) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('handoff file is unsafe')
    return true
  }

  read(id: string): DurableHandoff {
    const safeId = assertId(id)
    const file = this.fileFor(safeId)
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = fstatSync(descriptor)
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('handoff file is unsafe')
      const raw: unknown = JSON.parse(readFileSync(descriptor, 'utf8'))
      const envelope = parseEnvelope(raw)
      if (envelope.handoff.id !== safeId) throw new Error('handoff ID does not match its filename')
      return toDurableHandoff(envelope)
    } finally { closeSync(descriptor) }
  }

  acknowledge(id: string, parentTaskId: string, status: ParentAcknowledgementStatus = 'accepted'): DurableHandoff {
    const safeId = assertId(id)
    const parent = assertId(parentTaskId)
    if (!['accepted', 'needs-rework', 'rejected'].includes(status)) throw new Error('parent acknowledgement status is invalid')
    return withOwnershipMutex(this.mutexDirectory, () => {
      const current = this.read(safeId)
      if (current.parentTaskId !== parent) throw new Error('handoff belongs to another parent')
      if (current.acknowledgedBy !== undefined) {
        if (current.acknowledgedBy !== parent) throw new Error('handoff is already acknowledged by another parent')
        if (current.parentVerification.status !== status) throw new Error('handoff acknowledgement is immutable')
        return current
      }
      const acknowledgedAt = current.acknowledgedAt ?? new Date().toISOString()
      const handoff: AgentHandoff = {
        id: current.id,
        taskId: current.taskId,
        status: current.status,
        summary: current.summary,
        changedPaths: current.changedPaths,
        commands: current.commands,
        evidencePaths: current.evidencePaths,
        risks: current.risks,
        unresolvedItems: current.unresolvedItems,
        consumedBudget: current.consumedBudget,
        childResultIds: current.childResultIds,
        parentVerification: { status, verifiedBy: parent, verifiedAt: acknowledgedAt },
      }
      const envelope: HandoffEnvelope = { schemaVersion: 1, parentTaskId: current.parentTaskId, handoff, acknowledgedBy: parent, acknowledgedAt }
      this.writeEnvelope(safeId, envelope, true)
      return toDurableHandoff(envelope)
    })
  }

  list(): readonly DurableHandoff[] {
    return readdirSync(this.directory).filter((name) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/u.test(name)).sort().map((name) => this.read(name.slice(0, -5)))
  }

  private fileFor(id: string): string { return join(this.directory, `${id}.json`) }

  private writeEnvelope(id: string, envelope: HandoffEnvelope, replace: boolean): void {
    const file = this.fileFor(assertId(id))
    const temporary = join(this.directory, `.${id}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`)
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(descriptor, JSON.stringify(envelope))
      fsyncSync(descriptor)
    } finally { closeSync(descriptor) }
    try {
      let metadata
      try { metadata = lstatSync(file) } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (metadata !== undefined) {
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('handoff file is unsafe')
        if (!replace) throw new Error('handoff already exists')
      }
      renameSync(temporary, file)
      syncDirectory(this.directory)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* preserve original failure */ }
      throw error
    }
  }
}

function parseEnvelope(value: unknown): HandoffEnvelope {
  if (typeof value !== 'object' || value === null) throw new Error('handoff envelope is invalid')
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some((key) => !['schemaVersion', 'parentTaskId', 'handoff', 'acknowledgedBy', 'acknowledgedAt'].includes(key))) throw new Error('handoff envelope is invalid')
  if (candidate.schemaVersion !== 1 || typeof candidate.parentTaskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate.parentTaskId) || typeof candidate.handoff !== 'object' || candidate.handoff === null) throw new Error('handoff envelope is invalid')
  const handoff = AgentHandoffSchema.parse(candidate.handoff)
  const acknowledgedBy = candidate.acknowledgedBy
  const acknowledgedAt = candidate.acknowledgedAt
  if (acknowledgedBy !== undefined && (typeof acknowledgedBy !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(acknowledgedBy))) throw new Error('handoff acknowledgement is invalid')
  if (acknowledgedAt !== undefined && (typeof acknowledgedAt !== 'string' || !isCanonicalTimestamp(acknowledgedAt))) throw new Error('handoff acknowledgement is invalid')
  if ((acknowledgedBy === undefined) !== (acknowledgedAt === undefined)) throw new Error('handoff acknowledgement is incomplete')
  const verification = handoff.parentVerification
  if (acknowledgedBy === undefined) {
    if (verification.status !== 'pending') throw new Error('handoff acknowledgement is incomplete')
  } else if (verification.status === 'pending' || verification.verifiedBy !== acknowledgedBy || verification.verifiedAt !== acknowledgedAt) {
    throw new Error('handoff acknowledgement does not match parent verification')
  }
  return acknowledgedBy === undefined || acknowledgedAt === undefined
    ? { schemaVersion: 1, parentTaskId: candidate.parentTaskId, handoff }
    : { schemaVersion: 1, parentTaskId: candidate.parentTaskId, handoff, acknowledgedBy, acknowledgedAt }
}

function toDurableHandoff(envelope: HandoffEnvelope): DurableHandoff {
  return Object.freeze({ ...envelope.handoff, parentTaskId: envelope.parentTaskId, ...(envelope.acknowledgedBy === undefined ? {} : { acknowledgedBy: envelope.acknowledgedBy, acknowledgedAt: envelope.acknowledgedAt }) })
}

function assertId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw new Error('task ID is invalid')
  return id
}

function ensureHandoffDirectory(root: string): string {
  let current = root
  for (const segment of ['.backend-team', 'handoff']) {
    current = join(current, segment)
    try {
      const metadata = lstatSync(current)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('handoff directory is unsafe')
      chmodSync(current, 0o700)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(current, { mode: 0o700 })
    }
    const finalMetadata = lstatSync(current)
    if (!finalMetadata.isDirectory() || finalMetadata.isSymbolicLink()) throw new Error('handoff directory is unsafe')
    chmodSync(current, 0o700)
    if ((lstatSync(current).mode & 0o777) !== 0o700) throw new Error('handoff directory permissions are unsafe')
  }
  return current
}

function ensureCustomDirectory(root: string, directory: string): string {
  const absolute = resolve(directory)
  const resolved = realpathSync(dirname(absolute))
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error('handoff directory escapes workspace')
  mkdirSync(absolute, { recursive: true, mode: 0o700 })
  const metadata = lstatSync(absolute)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('handoff directory is unsafe')
  chmodSync(absolute, 0o700)
  if ((lstatSync(absolute).mode & 0o777) !== 0o700) throw new Error('handoff directory permissions are unsafe')
  return absolute
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function isCanonicalTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value
}
