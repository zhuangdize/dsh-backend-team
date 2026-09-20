import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DbGateLauncher, type DbGateProcessAdapter } from '../src/index.js'

describe('DbGateLauncher', () => {
  it('delivers login only once to the initiating host session and revokes it on stop', async () => {
    let expected: { username: string; password: string } | undefined
    const launcher = fixtureLauncher('/workspace', {
      start: async (executable, _args, _cwd, env) => { expected = { username: env.LOGIN!, password: env.PASSWORD! }; return { pid: 11, executable } },
      stop: async () => undefined,
      inspectListeners: async () => ['127.0.0.1:55234'],
      isReady: async () => true,
    })
    await launcher.start(fixtureConfig('/workspace'))
    expect(() => launcher.consumeLogin('session-owner-123456')).toThrow()
    launcher.authorizeLogin('session-owner-123456')
    expect(() => launcher.consumeLogin('session-other-123456')).toThrow()
    expect(launcher.consumeLogin('session-owner-123456')).toMatchObject(expected!)
    expect(() => launcher.consumeLogin('session-owner-123456')).toThrow()
    expect(JSON.stringify(launcher.status())).not.toContain(expected!.password)
    launcher.authorizeLogin('session-owner-123456')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
    try { expect(() => launcher.consumeLogin('session-owner-123456')).toThrow() } finally { clock.mockRestore() }
    launcher.authorizeLogin('session-owner-123456')
    await launcher.stop()
    expect(() => launcher.consumeLogin('session-owner-123456')).toThrow()
  })
  it('waits for the child to own the requested listener before probing readiness', async () => {
    let inspections = 0
    let probes = 0
    const launcher = fixtureLauncher('/workspace', {
      start: async (executable) => ({ pid: 8, executable }),
      stop: async () => undefined,
      inspectListeners: async () => ++inspections < 3 ? [] : ['127.0.0.1:55234'],
      isReady: async () => { probes += 1; return true },
    })
    await expect(launcher.start(fixtureConfig('/workspace'))).resolves.toBe('http://127.0.0.1:55234/')
    expect(inspections).toBe(3)
    expect(probes).toBe(1)
    await launcher.stop()
  })

  it('does not accept an unrelated ready server on the requested port', async () => {
    let probes = 0
    let stops = 0
    const launcher = fixtureLauncher('/workspace', {
      start: async (executable) => ({ pid: 9, executable }),
      stop: async () => { stops += 1 },
      inspectListeners: async () => ['127.0.0.1:55235'],
      isReady: async () => { probes += 1; return true },
    })
    await expect(launcher.start(fixtureConfig('/workspace'))).rejects.toThrow(/ready/)
    expect(probes).toBe(0)
    expect(stops).toBe(1)
  })

  it('cleans up at the deadline even if a readiness probe never settles', async () => {
    let stopped = false
    const launcher = fixtureLauncher('/workspace', {
      start: async (executable) => ({ pid: 10, executable }),
      stop: async () => { stopped = true },
      inspectListeners: async () => ['127.0.0.1:55234'],
      isReady: async () => new Promise<boolean>(() => undefined),
    })
    await expect(launcher.start(fixtureConfig('/workspace'))).rejects.toThrow(/deadline/)
    expect(stopped).toBe(true)
    expect(launcher.status()).toEqual({ state: 'stopped' })
  })
  it.each(['inspection-error', 'unsafe-listener', 'not-ready', 'readiness-error'] as const)('cleans up a spawned process after %s and permits a fresh start', async (failure) => {
    const root = '/workspace'
    let fault = true
    let live = false
    const processAdapter: DbGateProcessAdapter = {
      start: async (executable) => {
        if (live) throw new Error('previous process is still alive')
        live = true
        return { pid: 3, executable }
      },
      stop: async () => { live = false },
      inspectListeners: async () => {
        if (fault && failure === 'inspection-error') throw new Error('listener inspection failed')
        return [fault && failure === 'unsafe-listener' ? '0.0.0.0:55234' : '127.0.0.1:55234']
      },
      isReady: async () => {
        if (fault && failure === 'readiness-error') throw new Error('readiness inspection failed')
        return !(fault && failure === 'not-ready')
      },
    }
    const launcher = fixtureLauncher(root, processAdapter)
    await expect(launcher.start(fixtureConfig(root))).rejects.toThrow()
    expect(live).toBe(false)
    expect(launcher.status()).toEqual({ state: 'stopped' })
    expect(launcher.authFingerprint()).toBeUndefined()
    fault = false
    await expect(launcher.start(fixtureConfig(root))).resolves.toBe('http://127.0.0.1:55234/')
    await launcher.stop()
    expect(live).toBe(false)
  })

  it('retains the process after failed cleanup, reports both failures, and allows stop to retry', async () => {
    const root = '/workspace'
    const startupError = new Error('readiness inspection failed')
    const cleanupError = new Error('termination failed')
    let refuseStop = true
    let live = false
    let starts = 0
    const processAdapter: DbGateProcessAdapter = {
      start: async (executable) => { live = true; starts += 1; return { pid: 4, executable } },
      stop: async () => { if (refuseStop) throw cleanupError; live = false },
      inspectListeners: async () => ['127.0.0.1:55234'],
      isReady: async () => { throw startupError },
    }
    const launcher = fixtureLauncher(root, processAdapter)
    await expect(launcher.start(fixtureConfig(root))).rejects.toMatchObject({ errors: [startupError, cleanupError] })
    expect(live).toBe(true)
    expect(launcher.status()).toMatchObject({ state: 'interrupted', process: { pid: 4 } })
    expect(launcher.status().url).toBeUndefined()
    expect(launcher.authFingerprint()).toBeUndefined()
    await expect(launcher.start(fixtureConfig(root))).rejects.toThrow(/cleanup|stop/i)
    expect(starts).toBe(1)
    refuseStop = false
    await launcher.stop()
    expect(live).toBe(false)
    expect(launcher.status()).toEqual({ state: 'stopped' })
  })

  it('shares one launch across concurrent requests', async () => {
    const spawned = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let starts = 0
    const launcher = fixtureLauncher('/workspace', {
      start: async (executable) => { starts += 1; spawned.resolve(); await release.promise; return { pid: starts, executable } },
      stop: async () => undefined,
      inspectListeners: async () => ['127.0.0.1:55234'],
      isReady: async () => true,
    })
    const first = launcher.start(fixtureConfig('/workspace'))
    await spawned.promise
    const second = launcher.start(fixtureConfig('/workspace'))
    release.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual(['http://127.0.0.1:55234/', 'http://127.0.0.1:55234/'])
    expect(starts).toBe(1)
    await launcher.stop()
  })

  it('waits for a pending launch before stopping its child', async () => {
    const spawned = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let live = false
    const launcher = fixtureLauncher('/workspace', {
      start: async (executable) => { live = true; spawned.resolve(); await release.promise; return { pid: 6, executable } },
      stop: async () => { live = false },
      inspectListeners: async () => ['127.0.0.1:55234'],
      isReady: async () => true,
    })
    const starting = launcher.start(fixtureConfig('/workspace'))
    await spawned.promise
    const stopping = launcher.stop()
    release.resolve()
    await Promise.all([starting, stopping])
    expect(live).toBe(false)
    expect(launcher.status()).toEqual({ state: 'stopped' })
  })

  it('withdraws navigation after a normal stop fails and retries the same child', async () => {
    let refuseStop = true
    let live = false
    const launcher = fixtureLauncher('/workspace', {
      start: async (executable) => { live = true; return { pid: 7, executable } },
      stop: async () => { if (refuseStop) throw new Error('termination failed'); live = false },
      inspectListeners: async () => ['127.0.0.1:55234'],
      isReady: async () => true,
    })
    await launcher.start(fixtureConfig('/workspace'))
    await expect(launcher.stop()).rejects.toThrow('termination failed')
    expect(launcher.status()).toMatchObject({ state: 'interrupted', process: { pid: 7 } })
    expect(launcher.status().url).toBeUndefined()
    expect(launcher.authFingerprint()).toBeUndefined()
    refuseStop = false
    await launcher.stop()
    expect(live).toBe(false)
    expect(launcher.status()).toEqual({ state: 'stopped' })
  })

  it('rejects an executable outside the workspace-local DbGate runtime before spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-launcher-'))
    try {
      const calls: string[] = []
      const processAdapter: DbGateProcessAdapter = {
        start: async (executable) => { calls.push(executable); return { pid: 1, executable } },
        stop: async () => undefined,
        inspectListeners: async () => ['127.0.0.1:55234'],
        isReady: async () => true,
      }
      const launcher = new DbGateLauncher({ workspaceRoot: root, runtimeRoot: join(root, '.backend-team/runtime/dbgate'), executable: join(root, 'outside/dbgate-serve'), process: processAdapter, credentials: fixtureCredentials() })
      await expect(launcher.start({ endpoint: { host: '127.0.0.1', socketDirectory: join(root, 'socket'), port: 55233, database: 'postgres', user: 'backend_team', credentialRef: 'ref' }, port: 55234 })).rejects.toThrow(/workspace|runtime|path/i)
      expect(calls).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('stops a process when listener and readiness checks pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-launcher-'))
    try {
      const calls: string[] = []
      const processAdapter: DbGateProcessAdapter = {
        start: async (executable, args, cwd, env) => { calls.push(`${executable}:${args.join(',')}:${cwd}:${env.SHELL_SCRIPTING}`); return { pid: 2, executable } },
        stop: async () => { calls.push('stop') },
        inspectListeners: async () => ['127.0.0.1:55234'],
        isReady: async () => true,
      }
      const executable = join(root, '.backend-team/runtime/dbgate/dbgate-serve')
      const launcher = new DbGateLauncher({ workspaceRoot: root, runtimeRoot: join(root, '.backend-team/runtime/dbgate'), executable, process: processAdapter, credentials: fixtureCredentials() })
      await expect(launcher.start({ endpoint: { host: '127.0.0.1', socketDirectory: join(root, 'socket'), port: 55233, database: 'design_0123456789abcdef', user: 'backend_team', credentialRef: 'ref' }, port: 55234 })).resolves.toBe('http://127.0.0.1:55234/')
      await expect(launcher.start({ endpoint: { host: '127.0.0.1', socketDirectory: join(root, 'socket'), port: 55233, database: 'design_0123456789abcdef', user: 'backend_team', credentialRef: 'ref' }, port: 55235 })).resolves.toBe('http://127.0.0.1:55234/')
      expect(calls.filter((call) => call.includes('127.0.0.1'))).toHaveLength(1)
      expect(launcher.status()).toMatchObject({ state: 'running', url: 'http://127.0.0.1:55234/' })
      await launcher.stop()
      expect(calls).toContain('stop')
      expect(launcher.status()).toEqual({ state: 'stopped' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('injects one credential-backed design connection and selects it as the only database', async () => {
    let env: Readonly<Record<string, string>> | undefined
    const launcher = fixtureLauncher('/workspace', {
      start: async (executable, _args, _cwd, childEnv) => { env = childEnv; return { pid: 12, executable } },
      stop: async () => undefined,
      inspectListeners: async () => ['127.0.0.1:55234'],
      isReady: async () => true,
    })
    await launcher.start({ endpoint: { ...fixtureConfig('/workspace').endpoint, database: 'design_0123456789abcdef', credentialRef: 'pg-ref' }, port: 55234 })
    expect(env).toMatchObject({
      CONNECTIONS: 'workspace_design',
      ENGINE_workspace_design: 'postgres@dbgate-plugin-postgres',
      SERVER_workspace_design: '127.0.0.1',
      USER_workspace_design: 'backend_team',
      PASSWORD_workspace_design: 'postgres-secret',
      DATABASE_workspace_design: 'design_0123456789abcdef',
      SINGLE_CONNECTION: 'workspace_design',
      SINGLE_DATABASE: 'design_0123456789abcdef',
    })
    expect(env?.PASSWORD_workspace_design).toBe('postgres-secret')
    await launcher.stop()
  })

  it('rejects a maintenance database endpoint before spawning DbGate', async () => {
    let starts = 0
    const launcher = fixtureLauncher('/workspace', {
      start: async (executable) => { starts += 1; return { pid: 13, executable } },
      stop: async () => undefined,
      inspectListeners: async () => ['127.0.0.1:55234'],
      isReady: async () => true,
    })
    await expect(launcher.start({ ...fixtureConfig('/workspace'), endpoint: { ...fixtureConfig('/workspace').endpoint, database: 'postgres' }, port: 55234 })).rejects.toThrow(/design database/i)
    expect(starts).toBe(0)
  })
})

function fixtureLauncher(root: string, process: DbGateProcessAdapter): DbGateLauncher {
  const runtimeRoot = join(root, '.backend-team/runtime/dbgate')
  return new DbGateLauncher({ workspaceRoot: root, runtimeRoot, executable: join(runtimeRoot, 'dbgate-serve'), process, credentials: fixtureCredentials(), readinessTimeoutMs: 100, readinessPollMs: 1 })
}

function fixtureCredentials() {
  return { put: async () => 'ref', get: async () => Buffer.from('postgres-secret'), delete: async () => undefined }
}

function fixtureConfig(root: string) {
  return { endpoint: { host: '127.0.0.1' as const, socketDirectory: join(root, 'socket'), port: 55233, database: 'design_0123456789abcdef', user: 'backend_team', credentialRef: 'ref' }, port: 55234 }
}
