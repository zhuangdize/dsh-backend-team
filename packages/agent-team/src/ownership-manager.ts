import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertRealpathSafeWorkspacePath, isPathWithin, ownershipLockDirectory, pathsOverlap, withOwnershipMutex } from './path-overlap.js'

export type OwnershipMode = 'read' | 'write'
export interface OwnershipLease { readonly taskId: string; readonly nonce: string; readonly paths: readonly string[]; readonly mode: OwnershipMode; readonly delegatedFromNonce?: string; readonly delegatedFromTaskId?: string }
export interface OwnershipLeaseSnapshot { readonly taskId: string; readonly paths: readonly string[]; readonly mode: OwnershipMode }
export interface OwnedTask { readonly id: string; readonly writePaths: readonly string[] }
export interface OwnershipManagerOptions { readonly workspaceRoot: string; readonly recoveryToken: string }
export interface OwnershipAcquireOptions {
  /**
   * Allows a bounded child lease to overlap its registered parent's lease.
   * The coordinator supplies this only after DelegationGuard has proved the
   * child path is inside the parent's ownership scope.
   */
  readonly delegatedFrom?: OwnershipLease
}
interface StoredOwnershipLease extends OwnershipLease { readonly recoveryDigest: string }

/** Workspace-scoped ownership leases with durable recovery records. */
export class OwnershipManager {
  private readonly leases = new Map<string, StoredOwnershipLease>()
  private readonly lockDirectory: string
  private readonly workspaceRoot: string
  private readonly recoveryDigest: string
  constructor(options: OwnershipManagerOptions) {
    if (typeof options.recoveryToken !== 'string' || options.recoveryToken.length < 16) throw new Error('recovery token is required')
    this.workspaceRoot = realpathSync(options.workspaceRoot)
    this.recoveryDigest = digest(options.recoveryToken)
    this.lockDirectory = ownershipLockDirectory(this.workspaceRoot)
    this.recover()
  }

  acquire(taskId: string, paths: readonly string[], mode: OwnershipMode = 'write', options: OwnershipAcquireOptions = {}): OwnershipLease {
    assertTaskId(taskId)
    if (mode !== 'read' && mode !== 'write') throw new Error('ownership mode is invalid')
    const delegatedFrom = options.delegatedFrom
    if (delegatedFrom !== undefined && delegatedFrom.taskId === taskId) throw new Error('delegated ownership parent must differ from child')
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('lease paths are required')
    return withOwnershipMutex(this.lockDirectory, () => {
      this.recover()
      const safePaths = [...new Set(paths.map((path) => assertRealpathSafeWorkspacePath(this.workspaceRoot, path)))]
      if (delegatedFrom !== undefined) {
        const parentLease = this.leases.get(delegatedFrom.nonce)
        if (parentLease === undefined || !sameLease(parentLease, delegatedFrom) || safePaths.some((path) => !parentLease.paths.some((held) => isPathWithin(path, held)))) throw new Error('delegated ownership must stay within the parent lease')
      }
      for (const lease of this.leases.values()) {
        if (lease.taskId === taskId) continue
        if (delegatedFrom !== undefined && lease.taskId === delegatedFrom.taskId) continue
        if (mode === 'read' && lease.mode === 'read') continue
        if (safePaths.some((path) => lease.paths.some((held) => pathsOverlap(path, held)))) throw new Error(`path is owned by task ${lease.taskId}`)
      }
      const lease: OwnershipLease = Object.freeze({ taskId, nonce: randomBytes(24).toString('hex'), paths: Object.freeze(safePaths), mode, ...(delegatedFrom === undefined ? {} : { delegatedFromNonce: delegatedFrom.nonce, delegatedFromTaskId: delegatedFrom.taskId }) })
      this.persist(lease)
      this.leases.set(lease.nonce, { ...lease, recoveryDigest: this.recoveryDigest })
      return lease
    })
  }

  release(lease: OwnershipLease): void {
    if (typeof lease !== 'object' || lease === null) return
    withOwnershipMutex(this.lockDirectory, () => {
      this.recover()
      const actual = this.leases.get(lease.nonce)
      if (actual === undefined) return
      if (actual.taskId !== lease.taskId || actual.mode !== lease.mode || actual.paths.length !== lease.paths.length || actual.paths.some((path, index) => path !== lease.paths[index])) return
      this.remove(actual.nonce)
      this.leases.delete(actual.nonce)
    })
  }

  /** Releases recovered leases only with the trusted coordinator recovery token. */
  releaseRecovered(taskId: string, paths: readonly string[], token: string): number {
    assertTaskId(taskId)
    if (digest(token) !== this.recoveryDigest) throw new Error('recovery token is invalid')
    return withOwnershipMutex(this.lockDirectory, () => {
      this.recover()
      const safePaths = [...new Set(paths.map((path) => assertRealpathSafeWorkspacePath(this.workspaceRoot, path)))]
      const matching = [...this.leases.values()].filter((lease) => lease.taskId === taskId && lease.recoveryDigest === this.recoveryDigest && lease.paths.length === safePaths.length && lease.paths.every((path, index) => path === safePaths[index]))
      for (const lease of matching) { this.remove(lease.nonce); this.leases.delete(lease.nonce) }
      return matching.length
    })
  }

  verifyWrite(task: OwnedTask, path: string): true {
    return withOwnershipMutex(this.lockDirectory, () => {
      this.recover()
      const safePath = assertRealpathSafeWorkspacePath(this.workspaceRoot, path)
      if (!task.writePaths.some((declared) => isPathWithin(safePath, declared))) throw new Error('write is outside task ownership')
      const held = [...this.leases.values()].some((lease) => lease.taskId === task.id && lease.mode === 'write' && lease.paths.some((owned) => isPathWithin(safePath, owned)))
      if (!held) throw new Error('write lease is missing')
      return true
    })
  }

  snapshot(): readonly OwnershipLeaseSnapshot[] {
    return withOwnershipMutex(this.lockDirectory, () => {
      this.recover()
      return Object.freeze([...this.leases.values()].map((lease) => Object.freeze({ taskId: lease.taskId, paths: Object.freeze([...lease.paths]), mode: lease.mode })))
    })
  }

  private fileFor(nonce: string): string { return join(this.lockDirectory, `ownership-${nonce}.json`) }
  private persist(lease: OwnershipLease): void {
    this.assertLockDirectory()
    const file = this.fileFor(lease.nonce)
    const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(descriptor, JSON.stringify({ ...lease, recoveryDigest: this.recoveryDigest })); fsyncSync(descriptor) } finally { closeSync(descriptor) }
    syncDirectory(this.lockDirectory)
  }
  private assertLockDirectory(): void {
    if (ownershipLockDirectory(this.workspaceRoot) !== this.lockDirectory) throw new Error('ownership lock directory changed')
  }
  private recover(): void {
    this.leases.clear()
    for (const name of readdirSync(this.lockDirectory).filter((entry) => /^ownership-[a-f0-9]{48}\.json$/u.test(entry)).sort()) {
      const file = join(this.lockDirectory, name)
      const metadata = lstatSync(file)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('ownership lease file is unsafe')
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof value !== 'object' || value === null) throw new Error('ownership lease file is invalid')
      const record = value as Partial<OwnershipLease>
      if (typeof record.taskId !== 'string' || record.taskId.trim().length === 0 || typeof record.nonce !== 'string' || !/^[a-f0-9]{48}$/u.test(record.nonce) || name !== `ownership-${record.nonce}.json` || (record.mode !== 'read' && record.mode !== 'write') || !Array.isArray(record.paths) || record.paths.length === 0 || record.paths.some((path) => typeof path !== 'string') || (record.delegatedFromNonce !== undefined && (typeof record.delegatedFromNonce !== 'string' || !/^[a-f0-9]{48}$/u.test(record.delegatedFromNonce) || record.delegatedFromNonce === record.nonce || typeof record.delegatedFromTaskId !== 'string' || record.delegatedFromTaskId === record.taskId)) || (record.delegatedFromNonce === undefined && record.delegatedFromTaskId !== undefined)) throw new Error('ownership lease file is invalid')
      const mode = record.mode
      const paths = record.paths.map((path) => assertRealpathSafeWorkspacePath(this.workspaceRoot, path))
      const recoveryDigest = (record as Partial<StoredOwnershipLease>).recoveryDigest
      if (typeof recoveryDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(recoveryDigest) || new Set(paths).size !== paths.length || this.leases.has(record.nonce) || paths.some((path) => [...this.leases.values()].some((held) => held.taskId !== record.taskId && conflicts(mode, path, held) && !delegatedOverlap(record, path, held)))) throw new Error('ownership lease file is invalid')
      this.leases.set(record.nonce, Object.freeze({ taskId: record.taskId, nonce: record.nonce, paths: Object.freeze(paths), mode, ...(record.delegatedFromNonce === undefined ? {} : { delegatedFromNonce: record.delegatedFromNonce, delegatedFromTaskId: record.delegatedFromTaskId }), recoveryDigest }))
    }
    for (const lease of this.leases.values()) {
      if (lease.delegatedFromNonce !== undefined) {
        const parent = this.leases.get(lease.delegatedFromNonce)
        if (parent === undefined || parent.taskId !== lease.delegatedFromTaskId || parent.taskId === lease.taskId || lease.paths.some((path) => !parent.paths.some((held) => isPathWithin(path, held)))) throw new Error('ownership lease file is invalid')
      }
    }
  }

  private remove(nonce: string): void {
    this.assertLockDirectory()
    const file = this.fileFor(nonce)
    if (!existsSync(file)) throw new Error('ownership lease file is missing or unsafe')
    const metadata = lstatSync(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('ownership lease file is missing or unsafe')
    unlinkSync(file)
    syncDirectory(this.lockDirectory)
  }
}

function assertTaskId(taskId: unknown): asserts taskId is string {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(taskId)) throw new Error('task ID is invalid')
}

function conflicts(mode: OwnershipMode, path: string, held: OwnershipLease): boolean {
  return !(mode === 'read' && held.mode === 'read') && held.paths.some((heldPath) => pathsOverlap(path, heldPath))
}

function delegatedOverlap(candidate: Partial<OwnershipLease>, candidatePath: string, held: StoredOwnershipLease): boolean {
  if (candidate.delegatedFromNonce === held.nonce || candidate.delegatedFromTaskId === held.taskId) return held.paths.some((path) => isPathWithin(candidatePath, path))
  if (held.delegatedFromNonce === candidate.nonce || held.delegatedFromTaskId === candidate.taskId) return held.paths.some((path) => isPathWithin(path, candidatePath))
  return false
}

function sameLease(left: OwnershipLease, right: OwnershipLease): boolean {
  return left.taskId === right.taskId && left.nonce === right.nonce && left.mode === right.mode && left.paths.length === right.paths.length && left.paths.every((path, index) => path === right.paths[index])
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}
