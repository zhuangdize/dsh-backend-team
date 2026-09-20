import { mkdtemp, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __setWorkspaceLayoutTestHooksForTest, createWorkspaceLayout, initializeWorkspaceLayout, writeManagedMetadata } from '../src/workspace-layout.js'
import { ProcessSupervisor } from '../src/process-supervisor.js'
import type { ProcessExecutionCapability, ProcessExecutionScope, ProcessStartRequest } from '../src/process-supervisor.js'

const roots: string[] = []
const capability: ProcessExecutionCapability = { async executeApprovedProcess<T>(_scope: ProcessExecutionScope, _signal: AbortSignal, operation: () => Promise<T>): Promise<T> { return operation() } }
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('process supervisor', () => {
  it('persists complete process provenance before returning a record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const supervisor = new ProcessSupervisor(layout, { capability, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` }), spawnProcess: () => ({ pid: 1234 }) as never, pidExists: () => true })
    const record = (await supervisor.start({ id: 'process-12345678', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).record
    expect(record).toMatchObject({ id: 'process-12345678', pid: 1234, executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}`, workspaceRoot: layout.root, purpose: 'test' })
    expect((await stat(join(layout.runtimeDir, 'process-12345678.pid.json'))).mode & 0o777).toBe(0o600)
  })

  it('will not stop a reused pid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-reuse-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    let inspectCalls = 0
    const supervisor = new ProcessSupervisor(layout, { capability, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: ++inspectCalls === 1 ? `started\u0000${process.execPath}` : `reused\u0000${process.execPath}` }), spawnProcess: () => ({ pid: 1234 }) as never, pidExists: () => true, sendSignal: () => undefined })
    await supervisor.start({ id: 'process-12345678', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })
    await expect(supervisor.stop('process-12345678', new AbortController().signal)).rejects.toThrow(/process identity mismatch/)
  })

  it('waits after SIGTERM and rechecks identity before SIGKILL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-stop-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const signals: NodeJS.Signals[] = []
    let alive = true
    const supervisor = new ProcessSupervisor(layout, { capability, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: `correct\u0000${process.execPath}` }), spawnProcess: () => ({ pid: 1234 }) as never, pidExists: () => alive, sendSignal: (_pid, signal) => { signals.push(signal); if (signal === 'SIGTERM') alive = false }, waitMs: async () => undefined })
    await supervisor.start({ id: 'process-12345678', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })
    await supervisor.stop('process-12345678', new AbortController().signal)
    expect(signals).toEqual(['SIGTERM'])
  })

  it('can stop a controlled child process using real macOS identity data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-real-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const supervisor = new ProcessSupervisor(layout, { capability })
    const started = await supervisor.start({ id: 'controlled-test-child', executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], cwd: root, env: {}, purpose: 'controlled-test-child', signal: new AbortController().signal })
    const exited = new Promise<boolean>((resolve) => started.child.once('exit', () => resolve(true)))
    await supervisor.stop(started.record.id, new AbortController().signal)
    await expect(exited).resolves.toBe(true)
  })

  it('rejects unsafe IDs and duplicate ownership without touching outside paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-id-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    let spawnCount = 0
    const supervisor = new ProcessSupervisor(layout, { capability, spawnProcess: () => { spawnCount += 1; return { pid: 1234 } as never }, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` }), pidExists: () => true })
    await expect(supervisor.start({ id: '../outside', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/id/i)
    const first = await supervisor.start({ id: 'safe-process-1234', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })
    await expect(supervisor.start({ id: first.record.id, executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(spawnCount).toBe(1)
  })

  it('cleans a spawned child when inspect or durable persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-start-failure-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    let alive = true
    const signals: NodeJS.Signals[] = []
    const child = { pid: 1234, kill: (_signal?: NodeJS.Signals) => { void _signal; alive = false; return true } } as never
    const failingInspect = new ProcessSupervisor(layout, { capability, spawnProcess: () => child, inspect: async () => { throw new Error('inspect failed') }, pidExists: () => alive, sendSignal: (_pid, signal) => { signals.push(signal); alive = false }, waitMs: async () => undefined })
    await expect(failingInspect.start({ id: 'inspect-failure', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/inspect failed/)
    expect(signals).toEqual([])
    await expect(stat(join(layout.runtimeDir, 'inspect-failure.pid.reserve'))).rejects.toMatchObject({ code: 'ENOENT' })
    alive = true; signals.length = 0
    const failingPersist = new ProcessSupervisor(layout, { capability, spawnProcess: () => child, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` }), persistRecord: async () => { throw new Error('persist failed') }, pidExists: () => alive, sendSignal: (_pid, signal) => { signals.push(signal); alive = false }, waitMs: async () => undefined })
    await expect(failingPersist.start({ id: 'persist-failure', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/persist failed/)
    expect(signals).toEqual([])
  })

  it('keeps pending ownership when an unverified child cannot be terminated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-pending-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const child = { pid: 4321, exitCode: null, signalCode: null, kill: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) } } as never
    const supervisor = new ProcessSupervisor(layout, { capability, spawnProcess: () => child, inspect: async () => { throw new Error('identity unavailable') }, pidExists: () => true, waitMs: async () => undefined })
    await expect(supervisor.start({ id: 'pending-child', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/identity unavailable|cleanup|permission/i)
    await expect(stat(join(layout.runtimeDir, 'pending-child.pid.reserve'))).resolves.toBeTruthy()
  })

  it('does not signal after an owned child identity changes before cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-mismatch-cleanup-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    let inspectCalls = 0
    const signals: NodeJS.Signals[] = []
    const child = { pid: 4322, exitCode: null, signalCode: null, kill: () => true } as never
    const supervisor = new ProcessSupervisor(layout, { capability, spawnProcess: () => child, inspect: async () => { inspectCalls += 1; if (inspectCalls === 1) return { executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` }; throw new Error('identity mismatch') }, persistRecord: async () => { throw new Error('persist failed') }, pidExists: () => true, sendSignal: (_pid, signal) => { signals.push(signal) }, waitMs: async () => undefined })
    await expect(supervisor.start({ id: 'mismatch-child', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/identity mismatch/)
    expect(signals).toEqual([])
    await expect(stat(join(layout.runtimeDir, 'mismatch-child.pid.reserve'))).resolves.toBeTruthy()
  })

  it('rejects an invalid inspector identity before writing a formal record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-invalid-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const child = { pid: 4323, exitCode: null, signalCode: null, kill: () => true } as never
    const supervisor = new ProcessSupervisor(layout, { capability, spawnProcess: () => child, inspect: async () => ({ executableRealPath: '/tmp/not-requested', startFingerprint: 'invalid' }), pidExists: () => false })
    await expect(supervisor.start({ id: 'invalid-child', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/identity|invalid/)
    await expect(stat(join(layout.runtimeDir, 'invalid-child.pid.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('validates the complete formal record before durable publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-invalid-record-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const child = { pid: 4324, exitCode: null, signalCode: null, kill: () => true } as never
    const supervisor = new ProcessSupervisor(layout, {
      capability,
      spawnProcess: () => child,
      inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: 'malformed-fingerprint' }),
      pidExists: () => false,
    })
    await expect(supervisor.start({ id: 'invalid-record', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/invalid managed process record|identity/i)
    await expect(stat(join(layout.runtimeDir, 'invalid-record.pid.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back a late formal-record failure without poisoning the ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-record-rollback-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    let alive = false
    const child = { pid: 4325, exitCode: null, signalCode: null, kill: () => true } as never
    let syncCalls = 0
    const restore = __setWorkspaceLayoutTestHooksForTest({ syncDirectory: async () => { syncCalls += 1; if (syncCalls === 3) throw new Error('formal record directory sync failed') } })
    const failing = new ProcessSupervisor(layout, { capability, spawnProcess: () => { alive = false; return child }, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` }), pidExists: () => alive })
    await expect(failing.start({ id: 'late-record-failure', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/formal record directory sync failed/)
    await expect(stat(join(layout.runtimeDir, 'late-record-failure.pid.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(layout.runtimeDir, 'late-record-failure.pid.reserve'))).rejects.toMatchObject({ code: 'ENOENT' })
    restore()
    const retry = new ProcessSupervisor(layout, { capability, spawnProcess: () => child, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` }), pidExists: () => false })
    await expect(retry.start({ id: 'late-record-failure', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'retry', signal: new AbortController().signal })).resolves.toMatchObject({ record: { id: 'late-record-failure' } })
  })

  it('retains the reservation when formal-record rollback cannot sync its directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-record-rollback-fault-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    let syncCalls = 0
    const restore = __setWorkspaceLayoutTestHooksForTest({ syncDirectory: async () => { syncCalls += 1; if (syncCalls >= 3) throw new Error('record rollback sync failed') } })
    try {
      const child = { pid: 4326, exitCode: null, signalCode: null, kill: () => true } as never
      const supervisor = new ProcessSupervisor(layout, { capability, spawnProcess: () => child, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` }), pidExists: () => false })
      await expect(supervisor.start({ id: 'record-rollback-fault', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/record rollback sync failed|cleanup/i)
      await expect(stat(join(layout.runtimeDir, 'record-rollback-fault.pid.reserve'))).resolves.toBeTruthy()
    } finally { restore() }
  })

  it('retains a trusted record when the process remains alive after SIGKILL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-kill-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const signals: NodeJS.Signals[] = []
    const supervisor = new ProcessSupervisor(layout, { capability, spawnProcess: () => ({ pid: 1234 }) as never, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` }), pidExists: () => true, sendSignal: (_pid, signal) => { signals.push(signal) }, waitMs: async () => undefined, stopTimeoutMs: 0 })
    await supervisor.start({ id: 'stubborn-process', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })
    await expect(supervisor.stop('stubborn-process', new AbortController().signal)).rejects.toThrow(/remained alive|SIGKILL/)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    await expect(supervisor.load('stubborn-process')).resolves.toMatchObject({ id: 'stubborn-process' })
  })

  it('rejects a corrupted persisted record before any signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-corrupt-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    await writeManagedMetadata(layout, 'runtime/corrupt-record.pid.json', '{"id":"corrupt-record","pid":"bad"}\n')
    const sendSignal = (_pid: number, _signal: NodeJS.Signals) => { void _pid; void _signal; throw new Error('must not signal') }
    const supervisor = new ProcessSupervisor(layout, { capability, sendSignal })
    await expect(supervisor.stop('corrupt-record', new AbortController().signal)).rejects.toThrow(/invalid managed process record/)
  })

  it('re-authorizes the exact process scope immediately before spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-policy-'))
    roots.push(root)
    let spawnCount = 0
    const authorize = vi.fn(async (...args: readonly unknown[]) => { void args; return { effect: 'deny' as const, ruleId: 'test-deny', reason: 'blocked' } })
    const supervisor = new ProcessSupervisor(await initializeWorkspaceLayout(createWorkspaceLayout(root)), { capability: { async executeApprovedProcess<T>(scope: ProcessExecutionScope, _signal: AbortSignal, operation: () => Promise<T>): Promise<T> { const decision = await authorize({ ...scope }); if (decision.effect === 'deny') throw new Error(`policy ${decision.effect}: ${decision.reason}`); return operation() } }, spawnProcess: () => { spawnCount += 1; return { pid: 1234 } as never } })
    await expect(supervisor.start({ id: 'policy-denied', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/policy deny/)
    expect(authorize).toHaveBeenCalledOnce()
    expect(spawnCount).toBe(0)
  })

  it('rejects outside cwd, unsafe environment, and pre-aborted signals before spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-boundary-'))
    roots.push(root)
    let spawnCount = 0
    const supervisor = new ProcessSupervisor(await initializeWorkspaceLayout(createWorkspaceLayout(root)), { capability, spawnProcess: () => { spawnCount += 1; return { pid: 1234 } as never } })
    const signal = new AbortController(); signal.abort()
    await expect(supervisor.start({ id: 'pre-aborted', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal: signal.signal })).rejects.toThrow(/abort/i)
    await expect(supervisor.start({ id: 'outside-cwd', executable: process.execPath, args: [], cwd: tmpdir(), env: {}, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/cwd|workspace/i)
    await expect(supervisor.start({ id: 'unsafe-env', executable: process.execPath, args: [], cwd: root, env: { NODE_OPTIONS: '--require attacker' }, purpose: 'test', signal: new AbortController().signal })).rejects.toThrow(/environment|ambient/i)
    expect(spawnCount).toBe(0)
  })

  it('passes canonical cwd, filtered environment, and abort signal to the spawn boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-options-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const signal = new AbortController().signal
    let received: ProcessStartRequest | undefined
    const supervisor = new ProcessSupervisor(layout, { capability, spawnProcess: (request) => { received = request; return { pid: 1234 } as never }, inspect: async () => ({ executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` }), pidExists: () => false })
    await supervisor.start({ id: 'exact-options', executable: process.execPath, args: ['-e', ''], cwd: root, env: { MODE: 'test' }, purpose: 'test', signal })
    expect(received).toMatchObject({ executable: process.execPath, cwd: await realpath(root), env: { MODE: 'test' }, signal })
  })

  it('propagates the caller signal to stop-time identity probes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-stop-signal-'))
    roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const observed: AbortSignal[] = []
    let alive = true
    const supervisor = new ProcessSupervisor(layout, { capability, inspect: async (_pid, _executable, signal) => { observed.push(signal); return { executableRealPath: process.execPath, startFingerprint: `started\u0000${process.execPath}` } }, pidExists: () => alive, sendSignal: () => { alive = false }, waitMs: async () => undefined })
    const signal = new AbortController().signal
    await supervisor.start({ id: 'stop-signal-1234', executable: process.execPath, args: [], cwd: root, env: {}, purpose: 'test', signal })
    await supervisor.stop('stop-signal-1234', signal)
    expect(observed).toContain(signal)
  })
})
