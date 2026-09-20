import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { FileCredentialStore, type LocalDatabaseEndpoint } from '../../packages/database/src/index.js'
import { ControlMediatedApprovalPort } from '../../packages/core/src/control-mediated-approval-port.js'
import { createNativePostgresql } from '../../packages/bundle/src/native-postgresql.js'
import { prepareNativeDatabaseMigration } from '../../packages/bundle/src/native-database-migration.js'
import { DatabaseMigrationReview } from '../../packages/bundle/src/database-migration-review.js'

it.skipIf(process.env.DSH_REAL_DRIZZLE !== '1')('verifies, reviews and applies native migration, preserving data and rejecting schema drift', async () => {
  const root = await realpath(process.cwd())
  const tooling = join(root, '.backend-team/runtime/migration-acceptance')
  const bin = join(root, '.backend-team/runtime/pg-gui/postgresql-18.6-arm64/bin')
  const native = await createNativePostgresql(root, await realpath(join(bin, '..')))
  const require = createRequire(join(tooling, 'package.json'))
  const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => { connect(): Promise<void>; query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>; end(): Promise<void> } }
  const owned = ['base', 'design'].map(suffix => `review_${randomBytes(8).toString('hex')}_${suffix}`)
  const clients: Array<InstanceType<typeof Client>> = []
  let admin: InstanceType<typeof Client> | undefined
  const approvals = new ControlMediatedApprovalPort(root)
  const ormRoot = join(root, '.backend-team/runtime/orm-review-acceptance')
  const ormSchemaPath = join(ormRoot, 'schema.ts')
  try {
    await mkdir(ormRoot, { recursive: true, mode: 0o700 })
    await writeFile(ormSchemaPath, 'export const legacy = true\n', { mode: 0o600 })
    const endpoint = await native.port.start() as LocalDatabaseEndpoint
    const secret = await new FileCredentialStore(join(root, '.backend-team/runtime/workflow-postgresql/credentials')).get(endpoint.credentialRef)
    if (secret === undefined) throw new Error('credential unavailable')
    const password = Buffer.from(secret).toString('utf8')
    const url = (name: string): string => { const value = new URL(`postgresql://127.0.0.1:${endpoint.port}/${name}`); value.username = endpoint.user; value.password = password; return value.href }
    admin = new Client({ connectionString: url('postgres') }); await admin.connect()
    for (const name of owned) await admin.query(`CREATE DATABASE ${name}`)
    for (const name of owned) { const client = new Client({ connectionString: url(name) }); clients.push(client); await client.connect(); await client.query("CREATE TABLE legacy(id integer PRIMARY KEY, note text); INSERT INTO legacy VALUES(1, 'retained');") }
    await clients[1]!.query('CREATE TABLE migration_demo(id serial, title text NOT NULL, CONSTRAINT "PK_migration_demo" PRIMARY KEY(id))')
    for (const client of clients) await client.end()
    clients.length = 0
    const session = Object.freeze({ id: 'test', sourceDatabase: owned[0]!, database: owned[1]!, beforeSchemaHash: '', beforeSchemaSql: '', endpoint })
    const prepare = () => prepareNativeDatabaseMigration(root, tooling, {
      session: () => session,
      url: async name => url(name),
      command: async (program, args) => {
        const result = await promisify(execFile)(join(bin, program), ['--host', '127.0.0.1', '--port', String(endpoint.port), '--username', endpoint.user, '--no-password', ...args], { env: { PATH: bin, PGPASSWORD: password, LC_ALL: 'C' }, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
        if (program === 'createdb' && args.at(-1)?.startsWith('migration_backup_')) owned.push(args.at(-1)!)
        return result.stdout
      },
    }, '.backend-team/runtime/orm-review-acceptance/schema.ts')
    const review = new DatabaseMigrationReview({ workspaceRoot: root, approvals, readRevision: async () => 1, prepare })
    await review.prepare(1)
    const pending = approvals.listPending()[0]!
    const preview = await review.preview(pending.artifactHash)
    expect(preview?.files[0]?.content).toContain('CREATE TABLE "migration_demo"')
    expect(preview?.files.some(file => file.path === '.backend-team/runtime/orm-review-acceptance/schema.ts' && file.content.includes('migration_demo'))).toBe(true)
    expect(await readFile(ormSchemaPath, 'utf8')).toBe('export const legacy = true\n')
    await approvals.decideAndWait(pending.id, { effect: 'approve', reason: 'test' }, pending.artifactHash, 1)
    const persistedOrmSchema = await readFile(ormSchemaPath, 'utf8')
    expect(persistedOrmSchema).toContain('migration_demo')
    expect(persistedOrmSchema).not.toContain('export const legacy = true')
    await mkdir(join(root, '.backend-team/artifacts'), { recursive: true, mode: 0o700 })
    await writeFile(join(root, '.backend-team/artifacts/native-migration-orm-t13-20260914.json'), JSON.stringify({
      schemaVersion: 1,
      date: '2026-09-14',
      node: process.version,
      runtime: 'PostgreSQL 18.6 native arm64',
      sourceDatabase: owned[0],
      designDatabase: owned[1],
      migrationSqlSha256: pending.artifactHash,
      ormSchema: {
        path: '.backend-team/runtime/orm-review-acceptance/schema.ts',
        beforeSha256: digest('export const legacy = true\n'),
        afterSha256: digest(persistedOrmSchema),
        previewedBeforeApproval: true,
        persistedAfterApproval: true,
      },
      database: { dataPreserved: true, migrationTablePresent: true, schemaDriftRejected: true },
      scope: 'temporary databases and workspace runtime file only',
    }, null, 2) + '\n', { mode: 0o600 })
    const applied = new Client({ connectionString: url(owned[0]!) }); clients.push(applied); await applied.connect()
    expect((await applied.query('SELECT * FROM legacy')).rows).toEqual([{ id: 1, note: 'retained' }])
    expect((await applied.query('SELECT * FROM migration_demo')).rows).toEqual([])
    await applied.end(); clients.length = 0
    const design = new Client({ connectionString: url(owned[1]!) }); await design.connect(); await design.query('ALTER TABLE migration_demo ADD COLUMN extra text'); await design.end()
    await review.prepare(1)
    const stale = approvals.listPending()[0]!
    const drift = new Client({ connectionString: url(owned[0]!) }); await drift.connect(); await drift.query('CREATE TABLE unrelated(id integer)'); await drift.end()
    await expect(approvals.decideAndWait(stale.id, { effect: 'approve', reason: 'test' }, stale.artifactHash, 1)).rejects.toThrow('结构已改变')
  } finally {
    approvals.dispose()
    for (const client of clients) await client.end()
    if (admin !== undefined) { for (const name of owned) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end() }
    await native.port.stop()
    await rm(ormRoot, { recursive: true, force: true })
  }
}, 180000)

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
