import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { assertRealpathSafeWorkspacePath, ownershipLockDirectory, pathsOverlap, withOwnershipMutex } from './path-overlap.js'

export interface SharedResourceLease { readonly taskId: string; readonly path: string; readonly nonce: string }
export interface SharedResourceSnapshot { readonly taskId: string; readonly path: string }
export interface SharedResourceOptions { readonly workspaceRoot: string; readonly recoveryToken: string }
interface StoredSharedResourceLease extends SharedResourceLease { readonly recoveryDigest: string }

const mandatory = (path: string): boolean =>
  /(?:^|\/)package\.json$/u.test(path)
  || /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/u.test(path)
  || /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/u.test(path)
  || /(?:^|\/)(?:openapi|swagger)(?:\.[^/]+)?$/iu.test(path)
  || /(?:^|\/)(?:common|types)(?:\/|$)/iu.test(path)
  || path === '.specify/feature.json'
  || /(?:^|\/)drizzle(?:\/|$)/iu.test(path)
  || /(?:^|\/)(?:migrations?|migration-journal|generated)(?:\/|$)/iu.test(path)

/** Serializes the fixed shared-resource set; callers cannot widen or replace it with prompt data. */
export class SharedResource {
  private readonly leases = new Map<string, StoredSharedResourceLease>()
  private readonly lockDirectory: string
  private readonly workspaceRoot: string
  private readonly recoveryDigest: string
  constructor(options: SharedResourceOptions) {
    if (typeof options.recoveryToken !== 'string' || options.recoveryToken.length < 16) throw new Error('recovery token is required')
    this.workspaceRoot = realpathSync(options.workspaceRoot)
    this.recoveryDigest = digest(options.recoveryToken)
    this.lockDirectory = ownershipLockDirectory(this.workspaceRoot)
    this.recover()
  }

  acquire(taskId: string, path: string): SharedResourceLease {
    assertTaskId(taskId)
    return withOwnershipMutex(this.lockDirectory, () => {
      this.recover()
      const safePath = assertRealpathSafeWorkspacePath(this.workspaceRoot, path)
      if (!mandatory(safePath)) throw new Error('path is not a mandatory shared resource')
      const held = [...this.leases.values()].find((lease) => pathsOverlap(lease.path, safePath))
      if (held !== undefined && held.taskId !== taskId) throw new Error(`shared resource is held by task ${held.taskId}`)
      if (held?.path === safePath) return Object.freeze({ taskId: held.taskId, path: held.path, nonce: held.nonce })
      const lease: SharedResourceLease = Object.freeze({ taskId, path: safePath, nonce: randomBytes(24).toString('hex') })
      this.persist(lease)
      this.leases.set(safePath, { ...lease, recoveryDigest: this.recoveryDigest })
      return lease
    })
  }

  release(lease: SharedResourceLease): void {
    if (typeof lease !== 'object' || lease === null) return
    withOwnershipMutex(this.lockDirectory, () => {
      this.recover()
      const held = this.leases.get(lease.path)
      if (held?.taskId === lease.taskId && held.nonce === lease.nonce) { this.remove(lease.nonce); this.leases.delete(lease.path) }
    })
  }

  /** Releases a recovered resource lease only with the trusted coordinator recovery token. */
  releaseRecovered(taskId: string, path: string, token: string): boolean {
    assertTaskId(taskId)
    if (digest(token) !== this.recoveryDigest) throw new Error('recovery token is invalid')
    return withOwnershipMutex(this.lockDirectory, () => {
      this.recover()
      const safePath = assertRealpathSafeWorkspacePath(this.workspaceRoot, path)
      const held = this.leases.get(safePath)
      if (held?.taskId !== taskId || held.recoveryDigest !== this.recoveryDigest) return false
      this.remove(held.nonce)
      this.leases.delete(safePath)
      return true
    })
  }

  snapshot(): readonly SharedResourceSnapshot[] {
    return withOwnershipMutex(this.lockDirectory, () => {
      this.recover()
      return Object.freeze([...this.leases.values()].map((lease) => Object.freeze({ taskId: lease.taskId, path: lease.path })))
    })
  }

  private fileFor(nonce: string): string { return join(this.lockDirectory, `shared-${nonce}.json`) }
  private persist(lease: SharedResourceLease): void {
    this.assertLockDirectory()
    const descriptor = openSync(this.fileFor(lease.nonce), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(descriptor, JSON.stringify({ ...lease, recoveryDigest: this.recoveryDigest })); fsyncSync(descriptor) } finally { closeSync(descriptor) }
    syncDirectory(this.lockDirectory)
  }
  private assertLockDirectory(): void {
    if (ownershipLockDirectory(this.workspaceRoot) !== this.lockDirectory) throw new Error('ownership lock directory changed')
  }
  private recover(): void {
    this.leases.clear()
    for (const name of readdirSync(this.lockDirectory).filter((entry) => /^shared-[a-f0-9]{48}\.json$/u.test(entry)).sort()) {
      const file = join(this.lockDirectory, name)
      const metadata = lstatSync(file)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('shared resource lease file is unsafe')
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof value !== 'object' || value === null) throw new Error('shared resource lease file is invalid')
      const lease = value as Partial<SharedResourceLease>
      if (typeof lease.taskId !== 'string' || lease.taskId.trim().length === 0 || typeof lease.path !== 'string' || typeof lease.nonce !== 'string' || !/^[a-f0-9]{48}$/u.test(lease.nonce) || name !== `shared-${lease.nonce}.json`) throw new Error('shared resource lease file is invalid')
      const path = assertRealpathSafeWorkspacePath(this.workspaceRoot, lease.path)
      if (!mandatory(path) || [...this.leases.values()].some((held) => held.taskId !== lease.taskId && pathsOverlap(held.path, path))) throw new Error('shared resource lease file is invalid')
      const recoveryDigest = (lease as Partial<StoredSharedResourceLease>).recoveryDigest
      if (typeof recoveryDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(recoveryDigest) || this.leases.has(path)) throw new Error('shared resource lease file is invalid')
      this.leases.set(path, Object.freeze({ taskId: lease.taskId, path, nonce: lease.nonce, recoveryDigest }))
    }
  }

  private remove(nonce: string): void {
    this.assertLockDirectory()
    const file = this.fileFor(nonce)
    if (!existsSync(file)) throw new Error('shared resource lease file is missing or unsafe')
    const metadata = lstatSync(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('shared resource lease file is missing or unsafe')
    unlinkSync(file)
    syncDirectory(this.lockDirectory)
  }

}

function assertTaskId(taskId: unknown): asserts taskId is string {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(taskId)) throw new Error('task ID is invalid')
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}
