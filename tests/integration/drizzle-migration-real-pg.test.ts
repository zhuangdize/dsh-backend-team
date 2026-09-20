import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNativePostgresql } from '../../packages/bundle/src/native-postgresql.js'
import { DrizzleKitGenerator, FileCredentialStore, type LocalDatabaseEndpoint } from '../../packages/database/src/index.js'

it.skipIf(process.env.DSH_REAL_DRIZZLE !== '1')('generates a real Drizzle migration from a design database and applies only that preview', async () => {
  const root = await realpath(process.cwd())
  const tooling = join(root, '.backend-team/runtime/migration-acceptance')
  const require = createRequire(join(tooling, 'package.json'))
  const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => { connect(): Promise<void>; query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>; end(): Promise<void> } }
  const native = await createNativePostgresql(root, join(root, '.backend-team/runtime/pg-gui/postgresql-18.6-arm64'))
  const names = ['base', 'design', 'verify'].map(suffix => `mig_${randomBytes(8).toString('hex')}_${suffix}`)
  const clients: Array<InstanceType<typeof Client>> = []
  let admin: InstanceType<typeof Client> | undefined
  try {
    const endpoint = await native.port.start() as LocalDatabaseEndpoint
    const secret = await new FileCredentialStore(join(root, '.backend-team/runtime/workflow-postgresql/credentials')).get(endpoint.credentialRef)
    if (secret === undefined) throw new Error('local credential is unavailable')
    const url = (name: string): string => { const value = new URL(`postgresql://127.0.0.1:${endpoint.port}/${name}`); value.username = endpoint.user; value.password = Buffer.from(secret).toString('utf8'); return value.href }
    admin = new Client({ connectionString: url('postgres') }); await admin.connect()
    for (const name of names) await admin.query(`CREATE DATABASE ${name}`)
    for (const name of names) { const client = new Client({ connectionString: url(name) }); clients.push(client); await client.connect() }
    const [baseline, design, verify] = clients
    for (const client of clients) await client.query("CREATE TABLE legacy(id integer PRIMARY KEY, note text); INSERT INTO legacy VALUES(1, 'retained');")
    await design!.query('CREATE TABLE accounts(id integer PRIMARY KEY, email text UNIQUE NOT NULL); CREATE TABLE notes(id integer PRIMARY KEY, account_id integer REFERENCES accounts(id)); CREATE INDEX notes_account_idx ON notes(account_id);')
    const generated = await new DrizzleKitGenerator({ workspaceRoot: root, toolingRoot: tooling, nodeExecutable: process.execPath }).generate(url(names[0]!), url(names[1]!))
    expect(await readFile(generated.schemaPath, 'utf8')).toContain('pgTable')
    expect(await readFile(generated.migrationPath, 'utf8')).toBe(generated.preview.sql)
    const tables = "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    expect((await baseline!.query(tables)).rows).toEqual([{ tablename: 'legacy' }])
    await verify!.query(generated.preview.sql)
    expect((await verify!.query(tables)).rows).toEqual((await design!.query(tables)).rows)
    expect((await verify!.query('SELECT * FROM legacy')).rows).toEqual([{ id: 1, note: 'retained' }])
    const indexes = "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname"
    expect((await verify!.query(indexes)).rows).toEqual((await design!.query(indexes)).rows)
    const constraints = "SELECT conname, contype FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname"
    expect((await verify!.query(constraints)).rows).toEqual((await design!.query(constraints)).rows)
    expect((await baseline!.query(tables)).rows).toEqual([{ tablename: 'legacy' }])
  } finally {
    for (const client of clients) await client.end()
    if (admin !== undefined) { for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end() }
    await native.port.stop()
  }
}, 180000)
