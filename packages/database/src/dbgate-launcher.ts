import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { buildDbGateEnvironment, assertAllowlistedDesignDatabase, assertDbGatePath, assertLoopbackListeners, type DbGateSecurityConfig } from './dbgate-security.js'
import type { CredentialStore } from './credential-store.js'
import { assertLocalEndpoint, type LocalDatabaseEndpoint } from './postgresql-config.js'

export interface DbGateProcess { readonly pid: number; readonly executable: string }
export interface DbGateProcessAdapter { start(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<DbGateProcess>; stop(process: DbGateProcess): Promise<void>; inspectListeners(process: DbGateProcess): Promise<readonly string[]>; isReady(url: string): Promise<boolean> }
export interface DbGateLauncherOptions { readonly workspaceRoot: string; readonly runtimeRoot: string; readonly executable: string; readonly process: DbGateProcessAdapter; readonly credentials: CredentialStore; readonly readinessTimeoutMs?: number; readonly readinessPollMs?: number }
export interface DbGateLaunchConfig { readonly endpoint: LocalDatabaseEndpoint; readonly port: number }
export interface DbGateStatus { readonly state: 'stopped' | 'running' | 'interrupted'; readonly url?: string; readonly process?: DbGateProcess }
export interface DbGateLogin { readonly username: string; readonly password: string; readonly url: string }
export class DbGateLauncher {
  private running: DbGateProcess | undefined
  private pendingCleanup: DbGateProcess | undefined
  private url: string | undefined
  private operation: Promise<void> = Promise.resolve()
  private login: DbGateLogin | undefined
  private loginGrant: { readonly sessionId: string; readonly expiresAt: number } | undefined
  constructor(private readonly options: DbGateLauncherOptions) {
    for (const value of [options.readinessTimeoutMs ?? 30_000, options.readinessPollMs ?? 100]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new RangeError('DbGate readiness timing is invalid')
    }
  }
  start(config: DbGateLaunchConfig): Promise<string> {
    return this.serialize(() => this.startProcess(config))
  }
  stop(): Promise<void> {
    return this.serialize(() => this.stopProcess())
  }
  private async startProcess(config: DbGateLaunchConfig): Promise<string> {
    assertDbGatePath(this.options.runtimeRoot, this.options.workspaceRoot)
    assertDbGatePath(this.options.executable, this.options.runtimeRoot)
    assertLocalEndpoint(config.endpoint); assertAllowlistedDesignDatabase(config.endpoint.database); if (config.port < 1024 || config.port > 65535) throw new Error('DbGate port must be high and local')
    if (this.pendingCleanup !== undefined) throw new Error('DbGate cleanup is incomplete; retry stop before starting')
    if (this.running !== undefined && this.url !== undefined) return this.url
    const databasePasswordBytes = await this.options.credentials.get(config.endpoint.credentialRef)
    if (databasePasswordBytes === undefined || databasePasswordBytes.byteLength === 0) throw new Error('DbGate PostgreSQL credential is unavailable')
    const credentials: DbGateSecurityConfig = { runtimeRoot: this.options.runtimeRoot, username: `team_${randomBytes(8).toString('hex')}`, password: randomBytes(24).toString('base64url'), port: config.port, endpoint: config.endpoint, databasePassword: Buffer.from(databasePasswordBytes).toString('utf8') }
    const env = buildDbGateEnvironment(credentials); const child = await this.options.process.start(this.options.executable, ['--port', String(config.port), '--host', '127.0.0.1', '--no-shell'], this.options.runtimeRoot, env)
    const url = `http://127.0.0.1:${config.port}/`
    try {
      await this.waitForReady(child, url, config.port)
    } catch (error: unknown) {
      this.pendingCleanup = child
      try {
        await this.stopProcess()
      } catch (cleanupError: unknown) {
        throw new AggregateError([error, cleanupError], 'DbGate startup and cleanup failed')
      }
      throw error
    }
    this.running = child; this.url = url
    this.login = Object.freeze({ username: credentials.username, password: credentials.password, url })
    return url
  }
  /** Host-only: call after authenticating the initiating open-GUI command. */
  authorizeLogin(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length < 16 || this.running === undefined || this.login === undefined) throw new Error('DbGate login is unavailable')
    this.loginGrant = { sessionId, expiresAt: Date.now() + 60_000 }
  }
  /** Dedicated authenticated handoff only; never include this result in state/events. */
  consumeLogin(sessionId: string): DbGateLogin {
    if (this.loginGrant === undefined || this.loginGrant.sessionId !== sessionId || this.loginGrant.expiresAt <= Date.now() || this.running === undefined || this.login === undefined) throw new Error('DbGate login is unavailable')
    this.loginGrant = undefined
    return this.login
  }
  private async waitForReady(child: DbGateProcess, url: string, port: number): Promise<void> {
    const controller = new AbortController()
    const { signal } = controller
    const timeout = delay(this.options.readinessTimeoutMs ?? 30_000, undefined, { signal }).then(() => { throw new Error('DbGate did not become ready before its deadline') })
    const poll = async (): Promise<void> => {
      while (true) {
        const listeners = await this.options.process.inspectListeners(child)
        signal.throwIfAborted()
        assertLoopbackListeners(listeners)
        // A different process answering HTTP on this port is not readiness.
        if (listeners.includes(`127.0.0.1:${port}`) && await this.options.process.isReady(url)) {
          signal.throwIfAborted()
          return
        }
        await delay(this.options.readinessPollMs ?? 100, undefined, { signal })
      }
    }
    try { await Promise.race([poll(), timeout]) } finally { controller.abort() }
  }
  private async stopProcess(): Promise<void> {
    this.pendingCleanup ??= this.running
    this.running = undefined
    this.url = undefined
    this.login = undefined
    this.loginGrant = undefined
    if (this.pendingCleanup !== undefined) await this.options.process.stop(this.pendingCleanup)
    this.pendingCleanup = undefined
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }
  status(): DbGateStatus {
    if (this.pendingCleanup !== undefined) return { state: 'interrupted', process: this.pendingCleanup }
    return this.running === undefined ? { state: 'stopped' } : { state: 'running', ...(this.url === undefined ? {} : { url: this.url }), process: this.running }
  }
  authFingerprint(): string | undefined { return this.url === undefined ? undefined : createHash('sha256').update(this.url).digest('hex') }
}
