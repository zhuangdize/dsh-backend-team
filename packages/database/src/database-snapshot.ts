import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { assertLocalEndpoint, type LocalDatabaseEndpoint } from './postgresql-config.js'

export interface DatabaseCommandRunner { run(executable: string, args: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> }
export interface SnapshotManifest { readonly id: string; readonly database: string; readonly kind: 'data' | 'schema'; readonly createdAt: string; readonly reason: string; readonly serverVersion: string; readonly sha256: string; readonly dumpFile: string }
export interface DatabaseSnapshotOptions { readonly workspaceRoot: string; readonly endpoint: LocalDatabaseEndpoint; readonly runner: DatabaseCommandRunner; readonly pgDumpPath?: string; readonly serverVersion?: string; /** Optional host-owned check that the restore target has no user tables/data. */ readonly assertEmptyDatabase?: (targetDatabase: string, endpoint: LocalDatabaseEndpoint) => Promise<void> }

export class DatabaseSnapshot {
  private readonly directory: string
  constructor(private readonly options: DatabaseSnapshotOptions) { this.directory = resolve(options.workspaceRoot, '.backend-team/runtime/postgresql/snapshots') }
  async create(database: string, reason: string, kind: 'data' | 'schema' = 'data'): Promise<SnapshotManifest> {
    assertLocalEndpoint(this.options.endpoint)
    if (!/^[a-z0-9_]{1,50}$/.test(database)) throw new Error('snapshot database name is unsafe')
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 1000) throw new Error('snapshot reason is invalid')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const id = `${new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${database}-${randomUUID().slice(0, 8)}`
    const dumpFile = join(this.directory, `${id}.dump`)
    const args = ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpFile, '--dbname', database, '--host', this.options.endpoint.host, '--username', this.options.endpoint.user, ...(this.options.endpoint.port === undefined ? [] : ['--port', String(this.options.endpoint.port)])]
    if (kind === 'schema') args.push('--schema-only')
    const result = await this.options.runner.run(this.options.pgDumpPath ?? 'pg_dump', args, this.options.workspaceRoot)
    if (result.exitCode !== 0) throw new Error(`pg_dump failed: ${result.stderr || result.stdout}`)
    await chmod(dumpFile, 0o600)
    const content = await readFile(dumpFile); const sha256 = createHash('sha256').update(content).digest('hex')
    const manifest: SnapshotManifest = { id, database, kind, createdAt: new Date().toISOString(), reason, serverVersion: this.options.serverVersion ?? '18.6', sha256, dumpFile }
    await writeFile(`${dumpFile}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return manifest
  }

  /** Returns only complete, hash-verifiable snapshots owned by this workspace. */
  async list(): Promise<readonly SnapshotManifest[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const entries = await readdir(this.directory, { withFileTypes: true })
    const manifests: SnapshotManifest[] = []
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue
      if (!entry.isFile()) throw new Error(`snapshot manifest is not a regular file: ${entry.name}`)
      manifests.push(await this.readManifest(join(this.directory, entry.name)))
    }
    return Object.freeze(manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)))
  }

  async restore(snapshot: SnapshotManifest, target: LocalDatabaseEndpoint, targetDatabase: string): Promise<void> {
    assertLocalEndpoint(target)
    if (target.host !== '127.0.0.1' || target.socketDirectory !== this.options.endpoint.socketDirectory) throw new Error('local workspace database required')
    if (!/^[a-z0-9_]{1,50}$/.test(targetDatabase)) throw new Error('restore database name is unsafe')
    if (targetDatabase === snapshot.database) throw new Error('restore requires a new empty database')
    const manifestPath = join(this.directory, `${basename(snapshot.dumpFile)}.json`)
    const canonical = await this.readManifest(manifestPath)
    if (!sameManifest(canonical, snapshot)) throw new Error('snapshot manifest is not the canonical workspace record')
    const content = await readFile(canonical.dumpFile); const hash = createHash('sha256').update(content).digest('hex')
    if (hash !== canonical.sha256) throw new Error('snapshot hash mismatch')
    await this.options.assertEmptyDatabase?.(targetDatabase, target)
    const result = await this.options.runner.run('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', targetDatabase, '--host', target.host, '--username', target.user, ...(target.port === undefined ? [] : ['--port', String(target.port)]), canonical.dumpFile], this.options.workspaceRoot)
    if (result.exitCode !== 0) throw new Error(`pg_restore failed: ${result.stderr || result.stdout}`)
  }
  async readManifest(file: string): Promise<SnapshotManifest> {
    const canonicalFile = resolve(file)
    if (dirname(canonicalFile) !== resolve(this.directory) || !canonicalFile.endsWith('.json')) throw new Error('snapshot manifest must stay inside the workspace snapshot directory')
    const details = await lstat(canonicalFile)
    if (details.isSymbolicLink() || !details.isFile() || (details.mode & 0o077) !== 0) throw new Error('snapshot manifest is unsafe')
    const raw: unknown = JSON.parse(await readFile(canonicalFile, 'utf8'))
    const value = parseManifest(raw)
    const expectedDump = resolve(this.directory, basename(canonicalFile).replace(/\.json$/u, ''))
    if (resolve(value.dumpFile) !== expectedDump) throw new Error('snapshot manifest path mismatch')
    const dump = await lstat(value.dumpFile)
    if (dump.isSymbolicLink() || !dump.isFile() || (dump.mode & 0o077) !== 0) throw new Error('snapshot dump is unsafe')
    return Object.freeze(value)
  }
}

function parseManifest(value: unknown): SnapshotManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('snapshot manifest is malformed')
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !/^[0-9TZ-]+-[a-z0-9_]{1,50}-[a-f0-9]{8}$/u.test(record.id) || typeof record.database !== 'string' || !/^[a-z0-9_]{1,50}$/u.test(record.database) || (record.kind !== 'data' && record.kind !== 'schema') || typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt)) || typeof record.reason !== 'string' || record.reason.length === 0 || record.reason.length > 1000 || typeof record.serverVersion !== 'string' || record.serverVersion.length === 0 || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256) || typeof record.dumpFile !== 'string' || record.dumpFile.length === 0) throw new Error('snapshot manifest is malformed')
  return { id: record.id, database: record.database, kind: record.kind, createdAt: record.createdAt, reason: record.reason, serverVersion: record.serverVersion, sha256: record.sha256, dumpFile: record.dumpFile }
}

function sameManifest(left: SnapshotManifest, right: SnapshotManifest): boolean {
  return left.id === right.id && left.database === right.database && left.kind === right.kind && left.createdAt === right.createdAt && left.reason === right.reason && left.serverVersion === right.serverVersion && left.sha256 === right.sha256 && resolve(left.dumpFile) === resolve(right.dumpFile)
}
