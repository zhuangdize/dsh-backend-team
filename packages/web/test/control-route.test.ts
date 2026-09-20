import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AuthenticatedLocalSessionSchema, BackendTeamControlService, BackendTeamViewProjector } from '../src/index.js'
import type { CoordinatorControlPort, LocalSessionAuthenticator } from '../src/index.js'
import { applyBackendTeamControlRoute, createVerifiedWebServerBinding } from '../src/control-route.js'

const session = { sessionId: 'session-1234567890', workspaceId: 'ws', loopback: true as const, readOnly: false }
const authenticator: LocalSessionAuthenticator = { authenticate: (input) => AuthenticatedLocalSessionSchema.parse(input) }

describe('Backend Team control route', () => {
  it('wraps the proven WebServer.register shape without losing its receiver', () => {
    let receiverWasServer = false
    const server = {
      register(route: unknown) {
        receiverWasServer = this === server
        expect(route).toMatchObject({ kind: 'prefix', path: '/plugins/backend-team/control' })
        return () => undefined
      },
    }
    const binding = createVerifiedWebServerBinding(server)
    expect(binding.verifiedProvenance).toBe(true)
    applyBackendTeamControlRoute({ server: binding, service: service(), sessionInput: () => session })()
    expect(receiverWasServer).toBe(true)
  })

  it('rejects a web server without a public register method', () => {
    expect(() => createVerifiedWebServerBinding({})).toThrow(/register/i)
  })

  it('rejects a web server without verified provenance', () => {
    expect(() => applyBackendTeamControlRoute({
      server: { verifiedProvenance: false, register: () => () => undefined } as never,
      service: service(),
      sessionInput: () => session,
    })).toThrow(/web server provenance/i)
  })

  it.each([false, true])('serves authenticated state reads, including asynchronous task lookup: %s', async asynchronous => {
    const routes: Array<{ kind: string; path: string; handler: (request: unknown, response: unknown) => Promise<void> }> = []
    const response = makeResponse()
    const actual = service()
    const dispose = applyBackendTeamControlRoute({
      server: { verifiedProvenance: true as const, register: (route) => { routes.push(route as never); return () => routes.splice(0, 1) } },
      service: asynchronous ? { getState: async input => actual.getState(input), dispatch: (identity, action) => actual.dispatch(identity, action) } : actual,
      sessionInput: () => session,
    })

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/plugins/backend-team/control' })
    await routes[0]!.handler(makeRequest('GET', '/plugins/backend-team/control/state', undefined, '127.0.0.1'), response)
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ workspaceName: 'demo', phase: 'DISCOVER' })
    expect(response.headers['cache-control']).toBe('no-store')

    dispose()
    expect(routes).toHaveLength(0)
  })

  it('passes only the first query value to the host session extractor', async () => {
    let received: Record<string, string> | undefined
    const response = makeResponse()
    const routes: Array<{ handler: (request: unknown, response: unknown) => Promise<void> }> = []
    applyBackendTeamControlRoute({
      server: { verifiedProvenance: true as const, register: (route) => { routes.push(route as never); return () => undefined } },
      service: service(),
      sessionInput: (request) => { received = { ...request.query }; return session },
    })

    await routes[0]!.handler(makeRequest('GET', '/plugins/backend-team/control/state?sessionId=first&sessionId=second', undefined, '127.0.0.1'), response)
    expect(response.statusCode).toBe(200)
    expect(received).toEqual({ sessionId: 'first' })
  })

  it('rejects a non-loopback request before invoking session extraction', async () => {
    let extracted = false
    const response = makeResponse()
    const routes: Array<{ handler: (request: unknown, response: unknown) => Promise<void> }> = []
    applyBackendTeamControlRoute({
      server: { verifiedProvenance: true as const, register: (route) => { routes.push(route as never); return () => undefined } },
      service: service(),
      sessionInput: () => { extracted = true; return session },
    })

    await routes[0]!.handler(makeRequest('GET', '/plugins/backend-team/control/state', undefined, '192.0.2.10'), response)
    expect(response.statusCode).toBe(403)
    expect(extracted).toBe(false)
  })

  it('dispatches bounded JSON commands and maps malformed input to 400', async () => {
    let dispatched = false
    const response = makeResponse()
    const serviceWithDispatch = service({ dispatch: async () => { dispatched = true; return { accepted: true, stateRevision: 1 } } })
    const routes: Array<{ handler: (request: unknown, response: unknown) => Promise<void> }> = []
    applyBackendTeamControlRoute({
      server: { verifiedProvenance: true as const, register: (route) => { routes.push(route as never); return () => undefined } },
      service: serviceWithDispatch,
      sessionInput: () => session,
    })

    await routes[0]!.handler(makeRequest('POST', '/plugins/backend-team/control/dispatch', JSON.stringify({ type: 'pause-run', workspaceId: 'ws', expectedRevision: 0 }), '127.0.0.1', 'application/json'), response)
    expect(response.statusCode).toBe(200)
    expect(dispatched).toBe(true)

    const malformed = makeResponse()
    await routes[0]!.handler(makeRequest('POST', '/plugins/backend-team/control/dispatch', '{"type":', '127.0.0.1', 'application/json'), malformed)
    expect(malformed.statusCode).toBe(400)
  })

  it('requires an explicit JSON content type for dispatch requests', async () => {
    let dispatched = false
    const response = makeResponse()
    const routes: Array<{ handler: (request: unknown, response: unknown) => Promise<void> }> = []
    applyBackendTeamControlRoute({
      server: { verifiedProvenance: true as const, register: (route) => { routes.push(route as never); return () => undefined } },
      service: service({ dispatch: async () => { dispatched = true; return { accepted: true, stateRevision: 0 } } }),
      sessionInput: () => session,
    })

    await routes[0]!.handler(makeRequest('POST', '/plugins/backend-team/control/dispatch', '{}', '127.0.0.1', undefined), response)
    expect(response.statusCode).toBe(415)
    expect(dispatched).toBe(false)
  })

  it('maps a closing control service to temporary unavailable', async () => {
    const response = makeResponse()
    const closedService = service()
    await closedService.closeAndDrain()
    const routes: Array<{ handler: (request: unknown, response: unknown) => Promise<void> }> = []
    applyBackendTeamControlRoute({
      server: { verifiedProvenance: true as const, register: (route) => { routes.push(route as never); return () => undefined } },
      service: closedService,
      sessionInput: () => session,
    })

    await routes[0]!.handler(makeRequest('GET', '/plugins/backend-team/control/state', undefined, '127.0.0.1'), response)
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toMatchObject({ code: 'UNAVAILABLE' })
  })
})

function service(overrides: Partial<CoordinatorControlPort> = {}): BackendTeamControlService {
  return new BackendTeamControlService(
    new BackendTeamViewProjector({ workspaceName: 'demo' }),
    { dispatch: async (_action, context) => ({ accepted: true, stateRevision: context.expectedRevision, ...overrides.dispatch === undefined ? {} : await overrides.dispatch(_action, context) }) },
    authenticator,
  )
}

function makeRequest(method: string, url: string, body: string | undefined, remoteAddress: string, contentType?: string): Readable & { method: string; url: string; headers: Record<string, string>; socket: { remoteAddress: string } } {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as Readable & { method: string; url: string; headers: Record<string, string>; socket: { remoteAddress: string } }
  request.method = method
  request.url = url
  request.headers = { 'x-session': session.sessionId, ...(contentType === undefined ? {} : { 'content-type': contentType }) }
  request.socket = { remoteAddress }
  return request
}

function makeResponse(): { statusCode: number; headers: Record<string, string>; body: string; setHeader(name: string, value: string): void; end(body?: string): void } {
  return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value }, end(body = '') { this.body += body } }
}
