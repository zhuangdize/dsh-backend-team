import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseApplicationComposition, DatabaseCatalog, DatabaseRecovery, DatabaseSnapshot, GuiToMigration, SchemaDesignSession, SqlRiskAnalyzer, createDatabaseExecutionPort, type LocalDatabaseEndpoint } from '../src/index.js'

describe('database services', () => {
  it('derives development and test names and creates each once', async () => {
    const calls: string[] = []; const root = await mkdtemp(join(tmpdir(), 'dsh-db-'))
    try { const endpoint = { host: '127.0.0.1' as const, socketDirectory: join(root, 'socket'), database: 'postgres', user: 'backend_team', credentialRef: 'ref' }; const catalog = new DatabaseCatalog(root, endpoint, { createDatabase: async (name) => { calls.push(name) }, databaseExists: async (name) => calls.includes(name) }); const result = await catalog.ensureProjectDatabases('p_demo'); expect(result).toEqual({ development: 'p_demo_dev', test: 'p_demo_test' }); await catalog.ensureProjectDatabases('p_demo'); expect(calls).toEqual(['p_demo_dev', 'p_demo_test']) } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('resolves the latest cluster endpoint when a port is allocated after construction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-db-'))
    try {
      const base: LocalDatabaseEndpoint = { host: '127.0.0.1', socketDirectory: join(root, 'socket'), database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
      let current = base
      const observed: number[] = []
      const catalog = new DatabaseCatalog(root, () => current, { createDatabase: async (_name, endpoint) => { if (endpoint.port !== undefined) observed.push(endpoint.port) } })
      current = { ...base, port: 55321 }
      await catalog.ensureProjectDatabases('p_dynamic')
      expect(observed).toEqual([55321, 55321])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('stores hashed local snapshots and refuses remote restore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-db-')); const endpoint = { host: '127.0.0.1' as const, socketDirectory: join(root, 'socket'), port: 55123, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    try { const runner = { run: async (_executable: string, args: readonly string[]) => { const file = args[args.indexOf('--file') + 1]; if (file === undefined) throw new Error('missing dump path'); await writeFile(file, 'fixture'); return { exitCode: 0, stdout: '', stderr: '' } } }; const snapshot = new DatabaseSnapshot({ workspaceRoot: root, endpoint, runner }); const manifest = await snapshot.create('p_demo_dev', 'test'); expect(manifest.sha256).toHaveLength(64); await expect(snapshot.restore(manifest, { ...endpoint, host: '127.0.0.1', socketDirectory: '/other' }, 'p_restore')).rejects.toThrow(/local workspace/) } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('lists only complete snapshots and validates the empty restore target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-db-')); const endpoint = { host: '127.0.0.1' as const, socketDirectory: join(root, 'socket'), port: 55124, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    try {
      const restoreChecks: string[] = []
      const runner = { run: async (_executable: string, args: readonly string[]) => { const index = args.indexOf('--file'); if (index >= 0) { const file = args[index + 1]; if (file === undefined) throw new Error('missing dump path'); await writeFile(file, 'fixture') }; return { exitCode: 0, stdout: '', stderr: '' } } }
      const snapshot = new DatabaseSnapshot({ workspaceRoot: root, endpoint, runner, assertEmptyDatabase: async (database) => { restoreChecks.push(database) } })
      const manifest = await snapshot.create('p_demo_dev', 'before migration')
      await expect(snapshot.list()).resolves.toEqual([manifest])
      await expect(snapshot.restore(manifest, endpoint, 'p_restore')).resolves.toBeUndefined()
      expect(restoreChecks).toEqual(['p_restore'])
      await expect(snapshot.restore({ ...manifest, dumpFile: `/tmp/${manifest.id}.dump` }, endpoint, 'p_restore')).rejects.toThrow(/canonical|snapshot/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('classifies destructive and standard SQL conservatively', () => { const analyzer = new SqlRiskAnalyzer(); expect(analyzer.analyze('DROP TABLE users').risk).toBe('destructive'); expect(analyzer.analyze('ALTER TABLE users ALTER COLUMN age TYPE smallint').risk).toBe('high'); expect(analyzer.analyze('CREATE INDEX users_email_idx ON users(email)').risk).toBe('standard') })
  it('converts GUI schema diff only after hash-bound evidence verification', async () => { const calls: string[] = []; const sqlSha256 = createHash('sha256').update('CREATE TABLE x(id int)').digest('hex'); const converter = new GuiToMigration({ expert: { updateSchemaAndGenerateMigration: async (diff) => { calls.push(diff.afterSha256); return { migrationId: 'm1', sql: 'CREATE TABLE x(id int)', sqlSha256, risk: 'standard' } } }, verifier: { verify: async () => { calls.push('verify'); return { migrationId: 'm1', sqlSha256, emptyDatabase: 'verify_m1_empty', schemaHash: 'expected', integrationTests: 'passed' } } } }); await converter.convert('CREATE TABLE old(id int);', 'CREATE TABLE old(id int); CREATE TABLE x(id int);'); expect(calls).toEqual([expect.any(String), 'verify']) })
  it('does not apply a GUI migration when verification returns no evidence', async () => { const sqlSha256 = createHash('sha256').update('CREATE TABLE x(id int)').digest('hex'); const converter = new GuiToMigration({ expert: { updateSchemaAndGenerateMigration: async () => ({ migrationId: 'm1', sql: 'CREATE TABLE x(id int)', sqlSha256, risk: 'standard' }) }, verifier: { verify: async () => undefined as unknown as import('../src/index.js').MigrationEvidence } }); await expect(converter.convert('CREATE TABLE old(id int);', 'CREATE TABLE old(id int); CREATE TABLE x(id int);')).rejects.toThrow(/evidence/i) })
  it('returns the immutable expert preview after a verifier mutation attempt', async () => { const originalSql = 'CREATE TABLE x(id int)'; const sqlSha256 = createHash('sha256').update(originalSql).digest('hex'); const sourcePreview = { migrationId: 'm1', sql: originalSql, sqlSha256, risk: 'standard' as const }; const converter = new GuiToMigration({ expert: { updateSchemaAndGenerateMigration: async () => sourcePreview }, verifier: { verify: async (preview) => { try { ;(preview as { sql: string }).sql = 'DROP TABLE x' } catch {} return { migrationId: 'm1', sqlSha256, emptyDatabase: 'verify_m1_empty', schemaHash: 'expected', integrationTests: 'passed' } } } }); const result = await converter.convert('CREATE TABLE old(id int);', 'CREATE TABLE old(id int); CREATE TABLE x(id int);'); expect(result.sql).toBe(originalSql) })
  it('uses a disposable design database', async () => { const names: string[] = []; const endpoint = { host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', database: 'postgres', user: 'backend_team', credentialRef: 'ref' }; const session = new SchemaDesignSession(endpoint, { createDesignDatabase: async (name) => { names.push(name) }, captureSchema: async () => 'schema', dropDatabase: async () => undefined }); const opened = await session.open('p_demo_dev'); expect(opened.database).toMatch(/^design_[a-f0-9]+$/); expect(names[0]).not.toBe('p_demo_dev') })
  it('drops a created design database when initial schema capture fails', async () => {
    const dropped: string[] = []; const endpoint = { host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    const session = new SchemaDesignSession(endpoint, { createDesignDatabase: async () => undefined, captureSchema: async () => { throw new Error('capture failed') }, dropDatabase: async (name) => { dropped.push(name) } })
    await expect(session.open('p_demo_dev')).rejects.toThrow('capture failed')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatch(/^design_[a-f0-9]{16}$/)
  })
  it('reports missing snapshots as recoverable policy state', async () => { const audit = await new DatabaseRecovery().audit({ status: { state: 'initialized' }, expectedExecutable: '/missing', expectedDataDirectory: '/data', listeners: [], migrationJournalPresent: true }); expect(audit.state).toBe('needs-snapshot') })

  it('disposes DbGate before PostgreSQL and makes disposal idempotent', async () => {
    const calls: string[] = []
    const composition = new DatabaseApplicationComposition({
      cluster: { stop: async () => { calls.push('postgresql') }, status: () => ({ state: 'stopped' }) } as never,
      catalog: {} as DatabaseCatalog,
      dbgate: { stop: async () => { calls.push('dbgate') }, status: () => ({ state: 'stopped' }) } as never,
    })

    const first = composition.dispose()
    expect(composition.dispose()).toBe(first)
    await first

    expect(calls).toEqual(['dbgate', 'postgresql'])
    await composition.dispose()
  })

  it('executes PostgreSQL lifecycle and opens only a loopback DbGate URL', async () => {
    const calls: string[] = []
    const endpoint = { host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', port: 55123, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    const port = createDatabaseExecutionPort({
      cluster: {
        start: async () => { calls.push('postgresql:start'); return endpoint },
        stop: async () => { calls.push('postgresql:stop') },
        status: () => ({ state: 'running' as const, endpoint }),
      },
      catalog: { ensureProjectDatabases: async () => { calls.push('catalog:prepare'); return { development: 'p_dev', test: 'p_test' } } },
      designSession: {
        open: async (sourceDatabase: string) => { calls.push(`design:open:${sourceDatabase}`); return { id: 'design-session-123456', sourceDatabase, database: 'design_0123456789abcdef', beforeSchemaHash: 'hash', beforeSchemaSql: '', endpoint } },
        discard: async () => { calls.push('design:discard') },
      },
      dbgate: {
        start: async ({ endpoint: guiEndpoint }) => { calls.push(`dbgate:start:${guiEndpoint.database}`); return 'http://127.0.0.1:55234/' },
        stop: async () => { calls.push('dbgate:stop') },
        status: () => ({ state: 'stopped' as const }),
      },
      guiPort: 55234,
      guiTtlMs: 60_000,
    })

    await expect(port.start()).resolves.toEqual(endpoint)
    await expect(port.prepare()).resolves.toEqual({ development: 'p_dev', test: 'p_test' })
    await expect(port.openGui()).resolves.toMatchObject({ url: 'http://127.0.0.1:55234/' })
    await expect(port.stop()).resolves.toMatchObject({ state: 'running' })
    expect(calls).toEqual(['postgresql:start', 'postgresql:start', 'catalog:prepare', 'postgresql:start', 'catalog:prepare', 'design:open:p_dev', 'dbgate:start:design_0123456789abcdef', 'dbgate:stop', 'design:discard', 'postgresql:stop'])
  })

  it('fails closed when GUI is missing or returns a non-loopback URL', async () => {
    const endpoint = { host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', port: 55123, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    const base = {
      cluster: { start: async () => endpoint, stop: async () => undefined, status: () => ({ state: 'running' as const, endpoint }) },
      catalog: { ensureProjectDatabases: async () => ({ development: 'p_dev', test: 'p_test' }) },
      designSession: {
        open: async (sourceDatabase: string) => ({ id: 'design-session-123456', sourceDatabase, database: 'design_0123456789abcdef', beforeSchemaHash: 'hash', beforeSchemaSql: '', endpoint }),
        discard: async () => undefined,
      },
    }
    await expect(createDatabaseExecutionPort(base).openGui()).rejects.toThrow(/DbGate/i)
    await expect(createDatabaseExecutionPort({ ...base, guiPort: 55234, dbgate: { start: async () => 'http://192.0.2.1:55234/', stop: async () => undefined, status: () => ({ state: 'stopped' as const }) } }).openGui()).rejects.toThrow(/loopback/i)
  })

  it('serializes concurrent GUI opens and reuses the one owned design session', async () => {
    const endpoint = { host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', port: 55123, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    const entered = deferred<void>(); const release = deferred<void>(); const calls: string[] = []; let guiRunning = false
    let opens = 0
    const port = createDatabaseExecutionPort({
      cluster: { start: async () => endpoint, stop: async () => undefined, status: () => ({ state: 'running' as const, endpoint }) },
      catalog: { ensureProjectDatabases: async () => ({ development: 'p_dev', test: 'p_test' }) },
      designSession: {
        open: async (sourceDatabase: string) => { opens += 1; calls.push(`open:${sourceDatabase}`); entered.resolve(); await release.promise; return { id: 'design-session-123456', sourceDatabase, database: 'design_0123456789abcdef', beforeSchemaHash: 'hash', beforeSchemaSql: '', endpoint } },
        discard: async () => { calls.push('discard') },
      },
      dbgate: {
        start: async ({ endpoint: guiEndpoint }) => { guiRunning = true; calls.push(`start:${guiEndpoint.database}`); return 'http://127.0.0.1:55234/' },
        stop: async () => undefined,
        status: () => guiRunning ? { state: 'running' as const, url: 'http://127.0.0.1:55234/' } : { state: 'stopped' as const },
      },
      guiPort: 55234,
    })
    const first = port.openGui(); await entered.promise
    const second = port.openGui(); release.resolve()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(opens).toBe(1)
    expect(calls).toEqual(['open:p_dev', 'start:design_0123456789abcdef'])
  })

  it('discards a design session when its endpoint fails cluster ownership validation', async () => {
    const endpoint = { host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', port: 55123, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    const calls: string[] = []; let refuseDiscard = true
    const port = createDatabaseExecutionPort({
      cluster: { start: async () => endpoint, stop: async () => undefined, status: () => ({ state: 'running' as const, endpoint }) },
      catalog: { ensureProjectDatabases: async () => ({ development: 'p_dev', test: 'p_test' }) },
      designSession: {
        open: async (sourceDatabase: string) => ({ id: 'design-session-123456', sourceDatabase, database: 'design_0123456789abcdef', beforeSchemaHash: 'hash', beforeSchemaSql: '', endpoint: { ...endpoint, socketDirectory: '/other/socket' } }),
        discard: async () => { calls.push('discard'); if (refuseDiscard) throw new Error('design cleanup failed') },
      },
      dbgate: { start: async () => { calls.push('start'); return 'http://127.0.0.1:55234/' }, stop: async () => undefined, status: () => ({ state: 'stopped' as const }) },
      guiPort: 55234,
    })
    await expect(port.openGui()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: expect.stringMatching(/active PostgreSQL cluster/i) }), expect.objectContaining({ message: 'design cleanup failed' })] })
    expect(calls).toEqual(['discard'])
    refuseDiscard = false
    await expect(port.stop()).resolves.toMatchObject({ state: 'running' })
    expect(calls).toEqual(['discard', 'discard'])
  })

  it('retains the design session when GUI startup cleanup cannot stop the child', async () => {
    const endpoint = { host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', port: 55123, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    const calls: string[] = []; let guiRunning = false; let refuseStop = true
    const port = createDatabaseExecutionPort({
      cluster: { start: async () => endpoint, stop: async () => undefined, status: () => ({ state: 'running' as const, endpoint }) },
      catalog: { ensureProjectDatabases: async () => ({ development: 'p_dev', test: 'p_test' }) },
      designSession: {
        open: async (sourceDatabase: string) => ({ id: 'design-session-123456', sourceDatabase, database: 'design_0123456789abcdef', beforeSchemaHash: 'hash', beforeSchemaSql: '', endpoint }),
        discard: async () => { calls.push('design:discard') },
      },
      dbgate: {
        start: async () => { guiRunning = true; calls.push('gui:start'); throw new Error('GUI startup failed') },
        stop: async () => { calls.push('gui:stop'); if (refuseStop) throw new Error('GUI child still alive'); guiRunning = false },
        status: () => guiRunning ? { state: 'running' as const, url: 'http://127.0.0.1:55234/' } : { state: 'stopped' as const },
      },
      guiPort: 55234,
    })
    await expect(port.openGui()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'GUI startup failed' }), expect.objectContaining({ message: 'GUI child still alive' })] })
    expect(calls).toEqual(['gui:start', 'gui:stop'])
    refuseStop = false
    await port.stop()
    expect(calls).toEqual(['gui:start', 'gui:stop', 'gui:stop', 'design:discard'])
  })

  it('keeps the design database and cluster alive when GUI stop fails, then retries cleanup', async () => {
    const endpoint = { host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', port: 55123, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    const calls: string[] = []; let refuseStop = true; let guiRunning = false
    const port = createDatabaseExecutionPort({
      cluster: { start: async () => endpoint, stop: async () => { calls.push('cluster:stop') }, status: () => ({ state: 'running' as const, endpoint }) },
      catalog: { ensureProjectDatabases: async () => ({ development: 'p_dev', test: 'p_test' }) },
      designSession: {
        open: async (sourceDatabase: string) => ({ id: 'design-session-123456', sourceDatabase, database: 'design_0123456789abcdef', beforeSchemaHash: 'hash', beforeSchemaSql: '', endpoint }),
        discard: async () => { calls.push('design:discard') },
      },
      dbgate: {
        start: async () => { guiRunning = true; calls.push('gui:start'); return 'http://127.0.0.1:55234/' },
        stop: async () => { calls.push('gui:stop'); if (refuseStop) throw new Error('GUI still owns design database'); guiRunning = false },
        status: () => guiRunning ? { state: 'running' as const, url: 'http://127.0.0.1:55234/' } : { state: 'stopped' as const },
      },
      guiPort: 55234,
    })
    await port.openGui()
    await expect(port.stop()).rejects.toThrow(/GUI still owns/i)
    expect(calls).toEqual(['gui:start', 'gui:stop'])
    refuseStop = false
    await port.stop()
    expect(calls).toEqual(['gui:start', 'gui:stop', 'gui:stop', 'design:discard', 'cluster:stop'])
  })

  it('cleans a stale owned design session before opening a replacement GUI', async () => {
    const endpoint = { host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', port: 55123, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }
    const calls: string[] = []; let guiRunning = false; let sequence = 0
    const port = createDatabaseExecutionPort({
      cluster: { start: async () => endpoint, stop: async () => undefined, status: () => ({ state: 'running' as const, endpoint }) },
      catalog: { ensureProjectDatabases: async () => ({ development: 'p_dev', test: 'p_test' }) },
      designSession: {
        open: async (sourceDatabase: string) => { const id = `design-session-${++sequence}`; calls.push(`open:${id}`); return { id, sourceDatabase, database: `design_${'0'.repeat(15)}${sequence}`, beforeSchemaHash: 'hash', beforeSchemaSql: '', endpoint } },
        discard: async (session) => { calls.push(`discard:${session.id}`) },
      },
      dbgate: {
        start: async () => { guiRunning = true; calls.push('gui:start'); return 'http://127.0.0.1:55234/' },
        stop: async () => { guiRunning = false; calls.push('gui:stop') },
        status: () => guiRunning ? { state: 'running' as const, url: 'http://127.0.0.1:55234/' } : { state: 'stopped' as const },
      },
      guiPort: 55234,
    })
    await port.openGui(); guiRunning = false
    await port.openGui()
    expect(calls).toEqual(['open:design-session-1', 'gui:start', 'discard:design-session-1', 'open:design-session-2', 'gui:start'])
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}
