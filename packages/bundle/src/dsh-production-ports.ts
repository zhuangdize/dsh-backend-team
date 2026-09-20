import { createVerifiedWebServerBinding } from '@dsh-backend-team/web'
import { createDshLocalSessionInput, type DshControlRouteRequest, type DshSessionContext } from './dsh-session-adapter.js'
import { createHarnessAgentPort, type HarnessAgentContext, type HarnessExecutionSessionFactory } from '@dsh-backend-team/harness-adapter'

/** Structural projection of the official rc.6 Cordis context. */
export interface DshProductionContext {
  readonly webServer?: unknown
  readonly sessions?: unknown
  readonly agents?: unknown
}

export interface VerifiedDshHostPort {
  readonly verifiedProvenance: true
  readonly server: DshWebServerBinding
  readonly host: '127.0.0.1'
  readonly port?: number
}

export interface VerifiedDshSessionPort {
  readonly verifiedProvenance: true
  readonly input: (request: DshControlRouteRequest) => unknown
  readonly authenticator: { authenticate(input: unknown): unknown }
}

/** Local declaration keeps the packed Bundle's public types host-neutral. */
export interface DshWebServerBinding {
  readonly verifiedProvenance: true
  register(route: { readonly kind: 'prefix'; readonly path: string; readonly handler: (request: unknown, response: unknown) => void | Promise<void> }): () => void
}

export interface VerifiedDshAgentPort {
  readonly verifiedProvenance: true
  spawnAgent(request: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface VerifiedDshSessionPortOptions extends DshProductionContext {
  /** Optional nested form for callers that already keep the full context object. */
  readonly context?: DshProductionContext
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly readOnly?: boolean
}

export interface VerifiedDshAgentPortOptions {
  readonly context: DshProductionContext
  readonly cwd: string
  readonly pluginId: string
  readonly provider?: string
  readonly model?: string
  readonly decodeResult: (input: DshAgentResultInput) => unknown
  readonly setupAgent?: (context: unknown, request: unknown) => void | Promise<void>
  readonly executionSessionFactory?: HarnessExecutionSessionFactory
}

export interface DshAgentResultInput {
  readonly request: unknown
  readonly sessionId: string
  readonly events: readonly unknown[]
  readonly assistant: { readonly content: readonly unknown[] }
  readonly usage?: unknown
  readonly hostUsage: { readonly tokens: number; readonly wallMs: number; readonly toolCalls: number; readonly retries: number }
}

/**
 * Adapt the actual rc.6 `ctx.webServer` service after checking its documented
 * loopback bind. A public `register()` method alone is not enough because the
 * WebServer can also be configured for all interfaces.
 */
export function createVerifiedDshHostPort(context: DshProductionContext): VerifiedDshHostPort {
  const webServer = requireObject(context?.webServer, 'webServer')
  const host = readString(webServer, 'host')
  if (host !== '127.0.0.1') throw new Error('DSH WebServer must be bound to loopback')
  const port = readOptionalPort(webServer)
  return Object.freeze({ verifiedProvenance: true as const, server: createVerifiedWebServerBinding(webServer), host: '127.0.0.1' as const, ...(port === undefined ? {} : { port }) })
}

/**
 * Bind the control route to the exact live Session + Agent stores owned by the
 * same rc.6 context. The returned extractor performs workspace/cwd and
 * loopback checks for every request.
 */
export function createVerifiedDshSessionPort(options: VerifiedDshSessionPortOptions): VerifiedDshSessionPort {
  const context = options?.context ?? options
  const sessions = requireStore(context?.sessions, 'sessions')
  const agents = requireStore(context?.agents, 'agents')
  const extract = createDshLocalSessionInput({ context: { sessions, agents }, workspaceId: options.workspaceId, workspaceRoot: options.workspaceRoot, ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }) })
  const issued = new WeakMap<object, DshControlRouteRequest>()
  const input = (request: DshControlRouteRequest): unknown => {
    const snapshot = Object.freeze({ method: request.method, path: request.path, query: Object.freeze({ ...request.query }), headers: Object.freeze({}), ...(request.remoteAddress === undefined ? {} : { remoteAddress: request.remoteAddress }) })
    const identity = Object.freeze(extract(snapshot) as object)
    issued.set(identity, snapshot)
    return identity
  }
  const authenticator = Object.freeze({ authenticate(value: unknown): unknown {
    const request = typeof value === 'object' && value !== null ? issued.get(value) : undefined
    if (request === undefined) throw new Error('verified host session input is required')
    return extract(request)
  } })
  return Object.freeze({ verifiedProvenance: true as const, input, authenticator })
}

/**
 * Bind the application Agent port to rc.6 `ctx.agents.create()`. This helper
 * is intentionally separate from activation so callers can inspect/compose
 * the verified port before opting into the writable production graph.
 */
export function createVerifiedDshAgentPort(options: VerifiedDshAgentPortOptions): VerifiedDshAgentPort {
  const agents = requireObject(options?.context?.agents, 'agents')
  if (typeof Reflect.get(agents, 'create') !== 'function') throw new TypeError('agents.create is required')
  const context: HarnessAgentContext = { agents: agents as HarnessAgentContext['agents'] }
  return createHarnessAgentPort({ context, cwd: options.cwd, pluginId: options.pluginId, decodeResult: options.decodeResult, ...(options.setupAgent === undefined ? {} : { setupAgent: options.setupAgent }), ...(options.executionSessionFactory === undefined ? {} : { executionSessionFactory: options.executionSessionFactory }), ...(options.provider === undefined ? {} : { provider: options.provider }), ...(options.model === undefined ? {} : { model: options.model }) }) as unknown as VerifiedDshAgentPort
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${name} service is required`)
  return value as Record<string, unknown>
}

function requireStore(value: unknown, name: string): NonNullable<DshSessionContext['sessions']> {
  const store = requireObject(value, name)
  if (typeof Reflect.get(store, 'get') !== 'function') throw new TypeError(`${name}.get is required`)
  return store as NonNullable<DshSessionContext['sessions']>
}

function readString(value: object, key: string): string | undefined {
  try { const result = Reflect.get(value, key); return typeof result === 'string' ? result : undefined } catch { return undefined }
}

function readOptionalPort(value: object): number | undefined {
  try {
    const result = Reflect.get(value, 'port')
    if (result === undefined) return undefined
    if (!Number.isSafeInteger(result) || result < 0 || result > 65535) throw new Error('DSH WebServer port is invalid')
    return result
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'DSH WebServer port is invalid') throw error
    throw new Error('DSH WebServer port is unavailable')
  }
}
