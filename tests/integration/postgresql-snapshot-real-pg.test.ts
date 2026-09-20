import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { DatabaseSnapshot, FileCredentialStore, type LocalDatabaseEndpoint } from '../../packages/database/src/index.js'
import { createNativePostgresql } from '../../packages/bundle/src/native-postgresql.js'

const execFileAsync = promisify(execFile)

it.skipIf(process.env.DSH_REAL_SNAPSHOT !== '1')('creates, lists, restores and rejects tampered PostgreSQL snapshots', async () => {
  const root = await realpath(process.cwd())
  const executableRoot = await realpath(join(root, '.backend-team/runtime/pg-gui/postgresql-18.6-arm64'))
  const native = await createNativePostgresql(root, executableRoot)
  const databases: string[] = []
  let endpoint: LocalDatabaseEndpoint | undefined
  let snapshot: DatabaseSnapshot | undefined
  try {
    endpoint = await native.port.start()
    if (endpoint.port === undefined) throw new Error('PostgreSQL did not publish a TCP endpoint')
    const credentials = new FileCredentialStore(join(root, '.backend-team/runtime/workflow-postgresql/credentials'))
    const secret = await credentials.get(endpoint.credentialRef)
    if (secret === undefined) throw new Error('PostgreSQL credential unavailable')
    const password = Buffer.from(secret).toString('utf8')
    const bin = (name: string): string => join(executableRoot, 'bin', name)
    const targetArgs = (): string[] => ['--host', endpoint!.host, '--port', String(endpoint!.port), '--username', endpoint!.user, '--no-password']
    const run = async (executable: string, args: readonly string[]) => await execFileAsync(executable, [...args], { cwd: root, env: { PATH: join(executableRoot, 'bin'), PGPASSWORD: password, LC_ALL: 'C' }, maxBuffer: 2 * 1024 * 1024 })
    const query = async (database: string, sql: string): Promise<string> => (await run(bin('psql'), [...targetArgs(), '--dbname', database, '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--command', sql])).stdout.trim()
    const project = `snapshot_t15_${randomBytes(4).toString('hex')}`
    const sourceDatabase = `${project}_dev`
    const testDatabase = `${project}_test`
    databases.push(sourceDatabase, testDatabase)
    await run(bin('createdb'), [...targetArgs(), '--maintenance-db', endpoint.database, sourceDatabase])
    await run(bin('createdb'), [...targetArgs(), '--maintenance-db', endpoint.database, testDatabase])
    await query(sourceDatabase, "CREATE TABLE snapshot_probe(id integer PRIMARY KEY, note text NOT NULL); INSERT INTO snapshot_probe VALUES (1, 'retained');")
    const targetDatabase = `snapshot_restore_${randomBytes(5).toString('hex')}`
    databases.push(targetDatabase)
    await run(bin('createdb'), [...targetArgs(), '--maintenance-db', endpoint.database, targetDatabase])
    snapshot = new DatabaseSnapshot({
      workspaceRoot: root,
      endpoint,
      pgDumpPath: bin('pg_dump'),
      serverVersion: '18.6',
      runner: { run: async (executable, args) => { const result = await run(executable.endsWith('/pg_dump') || executable === 'pg_dump' ? bin('pg_dump') : bin('pg_restore'), args); return { exitCode: 0, stdout: result.stdout, stderr: result.stderr } } },
      assertEmptyDatabase: async (database, target) => {
        const count = await query(database, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')")
        if (count !== '0') throw new Error(`restore target is not empty: ${database}`)
        if (target.host !== '127.0.0.1') throw new Error('restore target is not loopback')
      },
    })
    const manifest = await snapshot.create(sourceDatabase, 'T15 real snapshot acceptance')
    expect(manifest.sha256).toBe(createHash('sha256').update(await readFile(manifest.dumpFile)).digest('hex'))
    await expect(snapshot.list()).resolves.toContainEqual(manifest)
    await snapshot.restore(manifest, endpoint, targetDatabase)
    await expect(query(targetDatabase, 'SELECT note FROM snapshot_probe WHERE id = 1')).resolves.toBe('retained')

    await writeFile(manifest.dumpFile, 'tampered snapshot', { mode: 0o600 })
    await expect(snapshot.restore(manifest, endpoint, `snapshot_restore_${randomBytes(5).toString('hex')}`)).rejects.toThrow('snapshot hash mismatch')
    await writeFile(join(root, '.backend-team/artifacts/postgresql-snapshot-t15-20260914.json'), `${JSON.stringify({ status: 'passed', sourceDatabase, restoredDatabase: targetDatabase, snapshotId: manifest.id, snapshotSha256: manifest.sha256, restoredRow: 'retained', tamperRejected: true }, null, 2)}\n`, { mode: 0o600 })
  } finally {
    if (endpoint !== undefined) {
      const credentials = new FileCredentialStore(join(root, '.backend-team/runtime/workflow-postgresql/credentials'))
      const secret = await credentials.get(endpoint.credentialRef)
      if (secret !== undefined) {
        const password = Buffer.from(secret).toString('utf8')
        const targetArgs = ['--host', endpoint.host, '--port', String(endpoint.port), '--username', endpoint.user, '--no-password', '--maintenance-db', endpoint.database]
        for (const database of databases) await execFileAsync(join(executableRoot, 'bin/dropdb'), [...targetArgs, '--if-exists', '--force', database], { cwd: root, env: { PATH: join(executableRoot, 'bin'), PGPASSWORD: password, LC_ALL: 'C' } }).catch(() => undefined)
      }
    }
    await native.port.stop().catch(() => undefined)
    await rm(join(root, '.backend-team/runtime/postgresql/snapshots'), { recursive: true, force: true }).catch(() => undefined)
  }
}, 180000)
