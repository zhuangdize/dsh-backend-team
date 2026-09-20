import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { GuiToMigration, diffSchemas } from '../src/index.js'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const sql = 'DROP TABLE old;'
const preview = { migrationId: 'drop-old', sql, sqlSha256: hash(sql), risk: 'destructive' as const }
const evidence = { migrationId: preview.migrationId, sqlSha256: preview.sqlSha256, emptyDatabase: 'verify_empty', schemaHash: 'target', integrationTests: 'passed' }

it('keeps complete source snapshots including SQL literals and deleted objects', () => {
  const before = "CREATE TABLE old(id int);\nCREATE FUNCTION f() RETURNS text AS $$ SELECT 'a; -- keep  spaces'; $$ LANGUAGE sql;"
  const after = "CREATE FUNCTION f() RETURNS text AS $$ SELECT 'b; -- keep  spaces'; $$ LANGUAGE sql;"
  expect(diffSchemas(before, after)).toMatchObject({ beforeSql: before, afterSql: after, beforeSha256: hash(before), afterSha256: hash(after), changed: true })
})

it('detects a deletion-only design change', () => {
  expect(diffSchemas('CREATE TABLE old(id int);', '')).toMatchObject({ changed: true, afterSql: '' })
})

it('returns a verified preview without executing the migration', async () => {
  const apply = vi.fn()
  const legacyOptions = { expert: { updateSchemaAndGenerateMigration: async () => preview }, verifier: { verify: async () => evidence }, applier: { apply } }
  const converter = new GuiToMigration(legacyOptions)
  expect(await converter.convert('CREATE TABLE old(id int);', '')).toEqual(preview)
  expect(apply).not.toHaveBeenCalled()
})

it('does not call the expert when snapshots are identical', async () => {
  const generate = vi.fn(async () => preview)
  const converter = new GuiToMigration({ expert: { updateSchemaAndGenerateMigration: generate }, verifier: { verify: async () => evidence } })
  await expect(converter.convert('same', 'same')).rejects.toThrow('no changes')
  expect(generate).not.toHaveBeenCalled()
})

it('retains the original design schema and hashes the actual SQL', async () => {
  const { SchemaDesignSession } = await import('../src/index.js')
  const before = "CREATE TABLE original(note text DEFAULT 'a; -- value');"
  const after = `${before}\nCREATE TABLE added(id integer);`
  let current = before
  const session = new SchemaDesignSession({ host: '127.0.0.1', socketDirectory: '/workspace/socket', database: 'postgres', user: 'backend_team', credentialRef: 'ref' }, {
    createDesignDatabase: async () => undefined,
    captureSchema: async () => current,
    dropDatabase: async () => undefined,
  })
  const opened = await session.open('project_dev')
  expect(opened).toMatchObject({ beforeSchemaSql: before, beforeSchemaHash: hash(before) })
  current = after
  expect(await session.capture(opened)).toBe(after)
  expect(opened.beforeSchemaSql).toBe(before)
})
