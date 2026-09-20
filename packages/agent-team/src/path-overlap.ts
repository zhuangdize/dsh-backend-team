import { chmodSync, closeSync, constants, fstatSync, ftruncateSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'

const secretDirectory = new Set(['.aws', '.gnupg', '.ssh', 'credential', 'credentials', 'private', 'secrets'])
const secretName = /(?:^|[._-])(?:credential(?:s)?|token|password|secret|private[-_]?key|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$)/iu

function sensitive(segment: string): boolean {
  return /^\.env(?:$|rc$|[._].*)/iu.test(segment) || /^\.npmrc$/iu.test(segment) || /\.(?:key|pem|p12|pfx)$/iu.test(segment) || secretName.test(segment) || secretDirectory.has(segment.toLowerCase())
}

/** Validates a lexical workspace-relative path before it is used for a lease. */
export function assertSafeWorkspacePath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path !== path.trim() || /[\u0000-\u001F\u007F]/u.test(path) || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/u.test(path) || /[*?\[\]{}]/u.test(path)) throw new Error('path is not a safe workspace-relative path')
  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || sensitive(segment))) throw new Error('path is unsafe or sensitive')
  return path
}

/** Segment-aware path overlap: `foo` and `foobar` are distinct. */
export function pathsOverlap(left: string, right: string): boolean {
  const safeLeft = assertSafeWorkspacePath(left)
  const safeRight = assertSafeWorkspacePath(right)
  return safeLeft === safeRight || safeLeft.startsWith(`${safeRight}/`) || safeRight.startsWith(`${safeLeft}/`)
}

export function isPathWithin(path: string, scope: string): boolean {
  const safePath = assertSafeWorkspacePath(path)
  const safeScope = assertSafeWorkspacePath(scope)
  return safePath === safeScope || safePath.startsWith(`${safeScope}/`)
}

/** Resolves only existing ancestors and rejects any symlink before a lease records a relative path. */
export function assertRealpathSafeWorkspacePath(workspaceRoot: string, path: unknown): string {
  const safePath = assertSafeWorkspacePath(path)
  const rootInput = resolve(workspaceRoot)
  const root = realpathSync(rootInput)
  if (root !== rootInput) throw new Error('workspace root is no longer canonical')
  const rootMetadata = lstatSync(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('workspace root is not a real directory')
  const segments = safePath.split('/')
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error('path escapes workspace')
  let existing = target
  const missing: string[] = []
  let metadata
  while (true) {
    try {
      metadata = lstatSync(existing)
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw new Error('workspace path has no existing ancestor')
      missing.unshift(existing.slice(parent.length + 1))
      existing = parent
    }
  }
  if (metadata.isSymbolicLink()) throw new Error('workspace path has a symlink ancestor')
  if (missing.length > 0 && !metadata.isDirectory()) throw new Error('workspace path has a non-directory ancestor')
  let prefix = root
  for (const [index, segment] of segments.entries()) {
    if (index >= segments.length - missing.length) break
    prefix = resolve(prefix, segment)
    const prefixMetadata = lstatSync(prefix)
    if (prefixMetadata.isSymbolicLink()) throw new Error('workspace path has a symlink ancestor')
    if (index < segments.length - missing.length - 1 && !prefixMetadata.isDirectory()) throw new Error('workspace path has a non-directory ancestor')
  }
  const canonicalExisting = realpathSync(existing)
  if (canonicalExisting !== root && !canonicalExisting.startsWith(`${root}/`)) throw new Error('path escapes workspace')
  const canonicalTarget = join(canonicalExisting, ...missing)
  const canonicalRelative = relative(root, canonicalTarget)
  return assertSafeWorkspacePath(canonicalRelative)
}

/** Creates the dedicated lease directory only beneath a real, non-symlinked workspace root. */
export function ownershipLockDirectory(workspaceRoot: string): string {
  const root = realpathSync(workspaceRoot)
  const rootMetadata = lstatSync(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('workspace root is not a real directory')
  let current = root
  for (const segment of ['.backend-team', 'locks', 'ownership']) {
    current = join(current, segment)
    try { lstatSync(current) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(current, { mode: 0o700 })
    }
    const metadata = lstatSync(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('ownership lock directory is unsafe')
    chmodSync(current, 0o700)
    if ((lstatSync(current).mode & 0o777) !== 0o700) throw new Error('ownership lock directory permissions are unsafe')
  }
  return current
}

/** Serializes lease-file reads/writes across managers and recovers a dead mutex owner. */
export function withOwnershipMutex<T>(lockDirectory: string, operation: () => T): T {
  const mutexPath = join(lockDirectory, '.mutex')
  // Node does not expose Darwin's O_EXLOCK constant, but the kernel flag is
  // stable (0x20). It gives us a descriptor-backed advisory lock that is
  // released automatically when a process exits.
  const exlock = (constants as unknown as { O_EXLOCK?: number }).O_EXLOCK ?? (process.platform === 'darwin' ? 0x20 : undefined)
  if (exlock === undefined) {
    // Linux/other fallback: fail closed when a previous process left the
    // marker behind; platform-specific advisory locking is unavailable.
    let descriptor: number
    try { descriptor = openSync(mutexPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) } catch { throw new Error('ownership lock is busy') }
    let identity: { readonly dev: number; readonly ino: number } | undefined
    try {
      const metadata = fstatSync(descriptor)
      identity = { dev: metadata.dev, ino: metadata.ino }
      return operation()
    } finally {
      closeSync(descriptor)
      try {
        const current = lstatSync(mutexPath)
        if (identity !== undefined && current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(mutexPath)
      } catch { /* leave an uncertain marker in place; fail closed on the next attempt */ }
    }
  }
  let descriptor: number
  try { descriptor = openSync(mutexPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | exlock, 0o600) } catch { throw new Error('ownership lock is busy') }
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('ownership mutex is unsafe')
    ftruncateSync(descriptor, 0)
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString('hex') }))
    fsyncSync(descriptor)
    return operation()
  } finally {
    closeSync(descriptor)
  }
}
