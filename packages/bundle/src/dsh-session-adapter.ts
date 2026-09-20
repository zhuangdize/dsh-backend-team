import { lstatSync, realpathSync } from 'node:fs'
import { AuthenticatedLocalSessionSchema } from '../../web/src/remote-contract.js'

export interface DshControlRouteRequest {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly remoteAddress?: string
}

/** Minimal host-owned view of the rc.6 Session/Agent stores. */
export interface DshSessionContext {
  readonly sessions?: { get(id: string): unknown }
  readonly agents?: { get(id: string): unknown }
}

export interface DshLocalSessionInputOptions {
  readonly context: DshSessionContext
  /** The same canonical workspace id used by the production view state. */
  readonly workspaceId: string
  /** Existing real directory that the production composition owns. */
  readonly workspaceRoot: string
  readonly readOnly?: boolean
}

/**
 * Build the host session extractor for the official DSH Session/Agent stores.
 * The route remains loopback-only; the query session id is accepted only after
 * both live stores prove the id and the session's canonical cwd belong to the
 * managed workspace. No browser object or Host header is treated as identity.
 */
export function createDshLocalSessionInput(options: DshLocalSessionInputOptions): (request: DshControlRouteRequest) => unknown {
  const workspaceRoot = canonicalDirectory(options.workspaceRoot)
  if (typeof options.workspaceId !== 'string' || options.workspaceId.length === 0) throw new TypeError('workspace id is required')
  let workspaceId: string
  try { workspaceId = canonicalDirectory(options.workspaceId) } catch { throw new Error('workspace id must name the canonical workspace root') }
  if (workspaceId !== workspaceRoot) throw new Error('workspace id must match the canonical workspace root')
  const sessions = requireStore(options.context.sessions, 'sessions')
  const agents = requireStore(options.context.agents, 'agents')
  const readOnly = options.readOnly ?? false

  return (request: DshControlRouteRequest): unknown => {
    if (request.remoteAddress !== undefined && !isLoopbackAddress(request.remoteAddress)) throw new Error('loopback session is required')
    const sessionId = request.query.sessionId
    if (sessionId === undefined || !/^\S{16,256}$/u.test(sessionId)) throw new Error('session id is required')
    const session = sessions.get(sessionId)
    if (!isSessionForWorkspace(session, sessionId, workspaceRoot)) throw new Error('session does not belong to the workspace')
    const agent = agents.get(sessionId)
    if (!isLiveAgent(agent, sessionId)) throw new Error('agent session is not live')
    return AuthenticatedLocalSessionSchema.parse({ sessionId, workspaceId, loopback: true, readOnly })
  }
}

function requireStore<T extends { get(id: string): unknown }>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || typeof value !== 'object') throw new TypeError(`${name} store is required`)
  try {
    if (typeof Reflect.get(value, 'get') !== 'function') throw new TypeError(`${name} store is required`)
    return value
  } catch (error: unknown) {
    if (error instanceof TypeError && error.message === `${name} store is required`) throw error
    throw new TypeError(`${name} store is required`, { cause: error })
  }
}

function isSessionForWorkspace(value: unknown, sessionId: string, workspaceRoot: string): boolean {
  if (value === null || typeof value !== 'object') return false
  try {
    const id = Reflect.get(value, 'id')
    const header = Reflect.get(value, 'header')
    const cwd = header !== null && typeof header === 'object' ? Reflect.get(header, 'cwd') : undefined
    return id === sessionId && typeof cwd === 'string' && canonicalDirectory(cwd) === workspaceRoot
  } catch {
    return false
  }
}

function isLiveAgent(value: unknown, sessionId: string): boolean {
  if (value === null || typeof value !== 'object') return false
  try { return Reflect.get(value, 'id') === sessionId } catch { return false }
}

function canonicalDirectory(input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new Error('workspace root is required')
  const root = realpathSync(input)
  if (!lstatSync(root).isDirectory()) throw new Error('workspace root must be a directory')
  return root
}

function isLoopbackAddress(value: string): boolean {
  return value === '127.0.0.1' || value === '::1' || /^::ffff:127\.0\.0\.1$/u.test(value)
}
