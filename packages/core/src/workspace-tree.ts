import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { sha256Canonical } from './content-hash.js'

interface TreeDirectory { readonly path: string; readonly type: 'directory'; readonly mode: number }
interface TreeFile { readonly path: string; readonly type: 'file'; readonly mode: number; readonly size: number; readonly sha256: string }
interface TreeSymlink { readonly path: string; readonly type: 'symlink'; readonly mode: number; readonly target: string; readonly canonicalTarget: string }
type TreeEntry = TreeDirectory | TreeFile | TreeSymlink

/**
 * Produces a stable digest for an executable workspace tree. Every regular file
 * is read twice through a no-follow handle. Symlinks are recorded as links and
 * may resolve only inside the explicitly allowed workspace-local roots.
 */
export async function sha256WorkspaceTree(workspaceRoot: string, relativeRoot: string, allowedSymlinkRoots: readonly string[]): Promise<string> {
  const canonicalWorkspace = await realpath(workspaceRoot)
  assertRelativePath(relativeRoot, 'runtime tree')
  if (allowedSymlinkRoots.length === 0) throw new Error('runtime tree requires allowed symlink roots')
  const canonicalAllowed: string[] = []
  for (const allowed of allowedSymlinkRoots) {
    assertRelativePath(allowed, 'allowed symlink root')
    const canonical = await realpath(resolve(canonicalWorkspace, allowed))
    if (!inside(canonicalWorkspace, canonical)) throw new Error('allowed symlink root escapes workspace')
    canonicalAllowed.push(canonical)
  }
  const target = resolve(canonicalWorkspace, relativeRoot)
  if (!inside(canonicalWorkspace, target)) throw new Error('runtime tree escapes workspace')
  const first = await snapshotTree(canonicalWorkspace, target, canonicalAllowed)
  const second = await snapshotTree(canonicalWorkspace, target, canonicalAllowed)
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('runtime tree changed during snapshot')
  return sha256Canonical(first)
}

async function snapshotTree(workspace: string, root: string, allowedRoots: readonly string[]): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = []
  await visit(workspace, root, root, allowedRoots, entries)
  return Object.freeze(entries)
}

async function visit(workspace: string, root: string, path: string, allowedRoots: readonly string[], entries: TreeEntry[]): Promise<void> {
  const before = await lstat(path)
  const entryPath = relative(root, path) || '.'
  if (before.isSymbolicLink()) {
    const target = await readlink(path)
    const canonicalTarget = await realpath(path)
    if (!allowedRoots.some((allowed) => inside(allowed, canonicalTarget))) throw new Error(`runtime tree symlink escapes approved roots: ${entryPath}`)
    const after = await lstat(path)
    const finalTarget = await readlink(path)
    if (!sameIdentity(before, after) || target !== finalTarget) throw new Error('runtime tree symlink changed during snapshot')
    entries.push(Object.freeze({ path: entryPath, type: 'symlink', mode: before.mode & 0o777, target, canonicalTarget: relative(workspace, canonicalTarget) }))
    return
  }
  if (before.isDirectory()) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isDirectory() || !sameIdentity(before, opened)) throw new Error('runtime tree directory identity changed')
      entries.push(Object.freeze({ path: entryPath, type: 'directory', mode: opened.mode & 0o777 }))
      const names = (await readdir(path)).sort()
      for (const name of names) await visit(workspace, root, resolve(path, name), allowedRoots, entries)
      const finalNames = (await readdir(path)).sort()
      const after = await handle.stat(); const current = await lstat(path)
      if (JSON.stringify(names) !== JSON.stringify(finalNames) || !sameIdentity(opened, after) || !sameIdentity(opened, current) || current.isSymbolicLink()) throw new Error('runtime tree directory changed during snapshot')
    } finally { await handle.close() }
    return
  }
  if (!before.isFile()) throw new Error(`runtime tree contains unsupported entry: ${entryPath}`)
  if (before.nlink !== 1) throw new Error(`runtime tree contains a hard-linked file: ${entryPath}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || !sameIdentity(before, opened) || !sameIdentity(opened, current)) throw new Error('runtime tree file identity changed')
    const first = await sha256Handle(handle); const second = await sha256Handle(handle)
    const after = await handle.stat(); const finalPath = await lstat(path)
    if (first !== second || !sameIdentity(opened, after) || !sameIdentity(opened, finalPath) || after.size !== opened.size || finalPath.isSymbolicLink()) throw new Error('runtime tree file changed during snapshot')
    entries.push(Object.freeze({ path: entryPath, type: 'file', mode: opened.mode & 0o777, size: opened.size, sha256: first }))
  } finally { await handle.close() }
}

async function sha256Handle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0
  for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (bytesRead === 0) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead }
  return hash.digest('hex')
}
function assertRelativePath(value: string, label: string): void { if (value.length === 0 || value.includes('\0') || isAbsolute(value) || value.split(/[\\/]/u).some((part) => part === '' || part === '.' || part === '..')) throw new Error(`${label} must be a normalized workspace-relative path`) }
function inside(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino }
