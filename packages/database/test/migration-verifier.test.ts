import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MigrationVerifier, type MigrationVerificationRunner } from '../src/index.js'

const preview = { migrationId: 'm1', sql: 'CREATE TABLE x(id int)', sqlSha256: createHash('sha256').update('CREATE TABLE x(id int)').digest('hex'), risk: 'standard' as const }

describe('MigrationVerifier', () => {
  it('rejects a preview whose declared SQL hash is not its SQL', async () => {
    const runner = fixtureRunner()
    await expect(new MigrationVerifier(runner).verify({ ...preview, sqlSha256: 'a'.repeat(64) }, { expectedSchemaHash: 'expected' })).rejects.toThrow(/SQL hash/i)
    expect(runner.calls).toEqual([])
  })

  it('fails closed when upgrade baseline capabilities are absent', async () => {
    const runner = fixtureRunner()
    await expect(new MigrationVerifier(runner).verify(preview, { expectedSchemaHash: 'expected', priorSchemaHash: 'prior' })).rejects.toThrow(/upgrade.*capabilit/i)
    expect(runner.calls).toEqual([])
  })

  it('requires a snapshot capability when snapshot is required', async () => {
    const runner = fixtureRunner()
    await expect(new MigrationVerifier(runner).verify(preview, { expectedSchemaHash: 'expected', snapshotRequired: true })).rejects.toThrow(/snapshot/i)
    expect(runner.calls).toEqual([])
  })

  it('cannot waive the snapshot gate for a high-risk migration', async () => {
    const runner = fixtureRunner()
    await expect(new MigrationVerifier(runner).verify({ ...preview, risk: 'high' }, { expectedSchemaHash: 'expected', approvalToken: 'approved', snapshotRequired: false })).rejects.toThrow(/snapshot/i)
    expect(runner.calls).toEqual([])
  })

  it('rejects an empty high-risk approval token', async () => {
    const runner = fixtureRunner({ snapshot: async () => 'snapshot-ref-1' })
    await expect(new MigrationVerifier(runner).verify({ ...preview, risk: 'high' }, { expectedSchemaHash: 'expected', approvalToken: '   ' })).rejects.toThrow(/approval token/i)
    expect(runner.calls).toEqual([])
  })

  it('records the snapshot reference when the required snapshot succeeds', async () => {
    const runner = fixtureRunner({ snapshot: async (database, reason) => { runner.calls.push(`snapshot:${database}:${reason}`); return 'snapshot-ref-1' } })
    const evidence = await new MigrationVerifier(runner).verify(preview, { expectedSchemaHash: 'expected', snapshotRequired: true })
    expect(evidence.snapshotRef).toBe('snapshot-ref-1')
    expect(runner.calls.some((call) => /^snapshot:verify_m1_empty_[a-f0-9]{12}:migration:m1$/u.test(call))).toBe(true)
  })

  it('initializes an upgrade baseline, applies only the preview, and drops both databases', async () => {
    let baselineInitialized = false; let migrationApplied = false; let appliedSql: string | undefined
    const runner = fixtureRunner({
      initializeBaseline: async (database, hash) => { baselineInitialized = true; runner.calls.push(`baseline:${database}:${hash}`) },
      applyMigration: async (database, migration) => { try { ;(migration as { sql: string }).sql = 'DROP TABLE x' } catch {}; appliedSql = migration.sql; migrationApplied = true; runner.calls.push(`migration:${database}`) },
      rollbackOrRepair: async (database) => { runner.calls.push(`recovery:${database}`); return { mode: 'rollback' as const, passed: true, output: 'recovered' } },
      runIntegrationTests: async (database) => { runner.calls.push(`tests:${database}`); return { passed: true, output: 'passed' } },
      schemaHash: async (database) => { runner.calls.push(`hash:${database}`); return database.endsWith('_upgrade') && baselineInitialized && !migrationApplied ? 'prior' : 'expected' },
    })
    const evidence = await new MigrationVerifier(runner).verify(preview, { expectedSchemaHash: 'expected', priorSchemaHash: 'prior' })
    const created = runner.calls.filter((call) => call.startsWith('create:')).map((call) => call.slice('create:'.length)); const emptyDatabase = created[0]!; const upgradeDatabase = created[1]!
    expect(evidence).toMatchObject({ migrationId: 'm1', sqlSha256: preview.sqlSha256, emptyDatabase, upgradeDatabase, recovery: 'rollback' })
    expect(appliedSql).toBe(preview.sql)
    expect(runner.calls).toEqual([
      `create:${emptyDatabase}`, `applyAll:${emptyDatabase}`, `hash:${emptyDatabase}`, `tests:${emptyDatabase}`,
      `create:${upgradeDatabase}`, `baseline:${upgradeDatabase}:prior`, `hash:${upgradeDatabase}`, `migration:${upgradeDatabase}`, `hash:${upgradeDatabase}`, `tests:${upgradeDatabase}`, `recovery:${upgradeDatabase}`,
      `drop:${upgradeDatabase}`, `drop:${emptyDatabase}`,
    ])
  })

  it('uses distinct disposable database names for concurrent verification runs', async () => {
    const runner = fixtureRunner()
    await Promise.all([
      new MigrationVerifier(runner).verify(preview, { expectedSchemaHash: 'expected' }),
      new MigrationVerifier(runner).verify(preview, { expectedSchemaHash: 'expected' }),
    ])
    const created = runner.calls.filter((call) => call.startsWith('create:')).map((call) => call.slice('create:'.length))
    expect(created).toHaveLength(2)
    expect(new Set(created).size).toBe(2)
    expect(created.every((name) => /^verify_m1_empty_[a-f0-9]{12}$/u.test(name))).toBe(true)
  })

  it('keeps both verification database names within PostgreSQL identifier limits', async () => {
    const longPreview = { ...preview, migrationId: 'migration-' + 'x'.repeat(200) }
    let applied = false
    const runner = fixtureRunner({
      initializeBaseline: async () => undefined,
      applyMigration: async () => { applied = true },
      rollbackOrRepair: async () => ({ mode: 'rollback' as const, passed: true, output: 'recovered' }),
      schemaHash: async (database) => database.endsWith('_upgrade') && !applied ? 'prior' : 'expected',
    })
    const evidence = await new MigrationVerifier(runner).verify(longPreview, { expectedSchemaHash: 'expected', priorSchemaHash: 'prior' })
    expect(evidence.emptyDatabase.length).toBeLessThanOrEqual(63)
    expect(evidence.upgradeDatabase!.length).toBeLessThanOrEqual(63)
    expect(evidence.upgradeDatabase).toBe(`${evidence.emptyDatabase}_upgrade`)
  })

  it('attempts cleanup when database creation rejects after the server may have created it', async () => {
    const runner = fixtureRunner({ createDatabase: async (name) => { runner.calls.push(`create:${name}`); throw new Error('connection dropped after create') } })
    await expect(new MigrationVerifier(runner).verify(preview, { expectedSchemaHash: 'expected' })).rejects.toThrow(/connection dropped/i)
    expect(runner.calls.filter((call) => call.startsWith('drop:'))).toHaveLength(1)
  })

  it('drops both verification databases when upgrade verification fails', async () => {
    let migrationApplied = false
    const runner = fixtureRunner({
      initializeBaseline: async () => undefined,
      applyMigration: async () => { migrationApplied = true },
      rollbackOrRepair: async () => ({ mode: 'forward-repair' as const, passed: true, output: 'repaired' }),
      schemaHash: async (database) => { runner.calls.push(`hash:${database}`); return database.endsWith('_upgrade') ? (migrationApplied ? 'wrong' : 'prior') : 'expected' },
    })
    await expect(new MigrationVerifier(runner).verify(preview, { expectedSchemaHash: 'expected', priorSchemaHash: 'prior' })).rejects.toThrow(/upgrade schema/i)
    expect(runner.calls.some((call) => /^drop:verify_m1_empty_[a-f0-9]{12}_upgrade$/u.test(call))).toBe(true)
    expect(runner.calls.some((call) => /^drop:verify_m1_empty_[a-f0-9]{12}$/u.test(call))).toBe(true)
  })
})

function fixtureRunner(overrides: Partial<MigrationVerificationRunner> = {}): MigrationVerificationRunner & { calls: string[] } {
  const calls: string[] = []
  const runner = {
    calls,
    createDatabase: async (name: string) => { calls.push(`create:${name}`) },
    dropDatabase: async (name: string) => { calls.push(`drop:${name}`) },
    applyAll: async (database: string) => { calls.push(`applyAll:${database}`) },
    schemaHash: async (database: string) => { calls.push(`hash:${database}`); return database.endsWith('_upgrade') ? 'expected' : 'expected' },
    runIntegrationTests: async (database: string) => { calls.push(`tests:${database}`); return { passed: true, output: 'passed' } },
    ...overrides,
  }
  return runner
}
