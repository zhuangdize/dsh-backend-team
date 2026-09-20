import type { IncomingMessage, ServerResponse } from 'node:http'
import { ControlServiceError } from './control-service.js'

const DEFAULT_MAX_BODY_BYTES = 64 * 1024

export interface ControlRouteRequest {
  readonly method: string
  readonly path: string
  /** Parsed query values supplied by the host route; values are never trusted by themselves. */
  readonly query: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly remoteAddress?: string
}

export interface VerifiedWebServerBinding {
  readonly verifiedProvenance: true
  register(route: BackendTeamWebRoute): () => void
}

/** The exact public method consumed from `ctx.webServer` after fixture review. */
export interface PublicWebServerShape {
  register(route: BackendTeamWebRoute): () => void
}

export interface BackendTeamWebRoute {
  readonly kind: 'prefix'
  readonly path: string
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

export interface BackendTeamControlRouteOptions {
  readonly server: VerifiedWebServerBinding
  readonly service: BackendTeamControlServicePort
  /** Extract a host-owned authentication input; the route never authenticates a browser object itself. */
  readonly sessionInput: (request: ControlRouteRequest) => unknown
  readonly path?: string
  readonly maxBodyBytes?: number
}

/** Structural service boundary keeps the route safe across host/package realms. */
export interface BackendTeamControlServicePort {
  getResources?(sessionInput: unknown): Promise<unknown>
  getState(sessionInput: unknown): unknown
  dispatch(sessionInput: unknown, input: unknown): Promise<unknown>
}

/** Adapt the official WebServer method without exposing the host instance elsewhere. */
export function createVerifiedWebServerBinding(server: unknown): VerifiedWebServerBinding {
  if (typeof server !== 'object' || server === null || typeof Reflect.get(server, 'register') !== 'function') throw new Error('public WebServer.register method is required')
  const host = server as PublicWebServerShape
  return Object.freeze({ verifiedProvenance: true as const, register: (route: BackendTeamWebRoute) => host.register(route) })
}

/** Register the loopback control API against the official WebServer shape. */
export function applyBackendTeamControlRoute(options: BackendTeamControlRouteOptions): () => void {
  if (options.server.verifiedProvenance !== true) throw new Error('web server provenance is not verified')
  if (typeof options.service !== 'object' || options.service === null || typeof options.service.getState !== 'function' || typeof options.service.dispatch !== 'function') throw new TypeError('control route requires a BackendTeamControlService')
  if (typeof options.sessionInput !== 'function') throw new TypeError('control route requires a host session extractor')
  const path = options.path ?? '/plugins/backend-team/control'
  assertRoutePath(path)
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 1_024 * 1_024) throw new RangeError('control route body limit is invalid')

  const route: BackendTeamWebRoute = {
    kind: 'prefix',
    path,
    handler: async (request, response) => handleRequest(request, response, options.service, options.sessionInput, path, maxBodyBytes),
  }
  const remove = options.server.register(route)
  let removed = false
  return () => {
    if (removed) return
    removed = true
    remove()
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: BackendTeamControlServicePort,
  sessionInput: (request: ControlRouteRequest) => unknown,
  basePath: string,
  maxBodyBytes: number,
): Promise<void> {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) {
    sendJson(response, 403, { code: 'LOOPBACK_REQUIRED' })
    return
  }

  const parsed = parsePath(request.url, basePath)
  if (parsed === undefined) {
    sendJson(response, 400, { code: 'INVALID_PATH' })
    return
  }
  if (parsed !== 'state' && parsed !== 'dispatch' && parsed !== 'resources') {
    sendJson(response, 404, { code: 'NOT_FOUND' })
    return
  }

  const envelope: ControlRouteRequest = {
    method: request.method ?? '',
    path: parsed,
    query: requestQuery(request.url),
    headers: requestHeaders(request),
    ...(request.socket?.remoteAddress === undefined ? {} : { remoteAddress: request.socket.remoteAddress }),
  }
  let authenticatedInput: unknown
  try {
    authenticatedInput = sessionInput(envelope)
  } catch {
    sendJson(response, 401, { code: 'UNAUTHENTICATED' })
    return
  }

  try {
    if (request.method === 'GET' && parsed === 'resources' && service.getResources) {
      sendJson(response, 200, await service.getResources(authenticatedInput))
      return
    }
    if (request.method === 'GET' && parsed === 'state') {
      sendJson(response, 200, await service.getState(authenticatedInput))
      return
    }
    if (request.method === 'POST' && parsed === 'dispatch') {
      if (!isJsonContentType(request.headers['content-type'])) {
        sendJson(response, 415, { code: 'JSON_REQUIRED' })
        return
      }
      const body = await readJsonBody(request, maxBodyBytes)
      sendJson(response, 200, await service.dispatch(authenticatedInput, body))
      return
    }
    sendJson(response, 405, { code: 'METHOD_NOT_ALLOWED' })
  } catch (error: unknown) {
    sendServiceError(response, error)
  }
}

function requestQuery(input: string | undefined): Readonly<Record<string, string>> {
  if (typeof input !== 'string') return Object.freeze({})
  try {
    const values = new URL(input, 'http://127.0.0.1').searchParams
    const query: Record<string, string> = {}
    for (const [key, value] of values) {
      if (!Object.hasOwn(query, key)) query[key] = value
    }
    return Object.freeze(query)
  } catch {
    return Object.freeze({})
  }
}

function sendServiceError(response: ServerResponse, error: unknown): void {
  if (error instanceof ControlServiceError) {
    const status = error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'STALE_VIEW' ? 409 : error.code === 'INVALID_NAVIGATION' ? 502 : error.code === 'UNAVAILABLE' ? 503 : error.code === 'READ_ONLY' || error.code === 'WORKSPACE_MISMATCH' ? 403 : 400
    sendJson(response, status, { code: error.code, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) })
    return
  }
  if (error instanceof HttpRouteError) {
    sendJson(response, error.status, { code: error.code })
    return
  }
  if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
    sendJson(response, 400, { code: 'INVALID_JSON' })
    return
  }
  sendJson(response, 500, { code: 'INTERNAL_ERROR' })
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.writableEnded) return
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.end(JSON.stringify(value))
}

function requestHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  return Object.freeze(Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value[0] : value])))
}

function parsePath(input: string | undefined, basePath: string): 'state' | 'dispatch' | string | undefined {
  if (typeof input !== 'string') return undefined
  let pathname: string
  try { pathname = new URL(input, 'http://127.0.0.1').pathname } catch { return undefined }
  if (pathname === `${basePath}/state`) return 'state'
  if (pathname === `${basePath}/dispatch`) return 'dispatch'
  if (pathname === basePath || pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length + 1)
  return undefined
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += value.byteLength
      if (size > maxBodyBytes) throw new HttpRouteError(413, 'BODY_TOO_LARGE')
      chunks.push(value)
    }
  } catch (error: unknown) {
    if (error instanceof HttpRouteError) throw error
    throw new HttpRouteError(400, 'BODY_READ_FAILED')
  }
  if (size === 0) throw new HttpRouteError(400, 'JSON_REQUIRED')
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new HttpRouteError(400, 'INVALID_JSON') }
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  if (value === undefined) return false
  const contentType = Array.isArray(value) ? value[0] : value
  return typeof contentType === 'string' && /^application\/json(?:\s*;|$)/iu.test(contentType)
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (value === '::1' || value === '127.0.0.1') return true
  return typeof value === 'string' && /^::ffff:127\.0\.0\.1$/iu.test(value)
}

function assertRoutePath(path: string): void {
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@\/-]*$/u.test(path) || path.endsWith('/') || path.includes('//')) throw new Error('control route path must be an absolute path without a trailing slash')
}

class HttpRouteError extends Error {
  constructor(readonly status: 400 | 413, readonly code: 'BODY_TOO_LARGE' | 'BODY_READ_FAILED' | 'JSON_REQUIRED' | 'INVALID_JSON') { super(code); this.name = 'HttpRouteError' }
}
