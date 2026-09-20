import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { isAbsolute, relative, resolve, win32 } from 'node:path'

export interface FileIdentity {
  readonly dev: number
  readonly ino: number
  readonly nlink: number
}

export interface FileSnapshot {
  readonly path: string
  readonly state: 'present' | 'missing'
  readonly realPath?: string
  readonly bytes?: number
  readonly sha256?: string
  readonly mode?: number
  readonly identity?: FileIdentity
  readonly compressedBytes: Uint8Array
  readonly gitStatus: string
}

export interface FileSnapshotOptions {
  readonly maxBytes?: number
  readonly gitStatus?: string
}

export const DEFAULT_PATCH_LIMIT_BYTES = 10 * 1024 * 1024

/**
 * Captures one regular file below a canonical workspace root. Missing files
 * are represented explicitly; every other unsafe state fails closed.
 */
export async function captureFileSnapshot(workspaceRoot: string, workspacePath: string, options: FileSnapshotOptions = {}): Promise<FileSnapshot> {
  const root = await realpath(workspaceRoot)
  const absolute = resolveWorkspacePath(root, workspacePath)
  return captureAbsoluteSnapshot(root, absolute, relative(root, absolute), options)
}

export function resolveWorkspacePath(canonicalWorkspaceRoot: string, workspacePath: string): string {
  if (workspacePath.length === 0 || isAbsolute(workspacePath) || win32.isAbsolute(workspacePath) || /^[a-zA-Z]:/u.test(workspacePath) || /^[a-z][a-z0-9+.-]*:/iu.test(workspacePath)) throw new Error(`workspace path is unsafe: ${workspacePath}`)
  const absolute = resolve(canonicalWorkspaceRoot, workspacePath)
  const rest = relative(canonicalWorkspaceRoot, absolute)
  if (rest === '..' || rest.startsWith('../') || rest.startsWith('..\\') || isAbsolute(rest) || win32.isAbsolute(rest)) throw new Error(`workspace path escapes root: ${workspacePath}`)
  return absolute
}

export async function compareFileSnapshot(workspaceRoot: string, expected: FileSnapshot, options: FileSnapshotOptions = {}): Promise<{ readonly unchanged: boolean; readonly current: FileSnapshot }> {
  const root = await realpath(workspaceRoot)
  const absolute = resolveWorkspacePath(root, expected.path)
  const current = await captureAbsoluteSnapshot(root, absolute, relative(root, absolute), options)
  if (expected.state !== current.state) return { unchanged: false, current }
  if (expected.state === 'missing') return { unchanged: true, current }
  return {
    unchanged: expected.realPath === current.realPath && expected.bytes === current.bytes && expected.sha256 === current.sha256 && expected.mode === current.mode && sameIdentity(expected.identity, current.identity),
    current,
  }
}

async function captureAbsoluteSnapshot(root: string, absolute: string, displayPath: string, options: FileSnapshotOptions): Promise<FileSnapshot> {
  const maxBytes = options.maxBytes ?? DEFAULT_PATCH_LIMIT_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('snapshot patch limit is invalid')
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const parent = await realpath(resolve(absolute, '..'))
        const parentRelative = relative(root, parent)
        if (parentRelative === '..' || parentRelative.startsWith('../') || isAbsolute(parentRelative)) throw new Error(`workspace path escapes root: ${displayPath}`)
      } catch (parentError: unknown) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError
      }
      return { path: normalizeWorkspacePath(displayPath), state: 'missing', compressedBytes: new Uint8Array(0), gitStatus: options.gitStatus ?? 'unknown' }
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`workspace file is a symlink: ${displayPath}`)
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(`workspace target is not a private regular file: ${displayPath}`)
    if (opened.size > maxBytes) throw new Error(`workspace file exceeds patch limit: ${displayPath}`)
    const data = await handle.readFile()
    const afterRead = await handle.stat()
    const current = await lstat(absolute)
    const canonicalPath = await realpath(absolute)
    if (!current.isFile() || current.isSymbolicLink() || canonicalPath !== absolute || !sameStats(opened, afterRead) || !sameStats(opened, current) || data.byteLength !== opened.size) throw new Error(`workspace file changed during snapshot: ${displayPath}`)
    const sha256 = createHash('sha256').update(data).digest('hex')
    return {
      path: normalizeWorkspacePath(displayPath), state: 'present', realPath: canonicalPath, bytes: data.byteLength, sha256,
      mode: opened.mode & 0o7777, identity: { dev: opened.dev, ino: opened.ino, nlink: opened.nlink }, compressedBytes: gzipSync(data), gitStatus: options.gitStatus ?? 'unknown',
    }
  } finally { await handle.close() }
}

function normalizeWorkspacePath(value: string): string {
  return value.replaceAll('\\', '/')
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
}

function sameStats(left: { readonly dev: number; readonly ino: number; readonly nlink: number; readonly size: number }, right: { readonly dev: number; readonly ino: number; readonly nlink: number; readonly size: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size
}
