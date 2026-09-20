import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryCredentialStore, PortAllocator, PostgresqlCluster } from '../src/index.js'

describe('PostgresqlCluster', () => {
  it('starts only with loopback listeners and stops the matching process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pg-cluster-'))
    try {
      const starts: string[] = []; const stops: string[] = []
      const cluster = new PostgresqlCluster({ workspaceRoot: root, runtimeRoot: join(root, '.backend-team/runtime/postgresql'), executableRoot: join(root, '.backend-team/runtime/postgresql/18.6/darwin-arm64'), credentials: new MemoryCredentialStore(), ports: new PortAllocator(root, { isAvailable: async () => true }), process: {
        start: async (executable, args) => { starts.push(`${executable}:${args.join(' ')}`); return { pid: 123, executable, dataDirectory: join(root, '.backend-team/runtime/postgresql/data-18'), startedAt: new Date().toISOString() } },
        stop: async (record) => { stops.push(`${record.pid}`) },
        isReady: async () => true,
        inspectListeners: async () => ['127.0.0.1:55432', 'unix:/workspace/socket'],
      } })
      const endpoint = await cluster.start()
      expect(endpoint.host).toBe('127.0.0.1'); expect(endpoint.port).toBeGreaterThanOrEqual(49152); expect(starts).toHaveLength(1)
      await cluster.stop(); expect(stops).toEqual(['123']); expect(cluster.status().state).toBe('initialized')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('stops and blocks a non-loopback listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pg-cluster-'))
    try {
      const cluster = new PostgresqlCluster({ workspaceRoot: root, runtimeRoot: join(root, 'runtime'), executableRoot: join(root, 'bin'), credentials: new MemoryCredentialStore(), process: { start: async (executable) => ({ pid: 1, executable, dataDirectory: join(root, 'runtime/data-18'), startedAt: new Date().toISOString() }), stop: async () => {}, isReady: async () => true, inspectListeners: async () => ['*:5432'] } })
      await expect(cluster.start()).rejects.toThrow(/non-loopback/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('uses and removes a workspace-local initdb password file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pg-cluster-'))
    try {
      let initdbArgs: readonly string[] = []
      const cluster = new PostgresqlCluster({ workspaceRoot: root, runtimeRoot: join(root, 'runtime'), executableRoot: join(root, 'bin'), credentials: new MemoryCredentialStore(), process: { initdb: async (_executable, args) => { initdbArgs = args }, start: async (executable) => ({ pid: 1, executable, dataDirectory: join(root, 'runtime/data-18'), startedAt: new Date().toISOString() }), stop: async () => {}, isReady: async () => true, inspectListeners: async () => [] } })
      await cluster.initialize(); expect(initdbArgs).toContain('--pwfile'); expect((await readdir(join(root, 'runtime'))).some((name) => name.endsWith('.pw'))).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('replaces initdb defaults with the loopback SCRAM configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pg-cluster-'))
    try {
      const runtime = join(root, 'runtime')
      const data = join(runtime, 'data-18')
      const cluster = new PostgresqlCluster({ workspaceRoot: root, runtimeRoot: runtime, executableRoot: join(root, 'bin'), credentials: new MemoryCredentialStore(), process: {
        initdb: async () => {
          await writeFile(join(data, 'postgresql.conf'), "# initdb default\n")
          await writeFile(join(data, 'pg_hba.conf'), "local all all trust\n")
        },
        start: async (executable) => ({ pid: 1, executable, dataDirectory: data, startedAt: new Date().toISOString() }),
        stop: async () => {},
        isReady: async () => true,
        inspectListeners: async () => [],
      } })

      await cluster.initialize()
      expect(await readFile(join(data, 'postgresql.conf'), 'utf8')).toContain("listen_addresses = '127.0.0.1'")
      expect(await readFile(join(data, 'pg_hba.conf'), 'utf8')).toContain('scram-sha-256')
      expect(await readFile(join(data, 'pg_hba.conf'), 'utf8')).not.toContain(' trust')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

it('serializes concurrent start/stop and initializes only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pg-serial-'))
  let starts = 0; let stops = 0; let initializations = 0
  const cluster = new PostgresqlCluster({ workspaceRoot: root, runtimeRoot: join(root, 'runtime'), executableRoot: join(root, 'bin'), credentials: new MemoryCredentialStore(), process: {
    initdb: async () => { initializations++ },
    start: async executable => { starts++; return { pid: 1, executable, dataDirectory: join(root, 'runtime/data-18'), startedAt: new Date().toISOString() } },
    stop: async () => { stops++ }, isReady: async () => true, inspectListeners: async () => ['127.0.0.1:5432'],
  } })
  try {
    const [first, second] = await Promise.all([cluster.start(), cluster.start(), cluster.stop()])
    expect(first).toEqual(second); expect(starts).toBe(1); expect(initializations).toBe(1); expect(stops).toBe(1)
    expect(cluster.status().state).toBe('initialized')
    expect(await readdir(join(root, '.backend-team/locks'))).toEqual([])
  } finally { await cluster.stop(); await rm(root, { recursive: true, force: true }) }
})

it.each(['start', 'inspect', 'ready'])('cleans up a failed %s operation and permits retry', async stage => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pg-failure-')); let failing = true; let stops = 0
  const cluster = new PostgresqlCluster({ workspaceRoot: root, runtimeRoot: join(root, 'runtime'), executableRoot: join(root, 'bin'), credentials: new MemoryCredentialStore(), process: {
    start: async executable => { if(failing && stage === 'start') throw Error('start failed'); return { pid: 1, executable, dataDirectory: join(root, 'runtime/data-18'), startedAt: new Date().toISOString() } },
    stop: async () => { stops++ },
    isReady: async () => { if(failing && stage === 'ready') throw Error('ready failed'); return true },
    inspectListeners: async () => { if(failing && stage === 'inspect') throw Error('inspect failed'); return ['127.0.0.1:5432'] },
  } })
  try {
    await expect(cluster.start()).rejects.toThrow(`${stage} failed`)
    expect(await readdir(join(root, '.backend-team/locks'))).toEqual([])
    expect(stops).toBe(stage === 'start' ? 0 : 1)
    failing = false; await cluster.start(); expect(cluster.status().state).toBe('running')
  } finally { await cluster.stop(); await rm(root, { recursive: true, force: true }) }
})

it('retains ownership after failed cleanup until an explicit stop succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pg-cleanup-')); let stopFails = true; let starts = 0
  const cluster = new PostgresqlCluster({ workspaceRoot: root, runtimeRoot: join(root, 'runtime'), executableRoot: join(root, 'bin'), credentials: new MemoryCredentialStore(), process: {
    start: async executable => { starts++; return { pid: 1, executable, dataDirectory: join(root, 'runtime/data-18'), startedAt: new Date().toISOString() } },
    stop: async () => { if(stopFails) throw Error('stop failed') }, isReady: async () => false, inspectListeners: async () => ['127.0.0.1:5432'],
  } })
  try {
    await expect(cluster.start()).rejects.toThrow('cleanup is incomplete')
    expect(cluster.status().state).toBe('interrupted')
    expect(await readdir(join(root, '.backend-team/locks'))).toHaveLength(1)
    await expect(cluster.start()).rejects.toThrow('cleanup is incomplete')
    expect(starts).toBe(1)
    stopFails = false; await cluster.stop()
    expect(cluster.status().state).toBe('initialized')
    expect(await readdir(join(root, '.backend-team/locks'))).toEqual([])
  } finally { stopFails = false; await cluster.stop(); await rm(root, { recursive: true, force: true }) }
})

it('recovers the original credential and data instead of rerunning initdb', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pg-reopen-')); const credentials = new MemoryCredentialStore(); let initializations = 0
  const options = { workspaceRoot: root, runtimeRoot: join(root, 'runtime'), executableRoot: join(root, 'bin'), credentials, process: {
    initdb: async () => { initializations++; await writeFile(join(root, 'runtime/data-18/PG_VERSION'), '18\n', { mode: 0o600 }); await writeFile(join(root, 'runtime/data-18/user-data'), 'preserve') },
    start: async (executable: string) => ({ pid: 1, executable, dataDirectory: join(root, 'runtime/data-18'), startedAt: new Date().toISOString() }),
    stop: async () => {}, isReady: async () => true, inspectListeners: async () => ['127.0.0.1:5432'],
  } }
  try {
    const first = new PostgresqlCluster(options); const before = await first.start(); await first.stop()
    const second = new PostgresqlCluster(options); const after = await second.start(); await second.stop()
    expect(initializations).toBe(1); expect(after.credentialRef).toBe(before.credentialRef)
    expect(await readFile(join(root, 'runtime/data-18/user-data'), 'utf8')).toBe('preserve')
    await credentials.delete(after.credentialRef)
    await expect(new PostgresqlCluster(options).initialize()).rejects.toThrow(/credential/)
    expect(initializations).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['missing-metadata', 'wrong-workspace', 'live-process', 'wrong-version'])('preserves existing data when recovery is blocked by %s', async reason => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pg-preserve-')); const credentials = new MemoryCredentialStore(); let initialized = 0
  const options = { workspaceRoot: root, runtimeRoot: join(root, 'runtime'), executableRoot: join(root, 'bin'), credentials, process: {
    initdb: async () => { initialized++; await writeFile(join(root, 'runtime/data-18/PG_VERSION'), '18\n', { mode: 0o600 }) },
    start: async (executable: string) => ({ pid: 1, executable, dataDirectory: join(root, 'runtime/data-18'), startedAt: new Date().toISOString() }),
    stop: async () => {}, isReady: async () => true, inspectListeners: async () => [],
  } }
  try {
    await new PostgresqlCluster(options).initialize()
    const metadata = join(root, 'runtime/.cluster.json'); const config = join(root, 'runtime/data-18/postgresql.conf')
    const before = await readFile(config, 'utf8')
    if (reason === 'missing-metadata') await rm(metadata)
    if (reason === 'wrong-workspace') { const data = JSON.parse(await readFile(metadata, 'utf8')); data.workspaceRoot = '/different-workspace'; await writeFile(metadata, JSON.stringify(data)) }
    if (reason === 'live-process') await writeFile(join(root, 'runtime/data-18/postmaster.pid'), '123')
    if (reason === 'wrong-version') await writeFile(join(root, 'runtime/data-18/PG_VERSION'), '17\n')
    await expect(new PostgresqlCluster(options).initialize()).rejects.toThrow(/recovery|existing data/)
    expect(initialized).toBe(1); expect(await readFile(config, 'utf8')).toBe(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
