import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BackendTeamState, PolicyContext } from '@dsh-backend-team/contracts'
import { FileStateStore, sha256Canonical, sha256WorkspaceTree } from '@dsh-backend-team/core'
import { createWorkspaceLayout, initializeWorkspaceLayout } from '@dsh-backend-team/platform-macos'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalTokenService } from '../src/approval-token.js'
import { InstallSessionService, __setInstallSessionTestHooksForTest, installApprovalAction, type ApprovedInstallSession, type InstallPlan } from '../src/install-session.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(expectedExecutableSha256?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-install-session-')); roots.push(root)
  const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
  const store = new FileStateStore(root)
  const state: BackendTeamState = { schemaVersion: 1, revision: 0, workspaceRoot: store.workspaceRoot, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] }
  await store.create(state)
  const executable = join(root, 'runtime-tool')
  await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o700)
  const commandBase = { executable, args: ['tool', 'install'], cwd: root, env: { UV_NO_SYNC: '1' }, codeWillExecute: true, networkPolicy: 'deny' as const, ...(expectedExecutableSha256 === undefined ? {} : { expectedExecutableSha256 }) }
  const command = { ...commandBase, executionFingerprint: sha256Canonical(commandBase) } as const
  const artifactBytes = Buffer.from('payload'); const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex')
  const plan: InstallPlan = { intent: 'runtime-install', tool: 'local-runtime', version: '1.0.0', source: 'https://github.com/example/runtime', license: 'MIT', destination: '.backend-team/runtime/local-runtime', artifacts: [{ component: 'local-runtime', version: '1.0.0', source: 'https://github.com/example/runtime', license: 'MIT', url: 'https://releases.example.test/runtime.tar.gz', bytes: artifactBytes.length, sha256: artifactSha256, allowedHosts: ['releases.example.test'], destination: '.backend-team/runtime/local-runtime.tar.gz' }, { component: 'local-dependency', version: '1.0.0', source: 'https://github.com/example/runtime', license: 'MIT', url: 'https://releases.example.test/dependency.tar.gz', bytes: artifactBytes.length, sha256: artifactSha256, allowedHosts: ['releases.example.test'], destination: '.backend-team/runtime/dependency.tar.gz' }], commands: [command], managedPaths: [] }
  for (const artifact of plan.artifacts) { await writeFile(join(root, artifact.destination), artifactBytes, { mode: 0o600 }); await chmod(join(root, artifact.destination), 0o600) }
  const context: PolicyContext = { phase: 'BUILD', workspace: layout }
  const tokens = new ApprovalTokenService(store, { now: () => new Date('2026-08-25T00:00:00.000Z'), randomBytes: () => Buffer.alloc(32, 6), tokenId: () => 'session-token-1234' })
  const token = await tokens.issue({ kind: 'install', workspaceRoot: root, context, action: installApprovalAction(plan), expiresAt: '2026-08-25T00:10:00.000Z' })
  return { root: await realpath(root), context, command, plan, store, token, tokens, service: new InstallSessionService(tokens) }
}

describe('InstallSessionService', () => {
  it('rejects a hand-built spec-kit-init plan without the complete managed preconditions before token consumption', async () => {
    const { command, context, plan, root, service, store, token } = await fixture()
    const init: InstallPlan = { ...plan, intent: 'spec-kit-init', managedPaths: [], commands: [{ ...command, executable: join(root, '.backend-team/runtime/spec-kit/.venv/bin/specify'), args: ['init'], expectedExecutableSha256: 'c'.repeat(64) }] }

    await expect(service.execute(token, { workspaceRoot: root, context, plan: init }, async () => undefined)).rejects.toThrow(/managed precondition/i)
    expect((await store.load())!.approvalTokens[0]!.usedAt).toBeNull()
  })
  it('permits only the exact approved artifact and command while the callback is active', async () => {
    const { command, context, plan, root, service, token } = await fixture()
    const fetch = vi.fn(async () => 'fetched')
    const spawn = vi.fn(async () => 'spawned')

    const result = await service.execute(token, { workspaceRoot: root, context, plan }, async (session) => ({
      artifact: await session.artifacts.executeApprovedArtifact(scope(plan, root), new AbortController().signal, fetch),
      command: await session.commands.executeApprovedInstallCommand(command, spawn),
    }))

    expect(result).toEqual({ artifact: 'fetched', command: 'spawned' })
    expect(fetch).toHaveBeenCalledOnce(); expect(spawn).toHaveBeenCalledOnce()
  })

  it.each([
    ['url', (plan: InstallPlan) => ({ ...plan.artifacts[0]!, url: 'https://evil.example.test/runtime.tar.gz' })],
    ['host list', (plan: InstallPlan) => ({ ...plan.artifacts[0]!, allowedHosts: ['evil.example.test'] })],
    ['component', (plan: InstallPlan) => ({ ...plan.artifacts[0]!, component: 'evil-runtime' })],
    ['source', (plan: InstallPlan) => ({ ...plan.artifacts[0]!, source: 'https://evil.example.test/source' })],
    ['bytes', (plan: InstallPlan) => ({ ...plan.artifacts[0]!, bytes: 8 })],
    ['hash', (plan: InstallPlan) => ({ ...plan.artifacts[0]!, sha256: 'c'.repeat(64) })],
  ])('rejects an altered artifact %s without fetching', async (_name, mutate) => {
    const { context, plan, root, service, token } = await fixture(); const fetch = vi.fn(async () => 'fetched')
    await expect(service.execute(token, { workspaceRoot: root, context, plan }, (session) => session.artifacts.executeApprovedArtifact(scope(plan, root, mutate(plan)), new AbortController().signal, fetch))).rejects.toThrow(/approved artifact/i)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a runtime command that omits the deny-network policy before token consumption', async () => {
    const { context, plan, root, service, store, token } = await fixture(); const command = { ...plan.commands[0]! } as Record<string, unknown>
    delete command.networkPolicy
    await expect(service.execute(token, { workspaceRoot: root, context, plan: { ...plan, commands: [command as unknown as InstallPlan['commands'][number]] } }, async () => undefined)).rejects.toThrow(/network|unexpected/i)
    expect((await store.load())!.approvalTokens[0]!.usedAt).toBeNull()
  })

  it('rejects an altered artifact destination without fetching', async () => {
    const { context, plan, root, service, token } = await fixture(); const fetch = vi.fn(async () => 'fetched')
    await expect(service.execute(token, { workspaceRoot: root, context, plan }, (session) => session.artifacts.executeApprovedArtifact({ ...scope(plan, root), destination: join(root, '.backend-team/runtime/other') }, new AbortController().signal, fetch))).rejects.toThrow(/approved artifact/i)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['args', (command: InstallPlan['commands'][number], root: string) => { void root; return { ...command, args: ['tool', 'run'] } }],
    ['env', (command: InstallPlan['commands'][number], root: string) => { void root; return { ...command, env: { UV_NO_SYNC: '0' } } }],
    ['cwd', (command: InstallPlan['commands'][number], root: string) => ({ ...command, cwd: join(root, '.backend-team') })],
    ['fingerprint', (command: InstallPlan['commands'][number], root: string) => { void root; return { ...command, executionFingerprint: 'd'.repeat(64) } }],
  ])('rejects an altered command %s without spawning', async (_name, mutate) => {
    const { context, plan, root, service, token } = await fixture(); const spawn = vi.fn(async () => 'spawned')
    await expect(service.execute(token, { workspaceRoot: root, context, plan }, (session) => session.commands.executeApprovedInstallCommand(mutate(plan.commands[0]!, root), spawn))).rejects.toThrow(/approved command/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects an executable whose actual bytes no longer match the approved digest before callback/spawn', async () => {
    const { context, plan, root, service, token } = await fixture('f'.repeat(64))
    const spawn = vi.fn(async () => 'spawned')
    await expect(service.execute(token, { workspaceRoot: root, context, plan }, (session) => session.commands.executeApprovedInstallCommand(plan.commands[0]!, spawn))).rejects.toThrow(/identity changed/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('requires the complete verified artifact closure before the first command', async () => {
    const { command, context, plan, root, service, token } = await fixture()
    const spawn = vi.fn(async () => 'spawned')
    await rm(join(root, plan.artifacts[1]!.destination))

    await expect(service.execute(token, { workspaceRoot: root, context, plan }, (session) => session.commands.executeApprovedInstallCommand(command, spawn))).rejects.toThrow(/artifact.*missing/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('revalidates every artifact after a command before returning success', async () => {
    const { command, context, plan, root, service, token } = await fixture()
    const target = join(root, plan.artifacts[0]!.destination)
    const spawn = vi.fn(async () => { await writeFile(target, 'altered', { mode: 0o600 }); return 'spawned' })

    await expect(service.execute(token, { workspaceRoot: root, context, plan }, (session) => session.commands.executeApprovedInstallCommand(command, spawn))).rejects.toThrow(/artifact.*changed/i)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('rejects a callback command that omits the approved executable SHA before spawn', async () => {
    const expectedExecutableSha256 = createHash('sha256').update('#!/bin/sh\nexit 0\n').digest('hex')
    const { context, plan, root, service, token } = await fixture(expectedExecutableSha256)
    const spawn = vi.fn(async () => 'spawned')
    const withoutExpectedSha = { ...plan.commands[0]! }
    Reflect.deleteProperty(withoutExpectedSha, 'expectedExecutableSha256')

    await expect(service.execute(token, { workspaceRoot: root, context, plan }, (session) => session.commands.executeApprovedInstallCommand(withoutExpectedSha, spawn))).rejects.toThrow(/approved command/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a callback command with a replaced executable SHA before spawn', async () => {
    const expectedExecutableSha256 = createHash('sha256').update('#!/bin/sh\nexit 0\n').digest('hex')
    const { context, plan, root, service, token } = await fixture(expectedExecutableSha256)
    const spawn = vi.fn(async () => 'spawned')
    const replaced = { ...plan.commands[0]!, expectedExecutableSha256: 'e'.repeat(64) }

    await expect(service.execute(token, { workspaceRoot: root, context, plan }, (session) => session.commands.executeApprovedInstallCommand(replaced, spawn))).rejects.toThrow(/approved command/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('allows approved-host redirects but rejects changed command scope and leaked capabilities', async () => {
    const { command, context, plan, root, service, token } = await fixture(); let leaked: ApprovedInstallSession | undefined
    const fetch = vi.fn(async () => 'redirect'); const spawn = vi.fn(async () => 'spawned')
    await service.execute(token, { workspaceRoot: root, context, plan }, async (session) => {
      leaked = session
      await expect(session.artifacts.executeApprovedArtifact(scope(plan, root, { ...plan.artifacts[0]!, url: 'https://releases.example.test/redirected' }), new AbortController().signal, fetch)).resolves.toBe('redirect')
      await expect(session.commands.executeApprovedInstallCommand({ ...command, env: { UV_NO_SYNC: '0' } }, spawn)).rejects.toThrow(/approved command/i)
    })
    await expect(leaked!.artifacts.executeApprovedArtifact(scope(plan, root), new AbortController().signal, fetch)).rejects.toThrow(/closed|inactive/i)
    expect(spawn).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce()
  })

  it('consumes the plan-bound token once and revokes capabilities when its callback throws', async () => {
    const { context, plan, root, service, token } = await fixture(); let leaked: ApprovedInstallSession | undefined
    await expect(service.execute(token, { workspaceRoot: root, context, plan }, async (session) => { leaked = session; throw new Error('abort') })).rejects.toThrow('abort')
    await expect(service.execute(token, { workspaceRoot: root, context, plan }, async () => undefined)).rejects.toThrow(/rejected/i)
    await expect(leaked!.commands.executeApprovedInstallCommand(plan.commands[0]!, async () => undefined)).rejects.toThrow(/closed|inactive/i)
  })

  it('snapshots a plan before token consumption and rejects a mutation before fetch or spawn', async () => {
    const { context, plan, root, service, token } = await fixture()
    const mutablePlan = { ...plan, commands: [{ ...plan.commands[0]!, args: [...plan.commands[0]!.args], env: { ...plan.commands[0]!.env } }] }
    const fetch = vi.fn(async () => 'fetched'); const spawn = vi.fn(async () => 'spawned')
    const restore = __setInstallSessionTestHooksForTest({ afterPlanSnapshot: async () => {
      mutablePlan.commands[0]!.args = ['tool', 'evil']
      mutablePlan.commands[0]!.env = { UV_NO_SYNC: '0' }
    } })
    try {
      await expect(service.execute(token, { workspaceRoot: root, context, plan: mutablePlan }, async (session) => {
        await session.commands.executeApprovedInstallCommand(mutablePlan.commands[0]!, spawn)
        return session.artifacts.executeApprovedArtifact(scope(mutablePlan, root), new AbortController().signal, fetch)
      })).rejects.toThrow(/approved command/i)
    } finally { restore() }
    expect(spawn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the command snapshot captured before asynchronous verification', async () => {
    const { command, context, plan, root, service, token } = await fixture()
    const mutable = { executable: command.executable, args: [...command.args] as string[], cwd: command.cwd, env: { ...command.env } as Record<string, string>, executionFingerprint: command.executionFingerprint, codeWillExecute: command.codeWillExecute, networkPolicy: command.networkPolicy }
    const spawn = vi.fn(async (evidence) => evidence)
    const restore = __setInstallSessionTestHooksForTest({ afterCommandSnapshot: async () => {
      mutable.args = ['tool', 'evil']; mutable.env = { UV_NO_SYNC: '0' }
    } })
    try {
      const evidence = await service.execute(token, { workspaceRoot: root, context, plan }, (session) => session.commands.executeApprovedInstallCommand(mutable, spawn))
      expect(evidence).toMatchObject({ args: ['tool', 'install'], env: { UV_NO_SYNC: '1' } })
    } finally { restore() }
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('settles a fire-and-forget command before returning and blocks its late spawn', async () => {
    const { command, context, plan, root, service, token } = await fixture()
    let release: (() => void) | undefined
    const entered = new Promise<void>((resolve) => { release = resolve })
    let reached: (() => void) | undefined
    const started = new Promise<void>((resolve) => { reached = resolve })
    const spawn = vi.fn(async () => 'spawned')
    const restore = __setInstallSessionTestHooksForTest({ afterCommandSnapshot: async () => { reached!(); await entered } })
    let inFlight: Promise<unknown> | undefined
    try {
      const execution = service.execute(token, { workspaceRoot: root, context, plan }, async (session) => {
        inFlight = session.commands.executeApprovedInstallCommand(command, spawn)
      })
      await started
      release!()
      await expect(execution).resolves.toBeUndefined()
      await expect(inFlight).rejects.toThrow(/closed|inactive/i)
    } finally { restore() }
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    ['init', ['init']],
    ['init with force', ['init', '--force']],
    ['force before init', ['--force', 'init']],
  ])('rejects hand-built runtime-install plans containing specify %s before token consumption', async (_name, args) => {
    const { command, context, plan, root, service, store, token } = await fixture()
    const violating: InstallPlan = { ...plan, commands: [{ ...command, executable: join(root, '.venv', 'bin', 'specify'), args }] }
    const fetch = vi.fn(async () => 'fetched'); const spawn = vi.fn(async () => 'spawned')
    const callback = vi.fn(async (session: ApprovedInstallSession) => {
      await session.artifacts.executeApprovedArtifact(scope(violating, root), new AbortController().signal, fetch)
      return session.commands.executeApprovedInstallCommand(violating.commands[0]!, spawn)
    })

    expect(() => installApprovalAction(violating)).toThrow(/specify init.*separate/i)
    await expect(service.execute(token, { workspaceRoot: root, context, plan: violating }, callback)).rejects.toThrow(/specify init.*separate/i)
    expect(callback).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
    expect((await store.load())!.approvalTokens[0]!.usedAt).toBeNull()
  })

  it('rejects a weak hand-built spec-kit-init plan before an approval action can be derived', async () => {
    const { command, plan, root } = await fixture()
    const initPlan: InstallPlan = { ...plan, intent: 'spec-kit-init', managedPaths: [{ path: '.specify', state: 'missing' }, { path: '.backend-team/runtime/spec-kit/commands', state: 'missing' }], commands: [{ ...command, executable: join(root, '.venv', 'bin', 'specify'), args: ['init'], expectedExecutableSha256: 'c'.repeat(64) }] }
    expect(() => installApprovalAction(initPlan)).toThrow(/managed|pinned|contract|fingerprint/i)
  })

  it('rechecks the approved Python and venv execution closure before the init callback can spawn', async () => {
    const { context, root, store } = await fixture()
    const pythonRoot = join(root, '.backend-team/runtime/python'); const venv = join(root, '.backend-team/runtime/spec-kit/.venv'); const specify = join(venv, 'bin/specify'); const module = join(venv, 'lib/python3.13/site-packages/specify_cli/main.py')
    await mkdir(join(pythonRoot, '3.13.15/bin'), { recursive: true }); await mkdir(join(venv, 'bin'), { recursive: true }); await mkdir(join(venv, 'lib/python3.13/site-packages/specify_cli'), { recursive: true })
    await writeFile(join(pythonRoot, '3.13.15/bin/python3.13'), 'python', { mode: 0o700 }); await writeFile(specify, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); await writeFile(join(venv, 'pyvenv.cfg'), `home = ${join(pythonRoot, '3.13.15/bin')}\nimplementation = CPython\nuv = 0.12.3\nversion_info = 3.13.15\ninclude-system-site-packages = false\n`); await writeFile(module, 'trusted')
    const paths = ['.backend-team/runtime/python', '.backend-team/runtime/spec-kit/.venv'] as const
    const runtimeClosure = await Promise.all(paths.map(async (path) => ({ path, sha256: await sha256WorkspaceTree(root, path, paths) })))
    const expectedExecutableSha256 = createHash('sha256').update('#!/bin/sh\nexit 0\n').digest('hex'); const env = specKitEnvironment(root)
    const base = { executable: specify, args: ['init', '--here', '--force', '--non-interactive', '--script', 'sh', '--integration', 'generic', '--integration-options=--commands-dir .backend-team/runtime/spec-kit/commands', '--ignore-agent-tools'], cwd: root, env, codeWillExecute: true as const, networkPolicy: 'deny' as const, expectedExecutableSha256 }
    const plan: InstallPlan = { intent: 'spec-kit-init', tool: 'specify-cli', version: '0.16.5', source: 'https://github.com/github/spec-kit/tree/v0.16.5', license: 'MIT', destination: '.specify', artifacts: [], managedPaths: [{ path: '.backend-team/runtime/spec-kit/commands', state: 'missing' }, { path: '.specify', state: 'missing' }], runtimeClosure, commands: [{ ...base, executionFingerprint: sha256Canonical(base) }] }
    const tokens = new ApprovalTokenService(store, { now: () => new Date('2026-08-25T00:00:00.000Z'), randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'closure-token-1234' })
    const token = await tokens.issue({ kind: 'install', workspaceRoot: root, context, action: installApprovalAction(plan), expiresAt: '2026-08-25T00:10:00.000Z' })
    await writeFile(module, 'tampered')
    const callback = vi.fn(async () => undefined)

    await expect(new InstallSessionService(tokens).execute(token, { workspaceRoot: root, context, plan }, callback)).rejects.toThrow(/runtime closure.*changed/i)
    expect(callback).not.toHaveBeenCalled()
    expect((await store.load())!.approvalTokens.find((entry) => entry.tokenId === 'closure-token-1234')!.usedAt).toBeNull()
  })

  it('rejects an actual NUL byte in a managed path before deriving an approval action', async () => {
    const { root } = await fixture()
    const expectedExecutableSha256 = createHash('sha256').update('#!/bin/sh\nexit 0\n').digest('hex')
    const executable = join(root, '.backend-team/runtime/spec-kit/.venv/bin/specify')
    const env = specKitEnvironment(root)
    const base = { executable, args: ['init', '--here', '--force', '--non-interactive', '--script', 'sh', '--integration', 'generic', '--integration-options=--commands-dir .backend-team/runtime/spec-kit/commands', '--ignore-agent-tools'], cwd: root, env, codeWillExecute: true as const, networkPolicy: 'deny' as const, expectedExecutableSha256 }
    const initPlan: InstallPlan = { intent: 'spec-kit-init', tool: 'specify-cli', version: '0.16.5', source: 'https://github.com/github/spec-kit/tree/v0.16.5', license: 'MIT', destination: '.specify', artifacts: [], managedPaths: [{ path: '.backend-team/runtime/spec-kit/commands', state: 'missing' }, { path: '.specify', state: 'missing' }, { path: '.specify/unsafe\0path', state: 'missing' }], runtimeClosure: [{ path: '.backend-team/runtime/python', sha256: 'a'.repeat(64) }, { path: '.backend-team/runtime/spec-kit/.venv', sha256: 'b'.repeat(64) }], commands: [{ ...base, executionFingerprint: sha256Canonical(base) }] }

    expect(() => installApprovalAction(initPlan)).toThrow(/managed precondition/i)
  })
})

function scope(plan: InstallPlan, root: string, artifact = plan.artifacts[0]!): { component: string; version: string; license: string; source: string; url: string; allowedHosts: readonly string[]; destination: string; bytes: number; sha256: string } {
  return { component: artifact.component, version: artifact.version, license: artifact.license, source: artifact.source, url: artifact.url, allowedHosts: artifact.allowedHosts, destination: join(root, artifact.destination), bytes: artifact.bytes, sha256: artifact.sha256 }
}

function specKitEnvironment(root: string): Readonly<Record<string, string>> {
  const base = join(root, '.backend-team')
  const bin = join(base, 'runtime/bin')
  return { HOME: base, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: join(base, 'cache'), XDG_CACHE_HOME: join(base, 'cache'), XDG_CONFIG_HOME: join(base, 'state'), XDG_DATA_HOME: join(base, 'runtime'), XDG_STATE_HOME: join(base, 'state'), UV_PROJECT_ENVIRONMENT: join(base, 'runtime/spec-kit/.venv'), UV_CACHE_DIR: join(base, 'cache/uv'), UV_PYTHON_INSTALL_DIR: join(base, 'runtime/python'), UV_PYTHON_BIN_DIR: bin, UV_PYTHON_INSTALL_BIN: '0', UV_TOOL_DIR: join(base, 'runtime/uv-tools'), UV_TOOL_BIN_DIR: bin, UV_NO_SYSTEM_CONFIG: '1', UV_NO_CONFIG: '1', UV_NO_MODIFY_PATH: '1', UV_PYTHON_PREFERENCE: 'only-managed', UV_PYTHON_DOWNLOADS: 'manual', UV_PYTHON_INSTALL_MIRROR: pathToFileURL(join(base, 'cache/python-mirror')).href, UV_OFFLINE: '1', PIP_CONFIG_FILE: '/dev/null', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
}
