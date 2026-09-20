import type { ServerResponse } from 'node:http'
import type { LocalSessionAuthenticator } from './control-service.js'
import type { ControlRouteRequest, VerifiedWebServerBinding } from './control-route.js'
import { AuthenticatedLocalSessionSchema } from './remote-contract.js'

export interface DbGateLoginRouteOptions {
  readonly server: VerifiedWebServerBinding
  readonly workspaceId: string
  readonly sessionInput: (request: ControlRouteRequest) => unknown
  readonly authenticator: LocalSessionAuthenticator
  /** Host-only consumer checks the initiating session, expiry and one-time grant. */
  readonly consumeLogin: (authenticatedSessionId: string) => unknown
  readonly path?: string
}

/** Secrets leave through this authenticated no-store response only, never the event/state API. */
export function applyDbGateLoginRoute(options: DbGateLoginRouteOptions): () => void {
  if (options.server.verifiedProvenance !== true || !options.workspaceId) throw new Error('verified workspace host is required')
  const path = options.path ?? '/plugins/backend-team/dbgate-login'
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(path) || path.endsWith('/')) throw new Error('invalid login route')
  return options.server.register({ kind: 'prefix', path, handler: async (request, response) => {
    const remote = request.socket.remoteAddress
    const host = request.headers.host ?? ''
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') || !/^(127\.0\.0\.1|\[::1\]):[0-9]+$/.test(host)) return send(response, 403, { code: 'LOOPBACK_REQUIRED' })
    const parsed = new URL(request.url ?? '/', `http://${host}`)
    if (parsed.pathname !== path) return send(response, 404, { code: 'NOT_FOUND' })
    if (request.method !== 'POST') return send(response, 405, { code: 'METHOD_NOT_ALLOWED' })
    if (request.headers.origin !== `http://${host}` || !/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) return send(response, 403, { code: 'SAME_ORIGIN_REQUIRED' })
    request.resume()
    let session
    try {
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]))
      const input = options.sessionInput({ method: 'POST', path, query: Object.fromEntries(parsed.searchParams), headers, ...(remote === undefined ? {} : { remoteAddress: remote }) })
      session = AuthenticatedLocalSessionSchema.parse(options.authenticator.authenticate(input))
    } catch { return send(response, 401, { code: 'UNAUTHENTICATED' }) }
    if (session.readOnly || session.workspaceId !== options.workspaceId) return send(response, 403, { code: 'FORBIDDEN' })
    try {
      const value = await options.consumeLogin(session.sessionId)
      if (value === null || typeof value !== 'object') throw new Error('invalid login')
      const login = value as Record<string, unknown>
      if (typeof login.url !== 'string' || typeof login.username !== 'string' || !login.username || typeof login.password !== 'string' || !login.password) throw new Error('invalid login')
      const target = new URL(login.url)
      if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password) throw new Error('invalid login')
      send(response, 200, { username: login.username, password: login.password, url: login.url })
    } catch { send(response, 409, { code: 'LOGIN_UNAVAILABLE' }) }
  } })
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('pragma', 'no-cache')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
  response.end(JSON.stringify(value))
}
