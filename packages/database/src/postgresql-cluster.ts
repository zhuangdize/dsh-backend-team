import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { buildPostgresqlConfig, type LocalDatabaseEndpoint } from './postgresql-config.js'
import { generateDatabasePassword, type CredentialStore } from './credential-store.js'
import { readPrivateFile } from './private-storage.js'
import { PortAllocator, type PortLease } from './port-allocator.js'

export interface ClusterProcessRecord { readonly pid: number; readonly executable: string; readonly dataDirectory: string; readonly startedAt: string }
export interface PostgresqlProcessAdapter { start(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<ClusterProcessRecord>; stop(record: ClusterProcessRecord, executable: string, args: readonly string[], cwd: string): Promise<void>; isReady(endpoint: LocalDatabaseEndpoint): Promise<boolean>; inspectListeners(record: ClusterProcessRecord): Promise<readonly string[]>; initdb?(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<void> }
export interface PostgresqlClusterOptions { readonly workspaceRoot: string; readonly runtimeRoot: string; readonly executableRoot: string; readonly process: PostgresqlProcessAdapter; readonly credentials: CredentialStore; readonly ports?: PortAllocator }
export interface ClusterStatus { readonly state: 'stopped' | 'initialized' | 'running' | 'interrupted'; readonly endpoint?: LocalDatabaseEndpoint; readonly process?: ClusterProcessRecord }

/** Owns one authenticated, loopback-only PostgreSQL cluster under the workspace. */
export class PostgresqlCluster {
  private readonly dataDirectory: string
  private readonly socketDirectory: string
  private endpoint: LocalDatabaseEndpoint | undefined
  private processRecord: ClusterProcessRecord | undefined
  private portLease: PortLease | undefined
  private initialized = false
  private verifiedRunning = false
  private operation: Promise<void> = Promise.resolve()
  constructor(private readonly options: PostgresqlClusterOptions) { this.dataDirectory = resolve(options.runtimeRoot, 'data-18'); this.socketDirectory = resolve(options.runtimeRoot, 'socket') }

  initialize(): Promise<LocalDatabaseEndpoint> { return this.serialize(() => this.initializeInternal()) }
  start(): Promise<LocalDatabaseEndpoint> { return this.serialize(() => this.startInternal()) }
  stop(): Promise<void> { return this.serialize(() => this.stopInternal()) }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async initializeInternal(): Promise<LocalDatabaseEndpoint> {
    if (this.initialized) return this.endpoint!
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 }); await mkdir(this.socketDirectory, { recursive: true, mode: 0o700 }); await mkdir(join(this.options.runtimeRoot, 'logs'), { recursive: true, mode: 0o700 })
    for (const path of [this.options.runtimeRoot, this.dataDirectory, this.socketDirectory]) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('PostgreSQL runtime directory is unsafe')
    }
    const lockPath = join(this.options.runtimeRoot, '.initialize.lock')
    const lock = await open(lockPath, 'wx', 0o600)
    try { return await this.initializeOwned() } finally { await lock.close(); await unlink(lockPath) }
  }

  private async initializeOwned(): Promise<LocalDatabaseEndpoint> {
    const metadataPath = join(this.options.runtimeRoot, '.cluster.json')
    const saved = await readPrivateFile(metadataPath)
    let credentialRef: string
    if (saved !== undefined) {
      const metadata = JSON.parse(saved.toString('utf8')) as Record<string, unknown>
      if (metadata.version !== 1 || metadata.workspaceRoot !== resolve(this.options.workspaceRoot) || metadata.dataDirectory !== this.dataDirectory || typeof metadata.credentialRef !== 'string') throw new Error('PostgreSQL recovery metadata does not match workspace')
      if ((await readPrivateFile(join(this.dataDirectory, 'PG_VERSION')))?.toString('utf8').trim() !== '18') throw new Error('PostgreSQL recovery requires existing version 18 data')
      const credential = await this.options.credentials.get(metadata.credentialRef)
      if (credential === undefined || credential.length === 0) throw new Error('PostgreSQL recovery credential is unavailable; existing data preserved')
      try { await lstat(join(this.dataDirectory, 'postmaster.pid')); throw new Error('PostgreSQL existing process requires recovery before restart') }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      credentialRef = metadata.credentialRef
    } else {
      if ((await readdir(this.dataDirectory)).length > 0) throw new Error('PostgreSQL existing data has no recovery metadata; existing data preserved')
      const password = generateDatabasePassword(); const key = `postgresql-${createHash('sha256').update(this.options.workspaceRoot).digest('hex')}`; credentialRef = await this.options.credentials.put(key, password)
      if (this.options.process.initdb !== undefined) {
        const pwfile = join(this.options.runtimeRoot, `initdb-${process.pid}-${Date.now()}.pw`)
        const handle = await open(pwfile, 'wx', 0o600)
        try {
          await handle.writeFile(password); await handle.chmod(0o600)
          await this.options.process.initdb(join(this.options.executableRoot, 'bin/initdb'), ['--pgdata', this.dataDirectory, '--username', 'backend_team', '--pwfile', pwfile, '--data-checksums', '--encoding', 'UTF8'], this.options.runtimeRoot, { PATH: resolve(this.options.executableRoot, 'bin'), PGDATA: this.dataDirectory })
        } finally { await handle.close(); await unlink(pwfile).catch(() => undefined) }
      }
    }
    const endpoint: LocalDatabaseEndpoint = { socketDirectory: this.socketDirectory, host: '127.0.0.1', database: 'postgres', user: 'backend_team', credentialRef }
    const config = buildPostgresqlConfig(this.options.runtimeRoot, endpoint)
    await writeOwnedConfig(join(this.dataDirectory, 'postgresql.conf'), config.postgresqlConf)
    await writeOwnedConfig(join(this.dataDirectory, 'pg_hba.conf'), config.pgHbaConf)
    if (saved === undefined) {
      const handle = await open(metadataPath, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ version: 1, workspaceRoot: resolve(this.options.workspaceRoot), dataDirectory: this.dataDirectory, credentialRef })); await handle.sync() } finally { await handle.close() }
    }
    this.endpoint = endpoint; this.initialized = true
    return endpoint
  }

  private async startInternal(): Promise<LocalDatabaseEndpoint> {
    const endpoint = await this.initializeInternal()
    if (this.processRecord !== undefined) {
      if (!this.verifiedRunning) throw new Error('PostgreSQL cleanup is incomplete; stop before restarting')
      return endpoint
    }
    this.portLease = await (this.options.ports ?? new PortAllocator(this.options.workspaceRoot)).allocate()
    this.endpoint = { ...endpoint, port: this.portLease.port }
    const executable = join(this.options.executableRoot, 'bin/pg_ctl')
    try {
      this.processRecord = await this.options.process.start(executable, ['-D', this.dataDirectory, '-o', `-p ${this.portLease.port}`, '-w', 'start'], this.dataDirectory, { PATH: resolve(this.options.executableRoot, 'bin'), PGDATA: this.dataDirectory })
      const listeners = await this.options.process.inspectListeners(this.processRecord)
      if (listeners.some((listener) => !isLoopbackListener(listener))) throw new Error('PostgreSQL has a non-loopback listener')
      if (!(await this.options.process.isReady(this.endpoint))) throw new Error('PostgreSQL did not become ready')
      this.verifiedRunning = true
      return this.endpoint
    } catch (error: unknown) {
      try { await this.stopInternal() } catch (cleanupError: unknown) { throw new AggregateError([error, cleanupError], 'PostgreSQL startup failed and cleanup is incomplete') }
      throw error
    }
  }

  private async stopInternal(): Promise<void> {
    this.verifiedRunning = false
    if (this.processRecord !== undefined) {
      const record = this.processRecord; if (record.executable !== join(this.options.executableRoot, 'bin/pg_ctl') || record.dataDirectory !== this.dataDirectory) throw new Error('process identity mismatch')
      await this.options.process.stop(record, record.executable, ['-D', this.dataDirectory, '-m', 'fast', '-w', 'stop'], this.dataDirectory); this.processRecord = undefined
    }
    await this.portLease?.release(); this.portLease = undefined
  }

  status(): ClusterStatus { return { state: this.processRecord !== undefined ? this.verifiedRunning ? 'running' : 'interrupted' : this.initialized ? 'initialized' : 'stopped', ...(this.endpoint === undefined ? {} : { endpoint: { ...this.endpoint } }), ...(this.processRecord === undefined ? {} : { process: { ...this.processRecord } }) } }
}

/**
 * `initdb` creates both files before the Team can apply its loopback/SCRAM
 * policy. Open with O_NOFOLLOW so a workspace symlink can never redirect a
 * policy write outside the managed data directory, then replace only a
 * regular single-link file.
 */
async function writeOwnedConfig(path: string, contents: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const details = await handle.stat()
    if (!details.isFile() || details.nlink !== 1) throw new Error(`PostgreSQL config file is not a private regular file: ${path}`)
    await handle.truncate(0)
    await handle.chmod(0o600)
    await handle.writeFile(contents)
    await handle.sync()
  } finally { await handle.close() }
}

function isLoopbackListener(listener: string): boolean {
  const value = listener.toLowerCase().replaceAll(' ', '')
  return value.startsWith('127.0.0.1:') || value.startsWith('localhost:') || value.startsWith('[::1]:') || value.startsWith('::1:') || value.startsWith('unix:')
}
