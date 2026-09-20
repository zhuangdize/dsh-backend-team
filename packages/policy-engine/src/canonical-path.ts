import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export class UnsafeTargetPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeTargetPathError'
  }
}

export async function canonicalizeTargetPath(workspaceRoot: string, targetPath: string): Promise<string> {
  if (workspaceRoot.includes('\0') || targetPath.includes('\0')) {
    throw new UnsafeTargetPathError('target path contains a NUL byte')
  }
  if (targetPath.length === 0) {
    throw new UnsafeTargetPathError('target path is empty')
  }
  rejectAmbiguousSegments(targetPath)

  const root = await realpath(workspaceRoot)
  const candidate = isAbsolute(targetPath) ? resolve(targetPath) : resolve(root, targetPath)
  const existingParent = await nearestExistingParent(candidate)
  const canonicalParent = await realpath(existingParent.path)
  const appended = existingParent.missingSegments.reduce((path, segment) => join(path, segment), canonicalParent)
  if (!isWithin(root, appended)) {
    throw new UnsafeTargetPathError('target path resolves outside the workspace')
  }
  return appended
}

/**
 * Revalidate the original request immediately before I/O, then execute only
 * `canonicalTargetPath`. This detects a request-path symlink swap while
 * preventing executors from substituting a cwd-relative target.
 */
export async function recheckAuthorizedTargetPath(
  workspaceRoot: string,
  requestedTargetPath: string,
  canonicalTargetPath: string,
): Promise<void> {
  const current = await canonicalizeTargetPath(workspaceRoot, requestedTargetPath)
  if (current !== canonicalTargetPath) {
    throw new UnsafeTargetPathError('target path changed after authorization')
  }
}

function rejectAmbiguousSegments(targetPath: string): void {
  const segments = targetPath.split(/[\\/]/u)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new UnsafeTargetPathError('target path contains an ambiguous segment')
  }
}

async function nearestExistingParent(candidate: string): Promise<{ path: string; missingSegments: string[] }> {
  const missingSegments: string[] = []
  let current = candidate
  while (true) {
    try {
      await lstat(current)
      return { path: current, missingSegments: missingSegments.reverse() }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      const parent = resolve(current, '..')
      if (parent === current) {
        throw new UnsafeTargetPathError('target path has no existing parent')
      }
      const segment = current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))
      if (!isValidatedBasename(segment)) {
        throw new UnsafeTargetPathError('target path has an ambiguous missing parent')
      }
      missingSegments.push(segment)
      current = parent
    }
  }
}

function isValidatedBasename(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\0') && !segment.includes('/') && !segment.includes('\\')
}

function isWithin(root: string, target: string): boolean {
  const pathToTarget = relative(root, target)
  return pathToTarget === '' || (!isAbsolute(pathToTarget) && pathToTarget !== '..' && !pathToTarget.startsWith(`..${sep}`))
}
