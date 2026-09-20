import { createHash } from 'node:crypto'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { FileStateStore, sha256Canonical } from '@dsh-backend-team/core'
import type { CommandExecutor } from '@dsh-backend-team/platform-macos'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstallPlan } from '../src/install-plan.js'
import {
  __createRealSpecKitGateDependenciesForTest,
  createRealSpecKitGateDependencies,
  createRealSpecKitGateOptionsFromEnvironment,
  parseRealGateApprovalMaterial,
  runRealSpecKitGate,
  type RealGateBlocked,
} from '../src/spec-kit-real-gate.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('concrete real Spec Kit gate', () => {
  it('accepts only a strict, separately named approval material', () => {
    const digest = 'a'.repeat(64)
    expect(parseRealGateApprovalMaterial(JSON.stringify({ schemaVersion: 1, intent: 'runtime-install', approvalDigest: digest }), 'runtime-install')).toEqual({ schemaVersion: 1, intent: 'runtime-install', approvalDigest: digest })
    expect(() => parseRealGateApprovalMaterial(JSON.stringify({ schemaVersion: 1, intent: 'spec-kit-init', approvalDigest: digest }), 'runtime-install')).toThrow(/schema/i)
    expect(() => parseRealGateApprovalMaterial(JSON.stringify({ schemaVersion: 1, intent: 'runtime-install', approvalDigest: digest, secret: 'no' }), 'runtime-install')).toThrow(/schema/i)
  })

  it('reports a machine-readable block when the strict persistent gate roots are missing', async () => {
    await expect(createRealSpecKitGateOptionsFromEnvironment({})).rejects.toSatisfy((error: unknown) => blocked(error).reason === 'MISSING_REAL_GATE_ENVIRONMENT')
  })

  it('does not create a supplied missing gate root while reporting an invalid environment block', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-real-gate-missing-root-')))
    roots.push(root)
    const gateRoot = join(root, 'missing-gate')

    await expect(createRealSpecKitGateOptionsFromEnvironment({
      DSH_REAL_SPEC_KIT_GATE_ROOT: gateRoot,
      DSH_REAL_SPEC_KIT_WORKSPACE: join(gateRoot, 'workspace'),
    })).rejects.toSatisfy((error: unknown) => blocked(error).reason === 'INVALID_REAL_GATE_ENVIRONMENT')

    await expect(access(gateRoot)).rejects.toThrow()
  })

  it('requires the caller to preprovision the exact canonical workspace without changing the gate root', async () => {
    const fixture = await gateFixtureRoot({ workspace: false })
    const before = await exactTree(fixture.gateRoot)

    await expect(createRealSpecKitGateDependencies({
      gateRoot: fixture.gateRoot,
      workspaceRoot: fixture.workspaceRoot,
      repositoryRoot: fixture.repositoryRoot,
      platform: 'darwin',
      architecture: 'arm64',
    })).rejects.toThrow(/workspace/i)

    expect(await exactTree(fixture.gateRoot)).toBe(before)
    await expect(access(fixture.workspaceRoot)).rejects.toThrow()
  })

  it.each(['fake-home', 'fake-global-bin', 'parent-sentinel.txt'] as const)('requires the caller to preprovision %s without creating it', async (relativePath) => {
    const fixture = await gateFixtureRoot()
    const target = join(fixture.gateRoot, relativePath)
    await rm(target, { recursive: true })
    const before = await exactTree(fixture.gateRoot)

    await expect(createRealSpecKitGateDependencies({
      gateRoot: fixture.gateRoot,
      workspaceRoot: fixture.workspaceRoot,
      repositoryRoot: fixture.repositoryRoot,
      platform: 'darwin',
      architecture: 'arm64',
    })).rejects.toThrow()

    expect(await exactTree(fixture.gateRoot)).toBe(before)
    await expect(access(target)).rejects.toThrow()
  })

  it('builds the complete seven-command offline runtime plan with canonical fingerprints', async () => {
    const fixture = await offlineGate()
    const plan = await fixture.dependencies.runtimePlan()
    const runtime = join(fixture.workspaceRoot, '.backend-team/runtime')
    const uv = join(runtime, 'bin/uv')
    const venv = join(runtime, 'spec-kit/.venv')
    const python = join(venv, 'bin/python')
    const specify = join(venv, 'bin/specify')
    const cache = join(fixture.workspaceRoot, '.backend-team/cache')
    const env = { HOME: join(fixture.workspaceRoot, '.backend-team'), PATH: `${join(runtime, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: cache, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: join(fixture.workspaceRoot, '.backend-team/state'), XDG_DATA_HOME: runtime, XDG_STATE_HOME: join(fixture.workspaceRoot, '.backend-team/state'), UV_PROJECT_ENVIRONMENT: venv, UV_CACHE_DIR: join(cache, 'uv'), UV_PYTHON_INSTALL_DIR: join(runtime, 'python'), UV_PYTHON_BIN_DIR: join(runtime, 'bin'), UV_PYTHON_INSTALL_BIN: '0', UV_TOOL_DIR: join(runtime, 'uv-tools'), UV_TOOL_BIN_DIR: join(runtime, 'bin'), UV_NO_SYSTEM_CONFIG: '1', UV_NO_CONFIG: '1', UV_NO_MODIFY_PATH: '1', UV_PYTHON_PREFERENCE: 'only-managed', UV_PYTHON_DOWNLOADS: 'manual', UV_PYTHON_INSTALL_MIRROR: `file://${join(cache, 'python-mirror')}`, UV_OFFLINE: '1', PIP_CONFIG_FILE: '/dev/null', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
    const wheelPaths = plan.artifacts.filter((artifact) => artifact.component !== 'uv' && artifact.component !== 'python').map((artifact) => join(fixture.workspaceRoot, artifact.destination))

    expect(plan).toMatchObject({ intent: 'runtime-install', tool: 'uv', version: '0.12.3', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', license: 'Apache-2.0 OR MIT', destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz', managedPaths: [] })
    expect(plan.artifacts[0]).toMatchObject({ component: 'uv', allowedHosts: ['releases.example.test'] })
    expect(plan.artifacts).toHaveLength(17)
    expect(plan.commands.map(({ executable, args, cwd, env: commandEnv, codeWillExecute, networkPolicy }) => ({ executable, args, cwd, env: commandEnv, codeWillExecute, networkPolicy }))).toEqual([
      { executable: uv, args: ['--version'], cwd: join(runtime, 'bin'), env, codeWillExecute: true, networkPolicy: 'deny' },
      { executable: uv, args: ['python', 'install', '--offline', '3.13.15'], cwd: join(runtime, 'bin'), env, codeWillExecute: true, networkPolicy: 'deny' },
      { executable: uv, args: ['venv', '--offline', '--python', '3.13.15', venv], cwd: join(runtime, 'bin'), env, codeWillExecute: true, networkPolicy: 'deny' },
      { executable: python, args: ['--version'], cwd: join(venv, 'bin'), env, codeWillExecute: true, networkPolicy: 'deny' },
      { executable: uv, args: ['pip', 'install', '--offline', '--no-index', '--no-deps', '--python', python, ...wheelPaths], cwd: join(runtime, 'bin'), env, codeWillExecute: true, networkPolicy: 'deny' },
      { executable: uv, args: ['pip', 'check', '--offline', '--python', python], cwd: join(runtime, 'bin'), env, codeWillExecute: true, networkPolicy: 'deny' },
      { executable: specify, args: ['--version'], cwd: join(venv, 'bin'), env, codeWillExecute: true, networkPolicy: 'deny' },
    ])
    for (const command of plan.commands) {
      const { executionFingerprint, ...base } = command
      expect(executionFingerprint).toBe(sha256Canonical(base))
    }
    expect(fixture.fetches).toBe(0)
    expect(fixture.commands).toHaveLength(0)
  })

  it('does not mint a token, fetch, or execute when runtime approval is absent', async () => {
    const fixture = await offlineGate()
    const before = fixture.beforeDependencyCreation

    expect(fixture.afterDependencyCreation).toBe(before)
    expect(await exactTree(fixture.gateRoot)).toBe(before)

    await expect(runRealSpecKitGate({ dependencies: fixture.dependencies })).rejects.toSatisfy((error: unknown) => blocked(error).reason === 'MISSING_OR_MISMATCHED_RUNTIME-INSTALL_APPROVAL')
    await expect(runRealSpecKitGate({ runtimeMaterial: JSON.stringify({ schemaVersion: 1, intent: 'runtime-install', approvalDigest: 'f'.repeat(64) }), dependencies: fixture.dependencies })).rejects.toSatisfy((error: unknown) => blocked(error).reason === 'MISSING_OR_MISMATCHED_RUNTIME-INSTALL_APPROVAL')

    expect(await exactTree(fixture.gateRoot)).toBe(before)
    expect(fixture.fetches).toBe(0)
    expect(fixture.commands).toHaveLength(0)
    await expect(access(join(fixture.workspaceRoot, '.backend-team'))).rejects.toThrow()
    await expect(access(join(fixture.gateRoot, 'parent-sentinel.txt'))).resolves.toBeUndefined()
  })

  it('retains runtime after the init-plan block, then resumes with fresh tokens and loads all five official commands', async () => {
    const fixture = await offlineGate()
    const runtimePlan = await fixture.dependencies.runtimePlan()
    const runtimeMaterial = material('runtime-install', runtimePlan)
    const outsideBefore = await fixture.dependencies.outsideSnapshot()

    let initBlocked: RealGateBlocked | undefined
    try {
      await runRealSpecKitGate({ runtimeMaterial, dependencies: fixture.dependencies })
    } catch (error: unknown) {
      initBlocked = blocked(error)
    }

    expect(initBlocked).toMatchObject({ status: 'BLOCKED', reason: 'MISSING_OR_MISMATCHED_SPEC-KIT-INIT_APPROVAL', approvalDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), plan: { intent: 'spec-kit-init' } })
    expect(await fixture.dependencies.outsideSnapshot()).toBe(outsideBefore)
    expect(fixture.fetches).toBe(17)
    expect(fixture.commands).toHaveLength(7)
    await expect(access(join(fixture.workspaceRoot, '.specify'))).rejects.toThrow()

    const resumed = await fixture.reopen()
    const initMaterial = JSON.stringify({ schemaVersion: 1, intent: 'spec-kit-init', approvalDigest: initBlocked!.approvalDigest })
    await runRealSpecKitGate({ runtimeMaterial, initMaterial, dependencies: resumed })

    expect(fixture.fetches).toBe(17)
    const evidence = JSON.parse(await readFile(join(fixture.workspaceRoot, '.backend-team/logs/spec-kit-real-gate-evidence.json'), 'utf8')) as Record<string, unknown>
    expect(evidence).toMatchObject({ schemaVersion: 1, runtime: { uv: '0.12.3', python: '3.13.15', specKit: '0.16.5' }, outside: { beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), status: 'unchanged' } })
    expect((evidence.outside as { beforeSha256: string; afterSha256: string }).afterSha256).toBe((evidence.outside as { beforeSha256: string; afterSha256: string }).beforeSha256)
    expect(Object.keys(evidence.commandSourceSha256 as Record<string, string>).sort()).toEqual(['speckit.analyze', 'speckit.clarify', 'speckit.plan', 'speckit.specify', 'speckit.tasks'])
    expect(JSON.stringify(evidence)).not.toContain('DSH_REAL_')
    const state = await new FileStateStore(fixture.workspaceRoot).load()
    expect(state?.approvalTokens).toHaveLength(3)
    const persisted = (await readTree(fixture.workspaceRoot)).toString('latin1')
    expect(persisted).not.toContain('dsh-at1.')
    expect(persisted).not.toContain(runtimeMaterial)
    expect(persisted).not.toContain(initMaterial)
  })

  it('fails after real loader execution when an approved command mutates a gate-root sentinel outside the workspace', async () => {
    const fixture = await offlineGate({ mutateOutsideOnInit: true })
    const runtimePlan = await fixture.dependencies.runtimePlan()
    const runtimeMaterial = material('runtime-install', runtimePlan)
    let initBlocked: RealGateBlocked | undefined
    try { await runRealSpecKitGate({ runtimeMaterial, dependencies: fixture.dependencies }) } catch (error: unknown) { initBlocked = blocked(error) }
    const resumed = await fixture.reopen()

    await expect(runRealSpecKitGate({ runtimeMaterial, initMaterial: JSON.stringify({ schemaVersion: 1, intent: 'spec-kit-init', approvalDigest: initBlocked!.approvalDigest }), dependencies: resumed })).rejects.toThrow(/isolation snapshot changed/i)
    await expect(access(join(fixture.workspaceRoot, '.backend-team/logs/spec-kit-real-gate-evidence.json'))).rejects.toThrow()
  })

  it('reports runtime isolation failure before the missing init approval when runtime creates an arbitrary outside path', async () => {
    const fixture = await offlineGate({ mutateOutsideOnRuntime: async (gateRoot) => {
      await mkdir(join(gateRoot, 'runtime-escape/deep'), { recursive: true })
      await writeFile(join(gateRoot, 'runtime-escape/deep/written.txt'), 'outside\n')
    } })
    const runtimePlan = await fixture.dependencies.runtimePlan()

    await expect(runRealSpecKitGate({ runtimeMaterial: material('runtime-install', runtimePlan), dependencies: fixture.dependencies })).rejects.toThrow(/^real gate isolation snapshot changed outside its workspace$/u)
    await expect(access(join(fixture.workspaceRoot, '.specify'))).rejects.toThrow()
  })

  it('detects same-bytes and same-mode replacement of an outside file by inode identity', async () => {
    let originalIdentity: { readonly dev: number; readonly ino: number; readonly mode: number } | undefined
    const fixture = await offlineGate({ mutateOutsideOnRuntime: async (gateRoot) => {
      const target = join(gateRoot, 'other-outside/nested/replacement.txt')
      const original = await lstat(target)
      originalIdentity = { dev: original.dev, ino: original.ino, mode: original.mode & 0o777 }
      const replacement = join(gateRoot, 'other-outside/nested/.replacement')
      await writeFile(replacement, await readFile(target), { mode: original.mode & 0o777 })
      await chmod(replacement, original.mode & 0o777)
      await rename(replacement, target)
    } })
    const runtimePlan = await fixture.dependencies.runtimePlan()

    await expect(runRealSpecKitGate({ runtimeMaterial: material('runtime-install', runtimePlan), dependencies: fixture.dependencies })).rejects.toThrow(/isolation snapshot changed/i)

    const replaced = await lstat(join(fixture.gateRoot, 'other-outside/nested/replacement.txt'))
    expect({ mode: replaced.mode & 0o777, bytes: await readFile(join(fixture.gateRoot, 'other-outside/nested/replacement.txt'), 'utf8') }).toEqual({ mode: originalIdentity!.mode, bytes: 'replace-me\n' })
    expect({ dev: replaced.dev, ino: replaced.ino }).not.toEqual({ dev: originalIdentity!.dev, ino: originalIdentity!.ino })
  })

  it.each([
    ['nested directory addition', async (gateRoot: string) => { await mkdir(join(gateRoot, 'other-outside/new/deep'), { recursive: true }) }],
    ['nested file addition', async (gateRoot: string) => { await writeFile(join(gateRoot, 'other-outside/nested/new.txt'), 'new\n') }],
    ['nested directory deletion', async (gateRoot: string) => { await rm(join(gateRoot, 'other-outside/nested/delete-dir'), { recursive: true }) }],
    ['nested file deletion', async (gateRoot: string) => { await rm(join(gateRoot, 'other-outside/nested/delete.txt')) }],
    ['nested directory permission change', async (gateRoot: string) => { await chmod(join(gateRoot, 'other-outside/nested/permissions-dir'), 0o500) }],
    ['nested file permission change', async (gateRoot: string) => { await chmod(join(gateRoot, 'other-outside/nested/permissions.txt'), 0o400) }],
    ['nested file content change', async (gateRoot: string) => { await writeFile(join(gateRoot, 'other-outside/nested/content.txt'), 'tampered\n') }],
  ] as const)('detects %s anywhere outside the workspace subtree', async (_label, mutateOutsideOnRuntime) => {
    const fixture = await offlineGate({ mutateOutsideOnRuntime })
    const runtimePlan = await fixture.dependencies.runtimePlan()

    await expect(runRealSpecKitGate({ runtimeMaterial: material('runtime-install', runtimePlan), dependencies: fixture.dependencies })).rejects.toThrow(/isolation snapshot changed/i)
  })
})

function blocked(error: unknown): RealGateBlocked {
  const value = JSON.parse(error instanceof Error ? error.message : String(error)) as RealGateBlocked
  expect(value).toMatchObject({ status: 'BLOCKED', gate: 'spec-kit-real-cli' })
  return value
}

function material(intent: 'runtime-install' | 'spec-kit-init', plan: InstallPlan): string {
  return JSON.stringify({ schemaVersion: 1, intent, approvalDigest: sha256Canonical(plan) })
}

async function offlineGate(options: { readonly mutateOutsideOnInit?: boolean; readonly mutateOutsideOnRuntime?: (gateRoot: string) => Promise<void> } = {}) {
  const fixture = await gateFixtureRoot()
  const { artifactBodies, gateRoot, manifests, repositoryRoot, workspaceRoot } = fixture
  const beforeDependencyCreation = await exactTree(gateRoot)
  let runtimeMutationApplied = false
  let fetches = 0
  const commands: { readonly executable: string; readonly args: readonly string[] }[] = []
  const request: typeof fetch = async (input) => {
    fetches += 1
    const body = artifactBodies.get(String(input))
    if (body === undefined) return new Response('missing fixture artifact', { status: 404 })
    return new Response(body, { headers: { 'content-length': String(body.length) } })
  }
  const executor: CommandExecutor = async (executable, args) => {
    commands.push({ executable, args: [...args] })
    const venv = join(workspaceRoot, '.backend-team/runtime/spec-kit/.venv')
    if (args[0] === 'python') {
      await mkdir(join(workspaceRoot, '.backend-team/runtime/python/3.13.15/bin'), { recursive: true })
      await writeExecutable(join(workspaceRoot, '.backend-team/runtime/python/3.13.15/bin/python3.13'), '#!/bin/sh\nexit 0\n')
    }
    if (args[0] === 'venv') {
      await mkdir(join(venv, 'bin'), { recursive: true })
      await writeExecutable(join(venv, 'bin/python'), '#!/bin/sh\nexit 0\n')
      await writeFile(join(venv, 'pyvenv.cfg'), `home = ${join(workspaceRoot, '.backend-team/runtime/python/3.13.15/bin')}\nimplementation = CPython\nuv = 0.12.3\nversion_info = 3.13.15\ninclude-system-site-packages = false\n`)
    }
    if (args[0] === 'pip') await writeExecutable(join(venv, 'bin/specify'), '#!/bin/sh\nexit 0\n')
    if (basename(executable) === 'specify' && args[0] === 'init') {
      await mkdir(join(workspaceRoot, '.specify'), { recursive: true })
      await writeFile(join(workspaceRoot, '.specify/integration.json'), officialIntegration())
      const commandDirectory = join(workspaceRoot, '.backend-team/runtime/spec-kit/commands')
      await mkdir(commandDirectory, { recursive: true })
      for (const id of ['speckit.specify', 'speckit.clarify', 'speckit.plan', 'speckit.tasks', 'speckit.analyze']) await writeFile(join(commandDirectory, `${id}.md`), `# ${id}\n$ARGUMENTS\n`)
      if (options.mutateOutsideOnInit === true) await writeFile(join(gateRoot, 'parent-sentinel.txt'), 'mutated\n')
    }
    if (!runtimeMutationApplied && options.mutateOutsideOnRuntime !== undefined && basename(executable) === 'specify' && args[0] === '--version') {
      runtimeMutationApplied = true
      await options.mutateOutsideOnRuntime(gateRoot)
    }
    const stdout = basename(executable) === 'uv' && args[0] === '--version' ? 'uv 0.12.3 (aarch64-apple-darwin)\n' : basename(executable) === 'python' && args[0] === '--version' ? 'Python 3.13.15\n' : basename(executable) === 'specify' && args[0] === '--version' ? 'specify 0.16.5\n' : ''
    return { exitCode: 0, stdout, stderr: '' }
  }
  const create = () => __createRealSpecKitGateDependenciesForTest({ gateRoot, workspaceRoot, repositoryRoot, platform: 'darwin', architecture: 'arm64', fetch: request, commandExecutor: executor, manifests })
  const dependencies = await create()
  const afterDependencyCreation = await exactTree(gateRoot)
  return { gateRoot, workspaceRoot, dependencies, beforeDependencyCreation, afterDependencyCreation, commands, get fetches() { return fetches }, reopen: create }
}

async function gateFixtureRoot(options: { readonly workspace?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-real-gate-fixture-')))
  roots.push(root)
  const repositoryRoot = join(root, 'repository')
  const gateRoot = join(root, 'gate')
  const workspaceRoot = join(gateRoot, 'workspace')
  await mkdir(join(repositoryRoot, 'runtime-manifests'), { recursive: true })
  await mkdir(gateRoot, { mode: 0o700 })
  if (options.workspace !== false) await mkdir(workspaceRoot, { mode: 0o700 })
  await mkdir(join(gateRoot, 'fake-home'), { mode: 0o700 })
  await mkdir(join(gateRoot, 'fake-global-bin'), { mode: 0o700 })
  await mkdir(join(gateRoot, 'other-outside/nested/delete-dir'), { recursive: true, mode: 0o700 })
  await mkdir(join(gateRoot, 'other-outside/nested/permissions-dir'), { mode: 0o700 })
  await chmod(join(gateRoot, 'other-outside'), 0o700)
  await chmod(join(gateRoot, 'other-outside/nested'), 0o700)
  await writeFile(join(gateRoot, 'parent-sentinel.txt'), 'dsh-real-gate-parent-sentinel-v1\n', { mode: 0o600 })
  await writeFile(join(gateRoot, 'fake-home/sentinel.txt'), 'dsh-real-gate-fake-home-v1\n', { mode: 0o600 })
  await writeFile(join(gateRoot, 'fake-global-bin/sentinel.txt'), 'dsh-real-gate-fake-global-bin-v1\n', { mode: 0o600 })
  await writeFile(join(gateRoot, 'other-outside/nested/delete.txt'), 'delete\n', { mode: 0o600 })
  await writeFile(join(gateRoot, 'other-outside/nested/permissions.txt'), 'permissions\n', { mode: 0o600 })
  await writeFile(join(gateRoot, 'other-outside/nested/content.txt'), 'original\n', { mode: 0o600 })
  await writeFile(join(gateRoot, 'other-outside/nested/replacement.txt'), 'replace-me\n', { mode: 0o600 })
  const archive = Buffer.concat([tar('uv-aarch64-apple-darwin/', '', '5'), tar('uv-aarch64-apple-darwin/uv', '#!/bin/sh\nexit 0\n'), tar('uv-aarch64-apple-darwin/uvx', '#!/bin/sh\nexit 0\n'), Buffer.alloc(1024)])
  const artifactBodies = new Map<string, Buffer>()
  const uvArtifact = (architecture: 'aarch64' | 'x86_64') => fixtureArtifact(artifactBodies, {
    component: 'uv', version: '0.12.3', license: 'Apache-2.0 OR MIT', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3',
    filename: `uv-${architecture}-apple-darwin.tar.gz`, destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz', body: archive, host: 'releases.example.test',
  })
  const uvManifest = { component: 'uv', version: '0.12.3', license: 'Apache-2.0 OR MIT', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', artifacts: { 'darwin-arm64': uvArtifact('aarch64'), 'darwin-x64': uvArtifact('x86_64') } }
  const specKitManifest = fixtureSpecKitManifest(artifactBodies)
  await writeFile(join(repositoryRoot, 'runtime-manifests/uv-0.12.3.json'), JSON.stringify(uvManifest))
  await writeFile(join(repositoryRoot, 'runtime-manifests/spec-kit-0.16.5.json'), JSON.stringify(specKitManifest))
  return { artifactBodies, gateRoot, repositoryRoot, workspaceRoot, manifests: { uv: uvManifest, specKit: specKitManifest } as unknown as import('../src/runtime-manifest.js').RuntimeManifest }
}

function fixtureSpecKitManifest(bodies: Map<string, Buffer>) {
  const common = [
    ['specify-cli', '0.16.5', 'specify_cli-0.16.5-py3-none-any.whl'],
    ['python-dependency', '0.27.1', 'typer-0.27.1-py3-none-any.whl'],
    ['python-dependency', '8.4.2', 'click-8.4.2-py3-none-any.whl'],
    ['python-dependency', '15.0.0', 'rich-15.0.0-py3-none-any.whl'],
    ['python-dependency', '4.11.4', 'platformdirs-4.11.4-py3-none-any.whl'],
    ['python-dependency', '4.2.2', 'readchar-4.2.2-py3-none-any.whl'],
    ['python-dependency', '26.3', 'packaging-26.3-py3-none-any.whl'],
    ['python-dependency', '1.1.1', 'pathspec-1.1.1-py3-none-any.whl'],
    ['python-dependency', '0.15.0', 'json5-0.15.0-py3-none-any.whl'],
    ['python-dependency', '1.5.4', 'shellingham-1.5.4-py2.py3-none-any.whl'],
    ['python-dependency', '0.0.5', 'annotated_doc-0.0.5-py3-none-any.whl'],
    ['python-dependency', '4.2.0', 'markdown_it_py-4.2.0-py3-none-any.whl'],
    ['python-dependency', '2.21.0', 'pygments-2.21.0-py3-none-any.whl'],
    ['python-dependency', '0.1.2', 'mdurl-0.1.2-py3-none-any.whl'],
  ].map(([component, version, filename]) => fixtureArtifact(bodies, { component: component!, version: version!, license: 'MIT', source: `https://pypi.example.test/${filename}`, filename: filename!, destination: `.backend-team/cache/wheels/${filename}`, body: Buffer.from(`fixture:${filename}`), host: 'files.example.test' }))
  const architecture = (cpu: 'aarch64' | 'x86_64', wheel: string) => [
    fixtureArtifact(bodies, { component: 'python', version: '3.13.15', license: 'PSF-2.0', source: 'https://github.com/astral-sh/python-build-standalone/releases/tag/20260807', filename: `cpython-3.13.15+20260807-${cpu}-apple-darwin-install_only_stripped.tar.gz`, destination: `.backend-team/cache/python-mirror/20260807/cpython-3.13.15+20260807-${cpu}-apple-darwin-install_only_stripped.tar.gz`, body: Buffer.from(`fixture:python:${cpu}`), host: 'python.example.test' }),
    fixtureArtifact(bodies, { component: 'python-dependency', version: '6.0.3', license: 'MIT', source: 'https://pypi.example.test/PyYAML', filename: wheel, destination: `.backend-team/cache/wheels/${wheel}`, body: Buffer.from(`fixture:${wheel}`), host: 'files.example.test' }),
  ]
  return { component: 'specify-cli', version: '0.16.5', source: 'https://github.com/github/spec-kit/tree/v0.16.5', license: 'MIT', python: '3.13.15', executable: 'specify', expectedVersion: '0.16.5', artifacts: { common, 'darwin-arm64': architecture('aarch64', 'pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl'), 'darwin-x64': architecture('x86_64', 'pyyaml-6.0.3-cp313-cp313-macosx_10_13_x86_64.whl') } }
}

function fixtureArtifact(bodies: Map<string, Buffer>, input: { component: string; version: string; license: string; source: string; filename: string; destination: string; body: Buffer; host: string }) {
  const url = `https://${input.host}/${encodeURIComponent(input.filename)}`
  bodies.set(url, input.body)
  return { component: input.component, version: input.version, license: input.license, source: input.source, url, bytes: input.body.length, sha256: createHash('sha256').update(input.body).digest('hex'), allowedHosts: [input.host], destination: input.destination }
}

async function writeExecutable(path: string, value: string): Promise<void> { await writeFile(path, value); await chmod(path, 0o700) }
async function readTree(path: string): Promise<Buffer> {
  const details = await lstat(path)
  if (details.isDirectory()) return Buffer.concat(await Promise.all((await readdir(path)).sort().map((name) => readTree(join(path, name)))))
  return readFile(path)
}
async function exactTree(root: string): Promise<string> {
  const entries: Record<string, string | number>[] = []
  const visit = async (path: string, relativePath: string): Promise<void> => {
    const details = await lstat(path, { bigint: true })
    const entry: Record<string, string | number> = {
      path: relativePath,
      type: details.isDirectory() ? 'directory' : details.isFile() ? 'file' : details.isSymbolicLink() ? 'symlink' : 'other',
      mode: Number(details.mode),
      dev: details.dev.toString(),
      ino: details.ino.toString(),
      size: details.size.toString(),
      mtimeNs: details.mtimeNs.toString(),
      ctimeNs: details.ctimeNs.toString(),
      birthtimeNs: details.birthtimeNs.toString(),
    }
    if (details.isFile()) entry.sha256 = createHash('sha256').update(await readFile(path)).digest('hex')
    entries.push(entry)
    if (details.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name), relativePath === '.' ? name : `${relativePath}/${name}`)
  }
  await visit(root, '.')
  return JSON.stringify(entries)
}
function tar(name: string, body: string, type = '0'): Buffer { const header = Buffer.alloc(512); header.write(name); header.write('0000700\0', 100); header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263); header.fill(0x20, 148, 156); header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148); return Buffer.concat([header, Buffer.from(body), Buffer.alloc((512 - body.length % 512) % 512)]) }
function officialIntegration(): string { return JSON.stringify({ version: '0.16.5', integration_state_schema: 1, installed_integrations: ['generic'], integration_settings: { generic: { script: 'sh', raw_options: '--commands-dir .backend-team/runtime/spec-kit/commands', parsed_options: { commands_dir: '.backend-team/runtime/spec-kit/commands' }, invoke_separator: '.' } }, integration: 'generic', default_integration: 'generic' }) }
