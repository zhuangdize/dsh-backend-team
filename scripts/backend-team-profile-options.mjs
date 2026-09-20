import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const DEFAULT_PROFILE = 'web'
export const HARNESS_VERSION = '0.1.0-rc.6'
export const NODE_VERSION = '24.19.0'

export function resolveProfileName(value) {
  const profile = typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_PROFILE
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) throw new Error('Profile name must contain only letters, numbers, dots, underscores, and hyphens')
  return profile
}

export function resolveWorkspaceRoot(value, cwd = process.cwd()) {
  const workspace = typeof value === 'string' && value.trim().length > 0 ? value.trim() : cwd
  const resolved = resolve(workspace)
  if (!isAbsolute(resolved)) throw new Error('workspace path must be absolute')
  return resolved
}

export function resolveDshHome(workspaceRoot, value) {
  if (typeof value === 'string' && value.trim().length > 0) return resolve(value.trim())
  return join(resolveWorkspaceRoot(workspaceRoot), '.backend-team', 'runtime', 'dsh-home')
}

export async function resolveProfileStoreDirectory(workspaceRoot, dshHome, profile) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  const home = resolveDshHome(root, dshHome)
  if (isWithin(root, home)) return join(root, '.backend-team', 'runtime', 'dsh-store')

  const profileRoot = join(home, 'profiles', resolveProfileName(profile))
  try {
    const metadataText = await readFile(join(profileRoot, 'node_modules', '.modules.yaml'), 'utf8')
    const metadata = parseStoreMetadata(metadataText)
    if (metadata !== undefined) return /[\\/]v\d+$/u.test(metadata) ? dirname(metadata) : metadata
  } catch {
    // A new explicit user Profile has no existing store yet; use the workspace store.
  }
  return join(root, '.backend-team', 'runtime', 'dsh-store')
}

export function resolveDshBinDirectory(workspaceRoot) {
  return join(resolveWorkspaceRoot(workspaceRoot), '.backend-team', 'runtime', 'dsh', HARNESS_VERSION, 'node_modules', '.bin')
}

export function resolveWorkspaceNodeExecutable(workspaceRoot) {
  return join(resolveWorkspaceRoot(workspaceRoot), '.backend-team', 'runtime', 'nvm', 'versions', 'node', `v${NODE_VERSION}`, 'bin', 'node')
}

export async function resolveWorkspaceNodePath(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  let canonicalRoot
  try { canonicalRoot = await realpath(root) } catch { throw new Error(`workspace root was not found: ${root}`) }
  const candidate = resolveWorkspaceNodeExecutable(canonicalRoot)
  let canonical
  try { canonical = await realpath(candidate) } catch { throw new Error(`workspace-local Node executable was not found: ${candidate}`) }
  if (!isWithin(canonicalRoot, canonical)) throw new Error('workspace-local Node symlink escapes the workspace')
  try { await access(canonical, constants.X_OK) } catch { throw new Error(`workspace-local Node executable is not runnable: ${candidate}`) }
  return canonical
}

export async function resolveDshPath(value, workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  let canonicalRoot
  try {
    canonicalRoot = await realpath(root)
  } catch {
    throw new Error(`workspace root was not found: ${root}`)
  }
  const candidate = typeof value === 'string' && value.trim().length > 0
    ? resolve(value.trim())
    : join(resolveDshBinDirectory(canonicalRoot), 'dsh')
  try {
    const canonical = await realpath(candidate)
    if (!isWithin(canonicalRoot, canonical)) throw new Error('DSH symlink escapes the workspace-local runtime')
    await access(canonical, constants.X_OK)
    return canonical
  } catch {
    throw new Error(`workspace-local DSH executable was not found: ${candidate}`)
  }
}

function isWithin(parent, child) {
  const root = resolve(parent)
  const target = resolve(child)
  return target === root || target.startsWith(`${root}${sep}`)
}

function parseStoreMetadata(text) {
  try {
    const metadata = JSON.parse(text)
    if (typeof metadata?.storeDir === 'string' && metadata.storeDir.trim().length > 0) return resolve(metadata.storeDir.trim())
  } catch {
    const match = /^\s*storeDir:\s*(['"]?)(.+?)\1\s*$/mu.exec(text)
    if (match?.[2] !== undefined && match[2].trim().length > 0) return resolve(match[2].trim())
  }
  return undefined
}
