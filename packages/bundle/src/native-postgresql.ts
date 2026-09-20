import { execFile } from 'node:child_process'
import { chmod, lstat, open, readFile, realpath, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { DatabaseCatalog, DatabaseSnapshot, FileCredentialStore, PortAllocator, PostgresqlArtifactVerifier, PostgresqlCluster, assertDatabaseId, createDatabaseExecutionPort } from '@dsh-backend-team/database'
import type { LocalDatabaseEndpoint, PostgresqlProcessAdapter, SchemaDesignSessionRecord } from '@dsh-backend-team/database'
import type { ProductionControlSurfaceOptions, ProductionDatabaseExecutionPort, ProductionDatabaseSnapshot } from './production.js'
import { createNativeDbGate, type NativeDbGateConfig } from './native-dbgate.js'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { prepareNativeDatabaseMigration } from './native-database-migration.js'
import type { PreparedDatabaseMigration } from './database-migration-review.js'

type DatabaseView = NonNullable<ProductionControlSurfaceOptions['database']>

/** Host-selected, verified workspace runtime; browser input never supplies executable paths. */
export async function createNativePostgresql(workspaceRoot: string, executableRoot: string, gui?: NativeDbGateConfig, preloadPath = fileURLToPath(new URL('./dbgate-loopback-preload.cjs', import.meta.url)), migrationToolingRoot?: string, ormSchemaPath?: string): Promise<{ port: ProductionDatabaseExecutionPort; feed: NonNullable<ProductionControlSurfaceOptions['databaseFeed']>; prepareMigration(): Promise<PreparedDatabaseMigration>; restoreMigration(record: import('./migration-review-store.js').PersistedMigrationReview): Promise<PreparedDatabaseMigration> }> {
  if (process.platform !== 'darwin') throw new Error('native PostgreSQL controls require macOS')
  const root = await realpath(workspaceRoot)
  const executable = await realpath(executableRoot)
  if (executable !== executableRoot || !executable.startsWith(join(root, '.backend-team/runtime') + '/')) throw new Error('PostgreSQL executable root must be a canonical workspace runtime')
  const inspection = await new PostgresqlArtifactVerifier({ run: async (file, args, cwd) => run(file, args, cwd, { PATH: '/usr/bin:/bin' }) }).inspect(executable)
  if (!inspection.valid) throw new Error('PostgreSQL runtime verification failed')
  const runtime = join(root, '.backend-team/runtime/workflow-postgresql')
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  if (await realpath(runtime) !== runtime) throw new Error('PostgreSQL data root must be canonical')
  const credentials = new FileCredentialStore(join(runtime, 'credentials'))
  const bin = (name: string): string => join(executable, 'bin', name)
  const environment = { PATH: join(executable, 'bin'), LC_ALL: 'C' }
  const processAdapter: PostgresqlProcessAdapter = {
    initdb: async (file, args, cwd, env) => { success(await run(file, args, cwd, env), 'initialize PostgreSQL') },
    start: async (file, args, cwd, env) => {
      success(await run(file, [...args, '-l', join(runtime, 'logs/server.log')], cwd, env), 'start PostgreSQL')
      const pid = Number((await readFile(join(cwd, 'postmaster.pid'), 'utf8')).split('\n')[0])
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('PostgreSQL process record is invalid')
      return { pid, executable: file, dataDirectory: cwd, startedAt: new Date().toISOString() }
    },
    stop: async (_record, file, args, cwd) => { success(await run(file, args, cwd, environment), 'stop PostgreSQL') },
    isReady: async endpoint => (await run(bin('pg_isready'), [...connection(endpoint), '--username', endpoint.user, '--dbname', endpoint.database], executable, environment)).exitCode === 0,
    inspectListeners: async record => {
      const output = success(await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(record.pid), '-iTCP', '-sTCP:LISTEN'], executable, { PATH: '/usr/bin:/bin' }), 'inspect PostgreSQL listeners')
      const listeners = output.stdout.split('\n').flatMap(line => line.match(/\bTCP\s+([^\s]+)\s+\(LISTEN\)/u)?.[1] ?? [])
      if (listeners.length === 0) throw new Error('PostgreSQL listener could not be verified')
      return listeners
    },
  }
  const cluster = new PostgresqlCluster({ workspaceRoot: root, runtimeRoot: runtime, executableRoot: executable, credentials, ports: new PortAllocator(root, { isAvailable }), process: processAdapter })
  const endpoint = (): LocalDatabaseEndpoint => { const value = cluster.status().endpoint; if (value === undefined) throw new Error('PostgreSQL is not initialized'); return value }
  const password = async (value: LocalDatabaseEndpoint): Promise<string> => { const secret = await credentials.get(value.credentialRef); if (secret === undefined) throw new Error('PostgreSQL credential is unavailable'); return Buffer.from(secret).toString('utf8') }
  const catalog = new DatabaseCatalog(root, endpoint, {
    databaseExists: async (name, value) => {
      assertDatabaseId(name)
      const result = success(await run(bin('psql'), [...connection(value), '--username', value.user, '--dbname', value.database, '--no-psqlrc', '--no-password', '--tuples-only', '--no-align', '--command', `SELECT 1 FROM pg_database WHERE datname = '${name}'`], executable, { ...environment, PGPASSWORD: await password(value) }), 'inspect project database')
      return result.stdout.trim() === '1'
    },
    createDatabase: async (name, value) => {
      assertDatabaseId(name)
      success(await run(bin('createdb'), [...connection(value), '--username', value.user, '--maintenance-db', value.database, '--no-password', name], executable, { ...environment, PGPASSWORD: await password(value) }), 'create project database')
    },
  })
  // The bundled preload is installed with the package, while the process
  // adapter deliberately only executes files owned by the workspace. Materialize
  // the verified script inside the workspace runtime before handing it to the
  // DbGate launcher; this keeps production installs compatible with the same
  // loopback and path-boundary checks used by source tests.
  const guiPreload = gui === undefined ? undefined : await materializeWorkspacePreload(root, preloadPath)
  const guiOptions = gui === undefined ? undefined : await createNativeDbGate(root, gui, guiPreload!, credentials, endpoint, async (program, args, value) => success(await run(bin(program), [...connection(value), '--username', value.user, '--no-password', ...args], executable, { ...environment, PGPASSWORD: await password(value) }), 'operate design database').stdout)
  const designSessionPath = join(runtime, 'design-session.json')
  const persistedDesignSession = guiOptions === undefined ? undefined : {
    open: async (source: string): Promise<SchemaDesignSessionRecord> => {
      const session = await guiOptions.designSession.open(source)
      await writePersistedDesignSession(designSessionPath, session)
      return session
    },
    discard: async (session: SchemaDesignSessionRecord): Promise<void> => {
      await guiOptions.designSession.discard(session)
      await rm(designSessionPath, { force: true })
    },
  }
  const database = createDatabaseExecutionPort({ cluster, catalog, ...(guiOptions === undefined ? {} : { ...guiOptions, ...(persistedDesignSession === undefined ? {} : { designSession: persistedDesignSession }) }) })
  const snapshots = (): DatabaseSnapshot => {
    const current = endpoint()
    return new DatabaseSnapshot({
      workspaceRoot: root,
      endpoint: current,
      runner: {
        run: async (program, args, cwd) => {
          const executablePath = program === 'pg_dump' || program === 'pg_restore' || program === 'psql' ? bin(program) : program
          const result = await run(executablePath, args, cwd, { ...environment, PGPASSWORD: await password(current) })
          return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
        },
      },
      pgDumpPath: bin('pg_dump'),
      serverVersion: '18.6',
      assertEmptyDatabase: async (targetDatabase, target) => {
        const result = success(await run(bin('psql'), [...connection(target), '--username', target.user, '--dbname', targetDatabase, '--no-password', '--tuples-only', '--no-align', '--command', "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'p', 'm')"], executable, { ...environment, PGPASSWORD: await password(target) }), 'inspect restore target')
        if (Number(result.stdout.trim()) !== 0) throw new Error('restore requires a new empty database')
      },
    })
  }
  const snapshotSummary = (manifest: import('@dsh-backend-team/database').SnapshotManifest): ProductionDatabaseSnapshot => {
    const { dumpFile: _dumpFile, ...summary } = manifest
    void _dumpFile
    return summary
  }
  const listSnapshots = async (): Promise<readonly ProductionDatabaseSnapshot[]> => (await snapshots().list()).map(snapshotSummary)
  const createSnapshot = async (reason: string, kind: 'data' | 'schema' = 'data'): Promise<ProductionDatabaseSnapshot> => {
    const session = database.designSession()
    const current = endpoint()
    const databaseName = session?.sourceDatabase ?? current.database
    return snapshotSummary(await snapshots().create(databaseName, reason, kind))
  }
  const restoreSnapshot = async (snapshotId: string, targetDatabase: string): Promise<{ readonly snapshotId: string; readonly targetDatabase: string; readonly restoredAt: string }> => {
    if (!/^[0-9TZ-]+-[a-z0-9_]{1,50}-[a-f0-9]{8}$/u.test(snapshotId)) throw new Error('snapshot id is invalid')
    const manifest = (await snapshots().list()).find(snapshot => snapshot.id === snapshotId)
    if (manifest === undefined) throw new Error('snapshot does not exist')
    await snapshots().restore(manifest, endpoint(), targetDatabase)
    return { snapshotId, targetDatabase, restoredAt: new Date().toISOString() }
  }
  const listeners = new Set<() => void>(); let starting = false; let failed = false; let migrationMessage: string | undefined
  const publish = (): void => { for (const listener of listeners) listener() }
  let operation: Promise<void> = Promise.resolve()
  const execute = <T>(action: () => Promise<T>, isStart: boolean, markFailure = true): Promise<T> => {
    const result = operation.then(async () => {
      starting = isStart; failed = false; publish()
      try { return await action() } catch (error: unknown) { if (markFailure) failed = true; throw error } finally { starting = false; publish() }
    })
    operation = result.then(() => undefined, () => undefined)
    return result
  }
  const migrationAction = async <T>(action: () => Promise<T>, successMessage: string): Promise<T> => {
    migrationMessage = '正在验证数据库迁移…'; publish()
    try { const value = await action(); migrationMessage = successMessage; return value }
    catch (error: unknown) { migrationMessage = error instanceof Error ? error.message.slice(0, 1000) : '数据库迁移失败，请重新生成'; throw error }
    finally { publish() }
  }
  return {
    prepareMigration: () => execute(() => migrationAction(async () => {
      if (migrationToolingRoot === undefined) throw new Error('数据库迁移工具尚未配置')
      const prepared = await prepareNativeDatabaseMigration(root, migrationToolingRoot, {
        session: () => database.designSession(),
        url: async name => { const value = endpoint(); const url = new URL(`postgresql://127.0.0.1:${value.port}/${name}`); url.username = value.user; url.password = await password(value); return url.href },
        command: async (program, args) => { const value = endpoint(); return success(await run(bin(program), [...connection(value), '--username', value.user, '--no-password', ...args], executable, { ...environment, PGPASSWORD: await password(value) }), 'operate migration database').stdout },
      }, ormSchemaPath)
      return { preview: prepared.preview, ...(prepared.target === undefined ? {} : { target: prepared.target }), apply: () => execute(() => migrationAction(() => prepared.apply(), '数据库迁移已应用，备份与迁移文件已保存。'), false, false) }
    }, '迁移验证通过，请查看 SQL 后批准或拒绝。'), false, false),
    restoreMigration: record => execute(async () => {
      if (migrationToolingRoot === undefined) throw new Error('数据库迁移工具尚未配置')
      const session = await readPersistedDesignSession(designSessionPath)
      const active = endpoint()
      // The TCP port is allocated per process and may change after a restart. The
      // workspace-owned socket directory and credential identity bind the design
      // session to the same cluster; requiring the old ephemeral port made every
      // valid pending migration unrecoverable after a normal host restart.
      if (session.endpoint.host !== active.host || session.endpoint.socketDirectory !== active.socketDirectory || session.endpoint.user !== active.user || session.endpoint.credentialRef !== active.credentialRef) throw new Error('已保存的数据库设计会话不属于当前 PostgreSQL 集群')
      if (record.target?.sourceDatabase !== undefined && record.target.sourceDatabase !== session.sourceDatabase) throw new Error('迁移审批目标数据库与已保存设计会话不一致')
      if (record.target?.designDatabase !== undefined && record.target.designDatabase !== session.database) throw new Error('迁移审批设计数据库与已保存设计会话不一致')
      const prepared = await prepareNativeDatabaseMigration(root, migrationToolingRoot, {
        session: () => session,
        url: async name => { const value = endpoint(); const url = new URL(`postgresql://127.0.0.1:${value.port}/${name}`); url.username = value.user; url.password = await password(value); return url.href },
        command: async (program, args) => { const value = endpoint(); return success(await run(bin(program), [...connection(value), '--username', value.user, '--no-password', ...args], executable, { ...environment, PGPASSWORD: await password(value) }), 'operate migration database').stdout },
      }, ormSchemaPath)
      return { preview: prepared.preview, ...(prepared.target === undefined ? {} : { target: prepared.target }), apply: () => execute(() => migrationAction(() => prepared.apply(), '数据库迁移已应用，备份与迁移文件已保存。'), false, false) }
    }, false, false),
    port: { verifiedProvenance: true, start: () => execute(async () => { const value = await database.start(); await database.prepare(); return value }, true), stop: () => execute(() => database.stop(), false), openGui: sessionId => execute(() => database.openGui(sessionId), true), listSnapshots, createSnapshot, restoreSnapshot, ...(gui === undefined ? {} : { consumeGuiLogin: (sessionId: string) => database.consumeGuiLogin(sessionId) }) },
    feed: {
      snapshot: (): DatabaseView => ({ runtime: starting ? 'starting' : failed || cluster.status().state === 'interrupted' ? 'failed' : cluster.status().state === 'running' ? 'ready' : 'stopped', engine: 'PostgreSQL 18.6', guiAvailable: gui !== undefined && !starting, controlsAvailable: true, ...(migrationMessage === undefined ? {} : { migrationMessage }), migrationAvailable: migrationToolingRoot !== undefined && gui !== undefined && !starting }),
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
  }
}

async function materializeWorkspacePreload(workspaceRoot: string, sourcePath: string): Promise<string> {
  const source = await realpath(sourcePath)
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size > 64 * 1024) throw new Error('DbGate preload asset is invalid')
  if (source === workspaceRoot || source.startsWith(`${workspaceRoot}/`)) return source
  const runtime = join(workspaceRoot, '.backend-team/runtime')
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  if ((await lstat(runtime)).isSymbolicLink() || await realpath(runtime) !== runtime) throw new Error('DbGate preload runtime is unsafe')
  const target = join(runtime, 'dbgate-loopback-preload.cjs')
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temporary, await readFile(source), { flag: 'wx', mode: 0o600 })
  try {
    await chmod(temporary, 0o600)
    const file = await open(temporary, 'r')
    try { await file.sync() } finally { await file.close() }
    await rename(temporary, target)
    await chmod(target, 0o600)
    return await realpath(target)
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

async function writePersistedDesignSession(path: string, session: SchemaDesignSessionRecord): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(session)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    await chmod(temporary, 0o600)
    const file = await open(temporary, 'r')
    try { await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    await chmod(path, 0o600)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

async function readPersistedDesignSession(path: string): Promise<SchemaDesignSessionRecord> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('已保存的数据库设计会话无效，请重新打开数据库工具')
  const record = value as Record<string, unknown>
  const endpoint = record.endpoint
  if (typeof record.id !== 'string' || !/^[a-f0-9]{16}$/u.test(record.id) || typeof record.sourceDatabase !== 'string' || !/^[a-z0-9_]{1,50}$/u.test(record.sourceDatabase) || typeof record.database !== 'string' || !/^design_[a-f0-9]{16}$/u.test(record.database) || typeof record.beforeSchemaHash !== 'string' || !/^[a-f0-9]{64}$/u.test(record.beforeSchemaHash) || typeof record.beforeSchemaSql !== 'string' || typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) throw new Error('已保存的数据库设计会话无效，请重新打开数据库工具')
  const endpointRecord = endpoint as Record<string, unknown>
  if (endpointRecord.host !== '127.0.0.1' || typeof endpointRecord.socketDirectory !== 'string' || typeof endpointRecord.database !== 'string' || typeof endpointRecord.user !== 'string' || typeof endpointRecord.credentialRef !== 'string' || (endpointRecord.port !== undefined && (typeof endpointRecord.port !== 'number' || !Number.isInteger(endpointRecord.port) || endpointRecord.port < 1024 || endpointRecord.port > 65535))) throw new Error('已保存的数据库设计会话端点无效，请重新打开数据库工具')
  return Object.freeze({ id: record.id, sourceDatabase: record.sourceDatabase, database: record.database, beforeSchemaHash: record.beforeSchemaHash, beforeSchemaSql: record.beforeSchemaSql, endpoint: Object.freeze({ host: '127.0.0.1', socketDirectory: endpointRecord.socketDirectory, ...(endpointRecord.port === undefined ? {} : { port: endpointRecord.port as number }), database: endpointRecord.database, user: endpointRecord.user, credentialRef: endpointRecord.credentialRef }) })
}
function connection(endpoint: LocalDatabaseEndpoint): string[] { return endpoint.port === undefined ? ['--host', endpoint.socketDirectory] : ['--host', endpoint.host, '--port', String(endpoint.port)] }
function isAvailable(port: number): Promise<boolean> { return new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))) }) }
interface CommandResult { exitCode: number; stdout: string; stderr: string }
function success(result: CommandResult, label: string): CommandResult { if (result.exitCode !== 0) throw new Error(`${label} failed (exit ${result.exitCode})`); return result }
function run(file: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<CommandResult> {
  return new Promise((resolve, reject) => execFile(file, [...args], { cwd, env: { ...env }, shell: false, timeout: 30000, maxBuffer: 1048576, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error !== null && (typeof error.code !== 'number' || error.killed)) { reject(new Error('PostgreSQL command failed or timed out')); return }
    resolve({ exitCode: error === null ? 0 : Number(error.code), stdout, stderr })
  }))
}
