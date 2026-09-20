import { AgentCapabilitySetSchema } from '@dsh-backend-team/contracts'
import type { AgentCapabilitySet } from '@dsh-backend-team/contracts'

const booleanCapabilities = [
  'readProjectFiles', 'writeOwnedFiles', 'businessCodeWrite', 'testCodeWrite', 'configurationWrite',
  'commandExecution', 'install', 'migration', 'canDelegate', 'canChangePhase', 'canApprove',
  'canContactUser', 'canAnnounceCompletion',
] as const satisfies readonly (keyof AgentCapabilitySet)[]

const forbiddenChildCapabilities = new Set<keyof AgentCapabilitySet>([
  'commandExecution', 'canDelegate', 'canChangePhase', 'canApprove', 'canContactUser', 'canAnnounceCompletion',
])

/**
 * Computes the privilege intersection for a child. Missing privileges are
 * treated as denied by the contract schema, and global state/user privileges
 * are denied even if every input asks for them.
 */
export function intersectCapabilities(
  parent: Partial<AgentCapabilitySet>,
  requested: Partial<AgentCapabilitySet>,
  roleMaximum: Partial<AgentCapabilitySet> = {},
  presetMaximum: Partial<AgentCapabilitySet> = {},
): AgentCapabilitySet {
  const result: Record<string, unknown> = {}
  for (const key of booleanCapabilities) {
    result[key] = forbiddenChildCapabilities.has(key)
      ? false
      : Boolean(parent[key]) && Boolean(requested[key]) && Boolean(roleMaximum[key]) && Boolean(presetMaximum[key])
  }
  const parentHosts = new Set((parent.networkHosts ?? []).map((host) => host.trim().toLowerCase()))
  const requestedHosts = new Set((requested.networkHosts ?? []).map((host) => host.trim().toLowerCase()))
  const roleHosts = new Set((roleMaximum.networkHosts ?? []).map((host) => host.trim().toLowerCase()))
  const presetHosts = new Set((presetMaximum.networkHosts ?? []).map((host) => host.trim().toLowerCase()))
  result.networkHosts = [...parentHosts].filter((host) => requestedHosts.has(host) && roleHosts.has(host) && presetHosts.has(host))
  return AgentCapabilitySetSchema.parse(result)
}

function safePath(path: string): boolean {
  return typeof path === 'string'
    && path.length > 0
    && !/[\u0000-\u001F\u007F]/u.test(path)
    && !path.startsWith('/')
    && !path.includes('\\')
    && !/^[A-Za-z]:/u.test(path)
    && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

const secretDirectories = new Set(['.aws', '.gnupg', '.ssh', 'credential', 'credentials', 'private', 'secrets'])
const secretFileName = /(?:^|[._-])(?:credential(?:s)?|token|password|secret|private[-_]?key|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$)/iu
const privateKeyExtension = /\.(?:key|pem|p12|pfx)$/iu

function sensitivePath(path: string): boolean {
  return path.split('/').some((segment) => /^\.env(?:$|rc$|[._].*)/iu.test(segment)
    || /^\.npmrc$/iu.test(segment)
    || privateKeyExtension.test(segment)
    || secretFileName.test(segment)
    || secretDirectories.has(segment.toLowerCase()))
}

export function isPathWithin(path: string, scope: string): boolean {
  if (!safePath(path) || !safePath(scope) || sensitivePath(path) || sensitivePath(scope) || /[*?[]/u.test(path)) return false
  if (scope === path || scope === '') return true
  return path.startsWith(`${scope}/`)
}

function matchesPattern(path: string, pattern: string): boolean {
  if (!safePath(path) || typeof pattern !== 'string' || pattern.length === 0) return false
  if (pattern === '**/*.test.*') return /(?:^|\/)[^/]+\.test\.[^/]+$/u.test(path)
  if (pattern === '**/*.spec.*') return /(?:^|\/)[^/]+\.spec\.[^/]+$/u.test(path)
  if (pattern.endsWith('/**')) return isPathWithin(path, pattern.slice(0, -3))
  if (pattern.includes('*') || pattern.includes('?')) return false
  return isPathWithin(path, pattern)
}

/** Returns the concrete requested paths covered by every supplied scope. */
export function intersectPaths(
  parentPaths: readonly string[],
  requestedPaths: readonly string[],
  allowedPatterns: readonly string[] = [],
): readonly string[] {
  const unique = new Set<string>()
  for (const path of requestedPaths) {
    if (!safePath(path)) continue
    if (!parentPaths.some((scope) => isPathWithin(path, scope))) continue
    if (allowedPatterns.length > 0 && !allowedPatterns.some((pattern) => matchesPattern(path, pattern))) continue
    unique.add(path)
  }
  return [...unique].sort()
}

export function isSafeWorkspacePath(path: string): boolean {
  return safePath(path) && !sensitivePath(path)
}

export function pathsOverlap(left: string, right: string): boolean {
  if (!safePath(left) || !safePath(right)) return true
  return isPathWithin(left, right) || isPathWithin(right, left)
}
