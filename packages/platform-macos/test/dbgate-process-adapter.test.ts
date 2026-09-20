import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { WorkspaceDbGateProcessAdapter, type DbGateSupervisor } from '../src/dbgate-process-adapter.js'

describe('WorkspaceDbGateProcessAdapter', () => {
  it.each(['.backend-team', '.backend-team/runtime', '.backend-team/runtime/dbgate'])('rejects an aliased runtime component %s before creating data directories', async (component) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-runtime-alias-'))
    try {
      const alias = join(root, component)
      const other = join(root, 'other')
      await mkdir(dirname(alias), { recursive: true })
      await mkdir(other)
      await symlink(other, alias)
      const runtimeRoot = join(root, '.backend-team/runtime/dbgate')
      await mkdir(runtimeRoot, { recursive: true })
      const nodePath = join(root, 'node')
      const entrypoint = join(runtimeRoot, 'entry.cjs')
      const preload = join(runtimeRoot, 'preload.cjs')
      await Promise.all([writeFile(nodePath, ''), writeFile(entrypoint, ''), writeFile(preload, '')])
      const before = await readdir(runtimeRoot)
      let started = false
      const supervisor: DbGateSupervisor = {
        start: async (request) => {
          started = true
          return { record: { id: request.id, pid: 123, executableRealPath: await realpath(nodePath), startFingerprint: 'fixture', workspaceRoot: await realpath(root), startedAt: new Date().toISOString(), purpose: request.purpose }, child: { pid: 123 } }
        },
        stop: async () => undefined,
      }
      const adapter = new WorkspaceDbGateProcessAdapter({ workspaceRoot: root, runtimeRoot, nodeExecutable: nodePath, preloadPath: preload, supervisor })
      await expect(adapter.start(entrypoint, [], runtimeRoot, {})).rejects.toThrow(/symlink|directory|runtime/i)
      expect(started).toBe(false)
      expect(await readdir(runtimeRoot)).toEqual(before)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each(['home', 'tmp', 'user-data'])('rejects a redirected %s before supervisor start', async (directory) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-data-path-'))
    try {
      const runtimeRoot = join(root, '.backend-team/runtime/dbgate')
      const outside = join(root, 'outside-runtime')
      await mkdir(runtimeRoot, { recursive: true })
      await mkdir(outside)
      const nodePath = join(root, 'node')
      const entrypoint = join(runtimeRoot, 'entry.cjs')
      const preload = join(runtimeRoot, 'preload.cjs')
      await Promise.all([writeFile(nodePath, ''), writeFile(entrypoint, ''), writeFile(preload, '')])
      await symlink(outside, join(runtimeRoot, directory))
      let started = false
      const supervisor: DbGateSupervisor = {
        start: async (request) => {
          started = true
          return { record: { id: request.id, pid: 123, executableRealPath: await realpath(nodePath), startFingerprint: 'fixture', workspaceRoot: await realpath(root), startedAt: new Date().toISOString(), purpose: request.purpose }, child: { pid: 123 } }
        },
        stop: async () => undefined,
      }
      const adapter = new WorkspaceDbGateProcessAdapter({ workspaceRoot: root, runtimeRoot, nodeExecutable: nodePath, preloadPath: preload, supervisor })
      await expect(adapter.start(entrypoint, [], runtimeRoot, {})).rejects.toThrow(/symlink|directory|runtime/i)
      expect(started).toBe(false)
      expect(await readdir(outside)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each([false, true])('runs DbGate through the exact workspace Node and preload (workspace alias: %s)', async (aliasedWorkspace) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-process-'))
    try {
      const selectedRoot = aliasedWorkspace ? join(root, 'workspace-alias') : root
      if (aliasedWorkspace) await symlink(root, selectedRoot)
      const runtimeRoot = join(selectedRoot, '.backend-team/runtime/dbgate')
      const nodePath = join(selectedRoot, '.backend-team/runtime/nvm/bin/node')
      const entrypoint = join(runtimeRoot, 'node_modules/.bin/dbgate-serve')
      const preload = join(runtimeRoot, 'preload.cjs')
      await mkdir(join(runtimeRoot, 'node_modules/.bin'), { recursive: true })
      await mkdir(join(root, '.backend-team/runtime/nvm/bin'), { recursive: true })
      await Promise.all([writeFile(nodePath, ''), writeFile(entrypoint, ''), writeFile(preload, '')])
      const canonicalNodePath = await realpath(nodePath)

      const calls: string[] = []
      const workspaceRoot = await realpath(root)
      const supervisor: DbGateSupervisor = {
        start: async (request) => {
          expect(request.env.HOME).toBe(join(await realpath(runtimeRoot), 'home'))
          expect(request.env.TMPDIR).toBe(join(await realpath(runtimeRoot), 'tmp'))
          expect(request.env.WORKSPACE_DIR).toBe(join(await realpath(runtimeRoot), 'user-data'))
          calls.push(`${request.executable}|${request.args.join('|')}|${request.cwd}|${request.env.PATH}`)
          return { record: { id: request.id, pid: 123, executableRealPath: canonicalNodePath, startFingerprint: `start\\0${canonicalNodePath}`, workspaceRoot, startedAt: new Date().toISOString(), purpose: request.purpose }, child: { pid: 123 } }
        },
        stop: async (id) => { calls.push(`stop:${id}`) },
      }
      const adapter = new WorkspaceDbGateProcessAdapter({ workspaceRoot: selectedRoot, runtimeRoot, nodeExecutable: nodePath, preloadPath: preload, supervisor, listenerInspector: { inspect: async () => ['127.0.0.1:55234'] }, readyProbe: async () => true })
      await expect(adapter.start(entrypoint, ['--port', '55234', '--host', '127.0.0.1'], runtimeRoot, { LOGIN: 'team', PASSWORD: 'secret', HOME: '/outside', TMPDIR: '/outside', WORKSPACE_DIR: '/outside' })).resolves.toMatchObject({ pid: 123, executable: canonicalNodePath })
      expect(calls[0]).toContain(`${canonicalNodePath}|--require|${await realpath(preload)}|${await realpath(entrypoint)}|--port|55234|--host|127.0.0.1|${await realpath(runtimeRoot)}|${dirname(canonicalNodePath)}`)
      await expect(adapter.inspectListeners({ pid: 123, executable: canonicalNodePath })).resolves.toEqual(['127.0.0.1:55234'])
      await expect(adapter.isReady('http://127.0.0.1:55234/')).resolves.toBe(true)
      await adapter.stop({ pid: 123, executable: canonicalNodePath })
      expect(calls).toContain('stop:dbgate-process')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('refuses an entrypoint outside the DbGate runtime before supervisor start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-process-'))
    try {
      const runtimeRoot = join(root, '.backend-team/runtime/dbgate')
      const nodePath = join(root, '.backend-team/runtime/nvm/bin/node')
      const preload = join(runtimeRoot, 'preload.cjs')
      await mkdir(join(root, '.backend-team/runtime/nvm/bin'), { recursive: true })
      await mkdir(runtimeRoot, { recursive: true })
      await Promise.all([writeFile(nodePath, ''), writeFile(preload, ''), writeFile(join(root, 'outside.js'), '')])
      const start = vi.fn(async () => { throw new Error('must not start') })
      const adapter = new WorkspaceDbGateProcessAdapter({ workspaceRoot: root, runtimeRoot, nodeExecutable: nodePath, preloadPath: preload, supervisor: { start, stop: async () => undefined } })
      await expect(adapter.start(join(root, 'outside.js'), [], runtimeRoot, {})).rejects.toThrow(/runtime|workspace|path/i)
      expect(start).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
