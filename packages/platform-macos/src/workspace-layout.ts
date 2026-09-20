import { chmod, lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'
import type { WorkspaceLayout } from '@dsh-backend-team/contracts'

const MANAGED_NAMES = ['stateDir', 'runtimeDir', 'cacheDir', 'logsDir', 'locksDir', 'handoffDir'] as const
interface WorkspaceLayoutTestHooks { readonly syncDirectory?: (path: string) => Promise<void> }
let testHooks: WorkspaceLayoutTestHooks = {}
export function __setWorkspaceLayoutTestHooksForTest(hooks: WorkspaceLayoutTestHooks): () => void { const previous = testHooks; testHooks = hooks; return () => { testHooks = previous } }

export function createWorkspaceLayout(root: string): WorkspaceLayout {
  if (!isAbsolute(root)) throw new Error('workspace root must be absolute')
  const normalizedInput = normalize(resolve(root))
  if (normalizedInput.endsWith('/.backend-team')) throw new Error('workspace root cannot be inside .backend-team')
  const normalizedRoot = realpathSync(normalizedInput)
  const teamDir = resolve(normalizedRoot, '.backend-team')
  if (normalizedRoot === teamDir || normalizedRoot.startsWith(`${teamDir}/`)) throw new Error('workspace root cannot be inside .backend-team')
  return {
    root: normalizedRoot,
    teamDir,
    stateDir: resolve(teamDir, 'state'),
    runtimeDir: resolve(teamDir, 'runtime'),
    cacheDir: resolve(teamDir, 'cache'),
    logsDir: resolve(teamDir, 'logs'),
    locksDir: resolve(teamDir, 'locks'),
    handoffDir: resolve(teamDir, 'handoff'),
  }
}

export async function initializeWorkspaceLayout(layout: WorkspaceLayout): Promise<WorkspaceLayout> {
  if (await realpath(layout.root) !== layout.root) throw new Error('workspace root must be canonical')
  await ensureDirectory(layout.teamDir, layout.root)
  for (const name of MANAGED_NAMES) await ensureDirectory(layout[name], layout.root)
  return layout
}

async function ensureDirectory(target: string, root: string): Promise<void> {
  const relative = target.slice(root.length).replace(/^\/+|\/+$/gu, '')
  let current = root
  for (const segment of relative.split('/').filter(Boolean)) {
    current = `${current}/${segment}`
    try {
      const details = await lstat(current)
      if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`managed directory has unsafe ancestor: ${current}`)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o700 })
    }
    await chmod(current, 0o700)
    const details = await stat(current)
    if (!details.isDirectory() || (details.mode & 0o777) !== 0o700) throw new Error(`managed directory has unsafe permissions: ${current}`)
  }
}

export function assertManagedPath(layout: WorkspaceLayout, target: string): string {
  if (target.includes('\0')) throw new Error('managed path contains NUL')
  const resolved = resolve(target)
  const relative = resolved === layout.teamDir ? '' : resolved.startsWith(`${layout.teamDir}/`) ? resolved.slice(layout.teamDir.length + 1) : null
  if (relative === null) throw new Error('managed path escapes workspace')
  let existing = resolved
  const missing: string[] = []
  while (true) {
    try {
      const details = lstatSync(existing)
      if (details.isSymbolicLink()) throw new Error('managed path contains symlink ancestor')
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = resolve(existing, '..')
      if (parent === existing) throw new Error('managed path has no existing ancestor')
      missing.unshift(existing.slice(parent.length + 1))
      existing = parent
    }
  }
  const canonicalExisting = realpathSync(existing)
  if (!(canonicalExisting === layout.root || canonicalExisting.startsWith(`${layout.root}/`))) throw new Error('managed path escapes workspace')
  return missing.length === 0 ? canonicalExisting : `${canonicalExisting}/${missing.join('/')}`
}

export async function writeManagedMetadata(layout: WorkspaceLayout, relativePath: string, content: string | Uint8Array): Promise<string> {
  const target = assertManagedPath(layout, `${layout.teamDir}/${relativePath}`)
  const parent = target.slice(0, target.lastIndexOf('/'))
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let complete = false
  let ownerIdentity: { readonly dev: number; readonly ino: number } | undefined
  let primary: unknown
  const cleanupErrors: unknown[] = []
  try {
    const bytes = typeof content === 'string' ? Buffer.from(content) : content
    const opened = await handle.stat()
    ownerIdentity = { dev: opened.dev, ino: opened.ino }
    await handle.chmod(0o600)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset)
      if (result.bytesWritten === 0) throw new Error('metadata short write')
      offset += result.bytesWritten
    }
    await handle.sync()
    const retained = await handle.stat()
    const current = await lstat(target)
    if (!retained.isFile() || retained.nlink !== 1 || (retained.mode & 0o777) !== 0o600 || !current.isFile() || current.nlink !== 1 || retained.dev !== current.dev || retained.ino !== current.ino) throw new Error('metadata identity or permissions changed')
    complete = true
  } catch (error: unknown) { primary = error }
  try { await handle.close() } catch (error: unknown) { cleanupErrors.push(error) }
  if (!complete) { try { await removeOwnedMetadata(target, ownerIdentity) } catch (error: unknown) { cleanupErrors.push(error) } }
  if (primary !== undefined || cleanupErrors.length > 0) {
    if (cleanupErrors.length > 0) throw new AggregateError(primary === undefined ? cleanupErrors : [primary, ...cleanupErrors], 'metadata write failed')
    throw primary
  }
  await syncManagedDirectory(parent)
  return target
}

/** Package-internal durable update for an already-owned metadata inode. */
export async function updateManagedMetadata(layout: WorkspaceLayout, relativePath: string, content: string | Uint8Array): Promise<string> {
  const target = assertManagedPath(layout, `${layout.teamDir}/${relativePath}`)
  const handle = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let primary: unknown
  try {
    const opened = await handle.stat(); const current = await lstat(target)
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600 || !current.isFile() || current.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('metadata identity or permissions changed')
    await handle.chmod(0o600)
    await handle.truncate(0)
    const bytes = typeof content === 'string' ? Buffer.from(content) : content
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset)
      if (result.bytesWritten === 0) throw new Error('metadata short write')
      offset += result.bytesWritten
    }
    await handle.sync()
    const final = await handle.stat(); const currentFinal = await lstat(target); if (!final.isFile() || final.nlink !== 1 || (final.mode & 0o777) !== 0o600 || !currentFinal.isFile() || currentFinal.nlink !== 1 || final.dev !== currentFinal.dev || final.ino !== currentFinal.ino || final.dev !== opened.dev || final.ino !== opened.ino) throw new Error('metadata final identity invalid')
  } catch (error: unknown) { primary = error }
  try { await handle.close() } catch (error: unknown) { if (primary === undefined) primary = error; else primary = new AggregateError([primary, error], 'metadata update and close failed') }
  if (primary !== undefined) throw primary
  await syncManagedDirectory(target.slice(0, target.lastIndexOf('/')))
  return target
}

export async function syncManagedDirectory(path: string): Promise<void> {
  if (testHooks.syncDirectory !== undefined) { await testHooks.syncDirectory(path); return }
  const directory = await open(path, constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
}

async function removeOwnedMetadata(path: string, owner: { readonly dev: number; readonly ino: number } | undefined): Promise<void> {
  const current = await lstat(path)
  if (!current.isFile() || current.nlink !== 1 || (owner !== undefined && (current.dev !== owner.dev || current.ino !== owner.ino))) throw new Error('refusing to remove replaced managed metadata')
  const { rm } = await import('node:fs/promises')
  await rm(path)
}
