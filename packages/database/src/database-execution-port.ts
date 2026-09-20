import type { ProjectDatabases } from './database-catalog.js'
import type { DbGateLogin, DbGateStatus } from './dbgate-launcher.js'
import type { LocalDatabaseEndpoint } from './postgresql-config.js'
import type { ClusterStatus } from './postgresql-cluster.js'
import type { SchemaDesignSessionRecord } from './schema-design-session.js'
import { assertAllowlistedDesignDatabase } from './dbgate-security.js'

export interface DatabaseExecutionPort {
  /** Fixed by this adapter; callers cannot mark an arbitrary runner as production-safe. */
  readonly verifiedProvenance: true
  status(): DatabaseExecutionStatus
  start(): Promise<LocalDatabaseEndpoint>
  stop(): Promise<ClusterStatus>
  prepare(projectId?: string): Promise<ProjectDatabases>
  openGui(authenticatedSessionId?: string): Promise<DatabaseGuiNavigation>
  consumeGuiLogin(authenticatedSessionId: string): DbGateLogin
  /** Host-only ownership lookup; never accepts a database name from a browser. */
  designSession(): SchemaDesignSessionRecord | undefined
  dispose(): Promise<void>
}

export interface DatabaseExecutionStatus {
  readonly cluster: ClusterStatus
  readonly gui: DbGateStatus
}

export interface DatabaseGuiNavigation {
  readonly url: string
  readonly expiresAt: string
}

export interface DatabaseExecutionPortOptions {
  readonly cluster: DatabaseClusterPort
  readonly catalog: DatabaseCatalogPort
  readonly dbgate?: DatabaseGuiPort
  /** Creates and owns the disposable database shown by the GUI. */
  readonly designSession?: DatabaseDesignSessionPort
  /** Host-selected high port for DbGate. It is never derived from a browser request. */
  readonly guiPort?: number
  readonly guiTtlMs?: number
}

export interface DatabaseClusterPort {
  start(): Promise<LocalDatabaseEndpoint>
  stop(): Promise<void>
  status(): ClusterStatus
}

export interface DatabaseCatalogPort {
  ensureProjectDatabases(projectId?: string): Promise<ProjectDatabases>
}

export interface DatabaseGuiPort {
  start(config: { readonly endpoint: LocalDatabaseEndpoint; readonly port: number }): Promise<string>
  stop(): Promise<void>
  status(): DbGateStatus
  authorizeLogin?(authenticatedSessionId: string): void
  consumeLogin?(authenticatedSessionId: string): DbGateLogin
}

export interface DatabaseDesignSessionPort {
  open(sourceDatabase: string): Promise<SchemaDesignSessionRecord>
  discard(session: SchemaDesignSessionRecord): Promise<void>
}

const DEFAULT_GUI_TTL_MS = 120_000

/**
 * Narrow execution boundary for the workspace-local PostgreSQL stack.
 *
 * The port accepts already-constructed lifecycle objects only. It does not
 * accept a raw executable, URL, credential, or command callback, so a host
 * must explicitly assemble the reviewed PostgreSQL/DbGate implementations.
 */
export function createDatabaseExecutionPort(options: DatabaseExecutionPortOptions): DatabaseExecutionPort {
  assertOptions(options)
  const guiTtlMs = options.guiTtlMs ?? DEFAULT_GUI_TTL_MS
  if (!Number.isSafeInteger(guiTtlMs) || guiTtlMs < 1_000 || guiTtlMs > 3_600_000) throw new RangeError('database GUI TTL is invalid')
  let disposal: Promise<void> | undefined
  let activeDesignSession: SchemaDesignSessionRecord | undefined
  let guiOperation: Promise<void> = Promise.resolve()

  const port: DatabaseExecutionPort = {
    verifiedProvenance: true,
    designSession: () => activeDesignSession,
    status: () => Object.freeze({ cluster: options.cluster.status(), gui: options.dbgate?.status() ?? { state: 'stopped' as const } }),
    start: () => options.cluster.start(),
    stop: () => serializeGui(async () => {
      await stopServices()
      return options.cluster.status()
    }),
    prepare: async (projectId?: string) => {
      await options.cluster.start()
      return options.catalog.ensureProjectDatabases(projectId)
    },
    openGui: (authenticatedSessionId?: string) => serializeGui(() => openGuiProcess(authenticatedSessionId)),
    consumeGuiLogin: (authenticatedSessionId: string) => {
      if (options.dbgate?.consumeLogin === undefined) throw new Error('DbGate login delivery is not configured')
      return options.dbgate.consumeLogin(authenticatedSessionId)
    },
    dispose: () => {
      if (disposal !== undefined) return disposal
      disposal = serializeGui(async () => {
        const failures: unknown[] = []
        try { await stopServices() } catch (error: unknown) { failures.push(error) }
        if (failures.length > 0) throw new AggregateError(failures, 'database execution disposal failed')
      })
      return disposal
    },
  }
  async function openGuiProcess(authenticatedSessionId?: string): Promise<DatabaseGuiNavigation> {
    if (options.dbgate === undefined) throw new Error('DbGate execution port is not configured')
    if (options.designSession === undefined) throw new Error('DbGate design session port is not configured')
    const guiPort = requireGuiPort(options.guiPort)
    const endpoint = await options.cluster.start()
    const existing = options.dbgate.status()
    if (existing.state === 'running' && existing.url !== undefined) {
      if (activeDesignSession === undefined) throw new Error('DbGate running state has no owned design session')
      if (authenticatedSessionId !== undefined) options.dbgate.authorizeLogin?.(authenticatedSessionId)
      return navigation(existing.url, guiTtlMs)
    }

    // A prior design session may survive a failed GUI stop. Finish DbGate's
    // own cleanup first, then discard that session before creating another.
    if (existing.state !== 'stopped') {
      await options.dbgate.stop()
      if (options.dbgate.status().state !== 'stopped') throw new Error('DbGate cleanup is incomplete; retry before opening GUI')
    }
    if (activeDesignSession !== undefined) await discardActiveDesignSession()

    const databases = await options.catalog.ensureProjectDatabases()
    const designSession = await options.designSession.open(databases.development)
    // Register ownership before validating the returned endpoint so a failed
    // validation still has a session to retry-discard during the next stop.
    activeDesignSession = designSession
    try {
      const designEndpoint = designEndpointFor(endpoint, designSession)
      const url = await options.dbgate.start({ endpoint: designEndpoint, port: guiPort })
      if (authenticatedSessionId !== undefined) options.dbgate.authorizeLogin?.(authenticatedSessionId)
      return navigation(url, guiTtlMs)
    } catch (error: unknown) {
      try {
        if (options.dbgate.status().state !== 'stopped') {
          await options.dbgate.stop()
          if (options.dbgate.status().state !== 'stopped') throw new Error('DbGate cleanup is incomplete; design session is retained')
        }
        await options.designSession.discard(designSession)
        if (activeDesignSession === designSession) activeDesignSession = undefined
      } catch (cleanupError: unknown) {
        throw new AggregateError([error, cleanupError], 'DbGate design session cleanup failed')
      }
      throw error
    }
  }
  async function stopServices(): Promise<void> {
    if (options.dbgate !== undefined) {
      await options.dbgate.stop()
      if (options.dbgate.status().state !== 'stopped') throw new Error('DbGate did not stop; design session is retained')
    }
    // Keep both the design database and PostgreSQL alive if GUI termination
    // or design cleanup failed: the still-live GUI may reference that DB.
    if (activeDesignSession !== undefined) await discardActiveDesignSession()
    await options.cluster.stop()
  }
  async function discardActiveDesignSession(): Promise<void> {
    const session = activeDesignSession
    if (session === undefined) return
    if (options.designSession === undefined) throw new Error('DbGate design session port is not configured')
    await options.designSession.discard(session)
    activeDesignSession = undefined
  }
  function serializeGui<T>(operation: () => Promise<T>): Promise<T> {
    const result = guiOperation.then(operation)
    guiOperation = result.then(() => undefined, () => undefined)
    return result
  }
  return Object.freeze(port)
}

function designEndpointFor(clusterEndpoint: LocalDatabaseEndpoint, session: SchemaDesignSessionRecord): LocalDatabaseEndpoint {
  assertAllowlistedDesignDatabase(session.database)
  if (session.endpoint.host !== clusterEndpoint.host || session.endpoint.socketDirectory !== clusterEndpoint.socketDirectory || session.endpoint.user !== clusterEndpoint.user || session.endpoint.credentialRef !== clusterEndpoint.credentialRef || (session.endpoint.port !== undefined && session.endpoint.port !== clusterEndpoint.port)) throw new Error('DbGate design session endpoint does not belong to the active PostgreSQL cluster')
  return { ...clusterEndpoint, database: session.database }
}

function requireGuiPort(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error('DbGate port is required and must be local')
  return value
}

function navigation(url: string, ttlMs: number): DatabaseGuiNavigation {
  if (typeof url !== 'string' || url.length === 0) throw new Error('DbGate returned an empty URL')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('DbGate returned an invalid URL') }
  if (parsed.protocol !== 'http:' || parsed.username !== '' || parsed.password !== '' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]')) throw new Error('DbGate URL must be loopback-only')
  return Object.freeze({ url, expiresAt: new Date(Date.now() + ttlMs).toISOString() })
}

function assertOptions(options: DatabaseExecutionPortOptions): void {
  if (typeof options !== 'object' || options === null) throw new TypeError('database execution options are required')
  for (const [name, value] of [['cluster', options.cluster], ['catalog', options.catalog]] as const) {
    if (typeof value !== 'object' || value === null) throw new TypeError(`${name} execution port is required`)
  }
  if (typeof options.cluster.start !== 'function' || typeof options.cluster.stop !== 'function' || typeof options.cluster.status !== 'function') throw new TypeError('cluster execution port is invalid')
  if (typeof options.catalog.ensureProjectDatabases !== 'function') throw new TypeError('catalog execution port is invalid')
  if (options.dbgate !== undefined && (typeof options.dbgate.start !== 'function' || typeof options.dbgate.stop !== 'function' || typeof options.dbgate.status !== 'function')) throw new TypeError('DbGate execution port is invalid')
  if (options.designSession !== undefined && (typeof options.designSession.open !== 'function' || typeof options.designSession.discard !== 'function')) throw new TypeError('DbGate design session port is invalid')
}
