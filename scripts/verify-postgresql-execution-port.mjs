import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DatabaseCatalog, FileCredentialStore, PortAllocator, PostgresqlArtifactVerifier, PostgresqlCluster, createDatabaseExecutionPort } from '../packages/database/dist/index.js'

const workspaceRoot = resolve(process.cwd())
const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined
if (process.platform !== 'darwin' || architecture === undefined) throw new Error('real PostgreSQL execution smoke requires native macOS arm64 or x64')

const archive = join(workspaceRoot, `.backend-team/artifacts/postgresql-18.6-darwin-${architecture}.tar.xz`)
await access(archive, constants.R_OK)
const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
const runtimeRoot = await mkdtemp(join(workspaceRoot, '.backend-team/pg-smoke-'))
const artifactParent = join(runtimeRoot, '18.6', `darwin-${architecture}`)
const executableRoot = join(artifactParent, `postgresql-18.6-${architecture}`)
let databasePort
let recoveredCluster
let stopped = false
let passed = false

try {
  trace(`extract ${archive}`)
  await mkdir(artifactParent, { recursive: true, mode: 0o700 })
  await runFile('/usr/bin/tar', ['-xJf', archive, '-C', artifactParent], workspaceRoot, { PATH: '/usr/bin:/bin', LC_ALL: 'C' })
  trace('verify extracted binaries')
  await verifyBinaryClosure(executableRoot)
  const inspection = await new PostgresqlArtifactVerifier({ run: async (file, args, cwd) => { const result = await runFile(file, args, cwd, { PATH: '/usr/bin:/bin', LC_ALL: 'C' }); return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr } } }).inspect(executableRoot)
  if (!inspection.valid) throw new Error(`PostgreSQL artifact dependency closure is invalid: ${inspection.errors.map((error) => error.message).join('; ')}`)

  const credentials = new FileCredentialStore(join(runtimeRoot, 'credentials'))
  const processAdapter = createPostgresqlProcessAdapter(executableRoot)
  const cluster = new PostgresqlCluster({
    workspaceRoot,
    runtimeRoot,
    executableRoot,
    credentials,
    ports: new PortAllocator(workspaceRoot, { isAvailable: async (port) => isPortAvailable(port) }),
    process: processAdapter,
  })
  trace('initialize cluster')
  const initialized = await cluster.initialize()
  trace('cluster initialized')
  const catalog = new DatabaseCatalog(workspaceRoot, () => cluster.status().endpoint ?? initialized, createCatalogAdapter(executableRoot, credentials))
  databasePort = createDatabaseExecutionPort({ cluster, catalog })

  trace('start cluster')
  const endpoint = await databasePort.start()
  trace(`cluster started on ${endpoint.port}`)
  if (endpoint.host !== '127.0.0.1' || endpoint.port === undefined) throw new Error('PostgreSQL execution port did not publish a TCP loopback endpoint')
  trace('prepare databases')
  const databases = await databasePort.prepare('p_real_smoke')
  trace(`databases ready ${databases.development},${databases.test}`)
  const password = await credentialText(credentials, endpoint.credentialRef)
  trace('query database identity')
  const query = await runPsql(executableRoot, endpoint, password, databases.development, 'SELECT current_database(), current_user')
  if (!query.stdout.includes(`${databases.development}|backend_team`)) throw new Error(`unexpected PostgreSQL identity: ${query.stdout.trim()}`)
  trace('execute SQL probe')
  const table = await runPsql(executableRoot, endpoint, password, databases.development, 'CREATE TABLE smoke_probe (id integer PRIMARY KEY, note text NOT NULL); INSERT INTO smoke_probe VALUES (1, \'real execution port\'); SELECT count(*) FROM smoke_probe')
  if (!table.stdout.split(/\s+/u).includes('1')) throw new Error(`real PostgreSQL SQL probe failed: ${table.stdout.trim()}`)
  const statusBeforeStop = databasePort.status()
  if (statusBeforeStop.cluster.state !== 'running' || statusBeforeStop.gui.state !== 'stopped') throw new Error('database execution status did not expose running cluster state')
  trace('stop cluster')
  const statusAfterStop = await databasePort.stop()
  stopped = true
  if (statusAfterStop.state !== 'initialized' || cluster.status().process !== undefined) throw new Error('database execution port did not stop the verified cluster')
  trace('recover with a fresh cluster and credential store')
  const recoveredCredentials = new FileCredentialStore(join(runtimeRoot, 'credentials'))
  const recovered = new PostgresqlCluster({ workspaceRoot, runtimeRoot, executableRoot, credentials: recoveredCredentials, ports: new PortAllocator(workspaceRoot, { isAvailable: async port => isPortAvailable(port) }), process: createPostgresqlProcessAdapter(executableRoot) })
  recoveredCluster = recovered
  try {
    const recoveredEndpoint = await recovered.start()
    const recoveredPassword = await credentialText(recoveredCredentials, recoveredEndpoint.credentialRef)
    const preserved = await runPsql(executableRoot, recoveredEndpoint, recoveredPassword, databases.development, 'SELECT note FROM smoke_probe WHERE id = 1')
    if (preserved.code !== 0 || preserved.stdout.trim() !== 'real execution port') throw new Error('database recovery did not preserve the existing row')
    if (recoveredEndpoint.credentialRef !== endpoint.credentialRef) throw new Error('database recovery changed credential identity')
  } finally { await recovered.stop() }
  passed = true
  console.log(JSON.stringify({ status: 'passed', architecture: `darwin-${architecture}`, artifactSha256: archiveSha256, endpoint: { host: endpoint.host, port: endpoint.port, database: endpoint.database, user: endpoint.user }, databases, sql: 'CREATE TABLE + INSERT + SELECT', clusterAfterStop: statusAfterStop.state, recovery: 'fresh cluster/store retained row and credential identity' }))
} finally {
  if (recoveredCluster !== undefined) await recoveredCluster.stop()
  if (databasePort !== undefined && !stopped) await databasePort.dispose().catch(() => undefined)
  if (!passed && process.env.DSH_KEEP_POSTGRES_SMOKE === '1') console.error(`postgresql smoke workspace preserved at ${runtimeRoot}`)
  else await rm(runtimeRoot, { recursive: true, force: true })
}

function createPostgresqlProcessAdapter(executableRoot) {
  const bin = (name) => join(executableRoot, 'bin', name)
  return {
    initdb: async (executable, args, cwd, env) => { await expectSuccess(await runFile(executable, args, cwd, env), 'initdb') },
    start: async (executable, args, cwd, env) => {
      const result = await runFile(executable, args, cwd, env, { capture: false })
      await expectSuccess(result, 'pg_ctl start')
      const dataDirectory = args[args.indexOf('-D') + 1]
      if (typeof dataDirectory !== 'string') throw new Error('pg_ctl start did not specify a data directory')
      const pidText = await readFile(join(dataDirectory, 'postmaster.pid'), 'utf8')
      const pid = Number.parseInt(pidText.split('\n', 1)[0] ?? '', 10)
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('PostgreSQL postmaster.pid is invalid')
      return { pid, executable, dataDirectory, startedAt: new Date().toISOString() }
    },
    stop: async (_record, executable, args, cwd) => { await expectSuccess(await runFile(executable, args, cwd, { PATH: join(executableRoot, 'bin'), LC_ALL: 'C' }, { capture: false }), 'pg_ctl stop') },
    isReady: async (endpoint) => {
      if (endpoint.port === undefined) return false
      const result = await runFile(bin('pg_isready'), ['--host', endpoint.host, '--port', String(endpoint.port), '--dbname', endpoint.database, '--username', endpoint.user], executableRoot, { PATH: join(executableRoot, 'bin'), LC_ALL: 'C' })
      return result.code === 0
    },
    inspectListeners: async (record) => {
      const result = await runFile('/usr/sbin/lsof', ['-nP', '-a', '-p', String(record.pid), '-iTCP', '-sTCP:LISTEN'], executableRoot, { PATH: '/usr/bin:/bin', LC_ALL: 'C' })
      if (result.code !== 0) throw new Error(`could not inspect PostgreSQL listeners: ${result.stderr.trim()}`)
      return result.stdout.split('\n').map((line) => line.match(/\b(?:TCP|TCP6)\s+([^\s]+)\s+\(LISTEN\)/u)?.[1]).filter((value) => typeof value === 'string')
    },
  }
}

function createCatalogAdapter(executableRoot, credentials) {
  return {
    databaseExists: async (name, endpoint) => {
      const password = await credentialText(credentials, endpoint.credentialRef)
      const result = await runPsql(executableRoot, endpoint, password, endpoint.database, `SELECT 1 FROM pg_database WHERE datname = '${name}'`)
      return result.stdout.trim() === '1'
    },
    createDatabase: async (name, endpoint) => {
      const password = await credentialText(credentials, endpoint.credentialRef)
      const args = [...connectionTargetArgs(endpoint), '--username', endpoint.user, '--maintenance-db', endpoint.database, '--no-password', name]
      await expectSuccess(await runFile(join(executableRoot, 'bin/createdb'), args, executableRoot, { PATH: join(executableRoot, 'bin'), PGPASSWORD: password, LC_ALL: 'C' }), `createdb ${name}`)
    },
  }
}

async function runPsql(executableRoot, endpoint, password, database, sql) {
  const args = [...connectionTargetArgs(endpoint), '--username', endpoint.user, '--dbname', database, '--no-psqlrc', '--no-password', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--command', sql]
  return expectSuccess(await runFile(join(executableRoot, 'bin/psql'), args, executableRoot, { PATH: join(executableRoot, 'bin'), PGPASSWORD: password, LC_ALL: 'C' }), 'PostgreSQL smoke SQL')
}

function connectionTargetArgs(endpoint) {
  return endpoint.port === undefined ? ['--host', endpoint.socketDirectory] : ['--host', endpoint.host, '--port', String(endpoint.port)]
}

async function credentialText(store, reference) {
  const secret = await store.get(reference)
  if (secret === undefined) throw new Error('PostgreSQL credential reference is missing')
  return Buffer.from(secret).toString('utf8')
}

async function verifyBinaryClosure(root) {
  const required = ['postgres', 'initdb', 'pg_ctl', 'pg_isready', 'psql', 'createdb', 'dropdb', 'pg_dump', 'pg_restore']
  for (const binary of required) {
    const path = join(root, 'bin', binary)
    await access(path, constants.X_OK)
    if (await realpath(path) !== path) throw new Error(`${binary} escapes the extracted PostgreSQL root`)
    const version = await runFile(path, ['--version'], root, { PATH: join(root, 'bin'), LC_ALL: 'C' })
    await expectSuccess(version, `${binary} --version`)
    if (!version.stdout.includes('18.6')) throw new Error(`${binary} is not PostgreSQL 18.6`)
  }
  const pgIsReady = await runFile(join(root, 'bin/pg_isready'), ['--version'], root, { PATH: join(root, 'bin'), LC_ALL: 'C' })
  await expectSuccess(pgIsReady, 'pg_isready relocation')
}

async function isPortAvailable(port) {
  const net = await import('node:net')
  return await new Promise((resolvePort) => {
    const server = net.createServer()
    server.once('error', () => resolvePort(false))
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolvePort(true)))
  })
}

async function runFile(file, args, cwd, env, options = {}) {
  trace(`run ${file} ${args.join(' ')}`)
  return await new Promise((resolveRun, rejectRun) => {
    const capture = options.capture !== false
    const child = spawn(file, [...args], { cwd, env: { ...env }, shell: false, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' })
    let stdout = ''; let stderr = ''
    child.stdout?.on('data', (data) => { stdout += data })
    child.stderr?.on('data', (data) => { stderr += data })
    child.once('error', rejectRun)
    child.once('close', (code, signal) => resolveRun({ code: code ?? -1, signal, stdout, stderr }))
  })
}

function trace(message) {
  if (process.env.DSH_DEBUG === '1') console.error(`[postgresql-smoke] ${message}`)
}

async function expectSuccess(result, label) {
  if (result.code !== 0) throw new Error(`${label} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
  return result
}
