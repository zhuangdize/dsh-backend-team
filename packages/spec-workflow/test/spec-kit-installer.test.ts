import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendTeamState, PolicyContext } from '@dsh-backend-team/contracts'
import { FileStateStore, sha256Canonical } from '@dsh-backend-team/core'
import { ApprovalTokenService, InstallSessionService, installApprovalAction } from '@dsh-backend-team/policy-engine'
import { ArtifactDownloader, createWorkspaceLayout, initializeWorkspaceLayout, NodeCommandRunner } from '@dsh-backend-team/platform-macos'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRuntimeEnvironment } from '../src/runtime-environment.js'
import { __setSpecKitInstallerTestHooksForTest, assertInstalledSpecKitEvidence, parseSpecifyVersion, readRuntimeProvenance, SpecKitInstaller } from '../src/spec-kit-installer.js'
import { UvInstaller } from '../src/uv-installer.js'
import type { InstalledUv } from '../src/uv-installer.js'
import type { InstallPlanArtifact } from '../src/install-plan.js'
import { selectSpecKitArtifacts } from '../src/runtime-manifest.js'
import type { SpecKitManifest, UvManifest } from '../src/runtime-manifest.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('SpecKitInstaller', () => {
  it('accepts only the exact official root --version output', () => {
    expect(parseSpecifyVersion('specify 0.16.5\n')).toBe('0.16.5')
    expect(parseSpecifyVersion('0.16.5\n')).toBeUndefined()
    expect(parseSpecifyVersion('╭─ Specify CLI Version ─╮\n│ CLI Version 0.16.5    │\n╰───────────────────────╯\n')).toBeUndefined()
  })

  it('creates Spec Kit through the pinned venv interpreter and records non-secret provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const env = buildRuntimeEnvironment(layout); const runtime = await verifiedRuntime(layout)
    const localUv = join(layout.runtimeDir, 'bin/uv'); const specVenv = join(layout.runtimeDir, 'spec-kit/.venv'); const specPython = join(specVenv, 'bin/python'); const localSpecify = join(specVenv, 'bin/specify')
    const requests: unknown[] = []
    const options = { layout, environment: env, plan: runtime.plan, installedUv: runtime.installedUv, manifest: manifest, architecture: 'arm64' as const, downloader: runtime.downloader, runCommand: async (request: Parameters<ConstructorParameters<typeof SpecKitInstaller>[0]['runCommand']>[0]) => { requests.push(request); if (request.args[0] === 'venv') { await mkdir(join(specVenv, 'bin'), { recursive: true }); await writeFile(specPython, 'python'); await writeFile(localSpecify, 'specify'); await writeFile(join(specVenv, 'pyvenv.cfg'), venvConfig(layout)) }; return { exitCode: 0, stdout: request.executable === specPython ? 'Python 3.13.15\n' : request.executable === localSpecify ? 'specify 0.16.5\n' : request.args[0] === 'pip' ? 'SENSITIVE_FIXTURE_TOKEN' : '', stderr: '', durationMs: 1 } } }
    const installer = new SpecKitInstaller(options)

    const result = await installer.ensureInstalled()

    expect(requests).toMatchObject([
      { executable: localUv, args: ['python', 'install', '--offline', '3.13.15'] },
      { executable: localUv, args: ['venv', '--offline', '--python', '3.13.15', specVenv] },
      { executable: specPython, args: ['--version'] },
      { executable: localUv, args: ['pip', 'install', '--offline', '--no-index', '--no-deps', '--python', specPython, ...specKitWheelPaths(layout)] },
      { executable: localUv, args: ['pip', 'check', '--offline', '--python', specPython] },
      { executable: localSpecify, args: ['--version'] },
    ])
    expect(await realpath(result.specifyPath)).toBe(localSpecify)
    const provenance = await readRuntimeProvenance(result.provenancePath)
    expect(provenance).toMatchObject({ schemaVersion: 3, offlineInstall: true, uv: { version: '0.12.3', path: localUv, uvxPath: join(layout.runtimeDir, 'bin/uvx') }, python: { version: '3.13.15', path: specPython, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, specify: { version: '0.16.5', path: localSpecify }, runtimeClosure: [{ path: '.backend-team/runtime/python', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, { path: '.backend-team/runtime/spec-kit/.venv', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }], artifacts: expect.arrayContaining([expect.objectContaining({ component: 'uv', version: '0.12.3' }), expect.objectContaining({ component: 'specify-cli', version: '0.16.5' })]), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(provenance.commands).toHaveLength(7)
    expect(JSON.stringify(provenance)).not.toContain('SENSITIVE_FIXTURE_TOKEN')
    await new SpecKitInstaller(options).ensureInstalled()
    expect(requests).toHaveLength(6)
    await expect(assertInstalledSpecKitEvidence({ ...result } as typeof result, layout)).rejects.toThrow(/verified|evidence/i)
    const reissued = await new SpecKitInstaller(options).ensureInstalled()
    await expect(assertInstalledSpecKitEvidence(reissued, layout)).resolves.toBe(reissued)
    const requestsBeforeTamper = requests.length
    await writeFile(localSpecify, 'replaced specify')
    await expect(assertInstalledSpecKitEvidence(reissued, layout)).rejects.toThrow(/changed|evidence/i)
    await expect(new SpecKitInstaller(options).ensureInstalled()).rejects.toThrow(/changed|provenance|closure|evidence/i)
    expect(requests).toHaveLength(requestsBeforeTamper)
    const tampered = JSON.parse(await readFile(result.provenancePath, 'utf8')) as { completedAt: string }
    tampered.completedAt = '2026-08-25T00:00:00.000Z'
    await writeFile(result.provenancePath, JSON.stringify(tampered))
    await expect(new SpecKitInstaller(options).ensureInstalled()).rejects.toThrow(/fingerprint|provenance/i)
  })

  it('executes the approved uv version command before continuing a partial archive recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-partial-recovery-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const environment = buildRuntimeEnvironment(layout); const runtime = await verifiedRuntime(layout)
    const uvArtifact = runtime.plan.artifacts[0]!
    const recoveredUv = await new UvInstaller({ layout, environment, plan: runtime.plan, artifact: uvArtifact, manifest: manifestFor(uvArtifact), architecture: 'arm64', downloader: runtime.downloader, runCommand: async () => { throw new Error('UvInstaller recovery must not execute') } }).ensureInstalled()
    expect(recoveredUv.versionEvidence).toBe('archive')
    const venv = join(layout.runtimeDir, 'spec-kit/.venv'); const python = join(venv, 'bin/python'); const specify = join(venv, 'bin/specify')
    const requests: Parameters<ConstructorParameters<typeof SpecKitInstaller>[0]['runCommand']>[0][] = []
    const installed = await new SpecKitInstaller({ layout, environment, plan: runtime.plan, installedUv: recoveredUv, manifest, architecture: 'arm64', downloader: runtime.downloader, runCommand: async (request) => {
      requests.push(request)
      if (request.args[0] === 'venv') { await mkdir(join(venv, 'bin'), { recursive: true }); await writeFile(python, 'python'); await writeFile(specify, 'specify'); await writeFile(join(venv, 'pyvenv.cfg'), venvConfig(layout)) }
      return { exitCode: 0, stdout: request.executable === recoveredUv.uvPath && request.args[0] === '--version' ? 'uv 0.12.3 (aarch64-apple-darwin)\n' : request.executable === python ? 'Python 3.13.15\n' : request.executable === specify ? 'specify 0.16.5\n' : '', stderr: '', durationMs: 1 }
    } }).ensureInstalled()

    expect(requests[0]).toMatchObject({ executable: recoveredUv.uvPath, args: ['--version'] })
    expect(requests).toHaveLength(7)
    const provenance = await readRuntimeProvenance(installed.provenancePath)
    expect(provenance.commands).toHaveLength(7)
    expect(provenance.commands[0]).toMatchObject({ executable: recoveredUv.uvPath, args: ['--version'], result: 'uv 0.12.3' })
  })

  it('detects legal single-field provenance changes through its canonical fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-fingerprint-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const runtime = await verifiedRuntime(layout); const venv = join(layout.runtimeDir, 'spec-kit/.venv'); const python = join(venv, 'bin/python'); const specify = join(venv, 'bin/specify')
    const installer = new SpecKitInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: runtime.plan, installedUv: runtime.installedUv, manifest, ...runtimeDeps(runtime), runCommand: async (request) => { if (request.args[0] === 'venv') { await mkdir(join(venv, 'bin'), { recursive: true }); await writeFile(python, 'python'); await writeFile(specify, 'specify'); await writeFile(join(venv, 'pyvenv.cfg'), venvConfig(layout)) }; return { exitCode: 0, stdout: request.executable === python ? 'Python 3.13.15\n' : request.executable === specify ? 'specify 0.16.5\n' : '', stderr: '', durationMs: 1 } } })
    const installed = await installer.ensureInstalled(); const original = JSON.parse(await readFile(installed.provenancePath, 'utf8')) as MutableProvenance
    expect(original.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    const mutations: readonly ((value: MutableProvenance) => void)[] = [
      (value) => { value.completedAt = '2026-08-25T00:00:00.000Z' },
      (value) => { value.commands[0]!.cwd = `${layout.runtimeDir}/bin/.` },
      (value) => { value.artifacts[0]!.destination = '.backend-team/cache/downloads/uv-copy.tar.gz' },
      (value) => { value.artifacts[0]!.sha256 = 'f'.repeat(64) },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(original); mutate(changed)
      await writeFile(installed.provenancePath, JSON.stringify(changed))
      await expect(readRuntimeProvenance(installed.provenancePath)).rejects.toThrow()
    }
  })

  it('binds imported site-packages and the managed Python tree, not only the specify wrapper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-closure-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const runtime = await verifiedRuntime(layout); const venv = join(layout.runtimeDir, 'spec-kit/.venv'); const python = join(venv, 'bin/python'); const specify = join(venv, 'bin/specify'); const module = join(venv, 'lib/python3.13/site-packages/specify_cli/main.py'); const managedPython = join(layout.runtimeDir, 'python/3.13.15/bin/python3.13')
    const installer = new SpecKitInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: runtime.plan, installedUv: runtime.installedUv, manifest, ...runtimeDeps(runtime), runCommand: async (request) => {
      if (request.args[0] === 'python') { await mkdir(join(layout.runtimeDir, 'python/3.13.15/bin'), { recursive: true }); await writeFile(managedPython, 'managed python', { mode: 0o700 }) }
      if (request.args[0] === 'venv') { await mkdir(join(venv, 'bin'), { recursive: true }); await mkdir(join(venv, 'lib/python3.13/site-packages/specify_cli'), { recursive: true }); await writeFile(python, 'python', { mode: 0o700 }); await writeFile(specify, 'specify', { mode: 0o700 }); await writeFile(module, 'trusted module'); await writeFile(join(venv, 'pyvenv.cfg'), venvConfig(layout)) }
      return { exitCode: 0, stdout: request.executable === python ? 'Python 3.13.15\n' : request.executable === specify ? 'specify 0.16.5\n' : '', stderr: '', durationMs: 1 }
    } })
    const installed = await installer.ensureInstalled()

    await writeFile(module, 'tampered module')
    await expect(assertInstalledSpecKitEvidence(installed, layout)).rejects.toThrow(/closure|evidence|changed/i)
    await writeFile(module, 'trusted module')
    await writeFile(managedPython, 'tampered python', { mode: 0o700 })
    await expect(assertInstalledSpecKitEvidence(installed, layout)).rejects.toThrow(/closure|evidence|changed/i)
  })

  it('rejects a venv executable that resolves outside the workspace-local venv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-link-')); roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-outside-')); roots.push(outside)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const env = buildRuntimeEnvironment(layout); const runtime = await verifiedRuntime(layout); const venv = join(layout.runtimeDir, 'spec-kit/.venv'); const python = join(venv, 'bin/python')
    await writeFile(join(outside, 'python'), 'bad')
    const installer = new SpecKitInstaller({ layout, environment: env, plan: runtime.plan, installedUv: runtime.installedUv, manifest, ...runtimeDeps(runtime), runCommand: async (request) => { if (request.args[0] === 'venv') { await mkdir(join(venv, 'bin'), { recursive: true }); await symlink(join(outside, 'python'), python); await writeFile(join(venv, 'bin/specify'), 'specify'); await writeFile(join(venv, 'pyvenv.cfg'), venvConfig(layout)) }; return { exitCode: 0, stdout: '0.16.5', stderr: '', durationMs: 1 } } })

    await expect(installer.ensureInstalled()).rejects.toThrow(/escapes|venv/i)
  })

  it('rejects an altered environment before it executes a command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-env-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const runtime = await verifiedRuntime(layout); const env = { ...buildRuntimeEnvironment(layout), PATH: '/host/uv:/usr/bin' }
    const installer = new SpecKitInstaller({ layout, environment: env, plan: runtime.plan, installedUv: runtime.installedUv, manifest, ...runtimeDeps(runtime), runCommand: async () => { throw new Error('must not run') } })
    await expect(installer.ensureInstalled()).rejects.toThrow(/environment/i)
  })

  it('does not publish provenance after a partial command failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-failure-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const runtime = await verifiedRuntime(layout); const venv = join(layout.runtimeDir, 'spec-kit/.venv'); const python = join(venv, 'bin/python'); const specify = join(venv, 'bin/specify')
    const installer = new SpecKitInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: runtime.plan, installedUv: runtime.installedUv, manifest, ...runtimeDeps(runtime), runCommand: async (request) => { if (request.args[0] === 'venv') { await mkdir(join(venv, 'bin'), { recursive: true }); await writeFile(python, 'python'); await writeFile(specify, 'specify'); await writeFile(join(venv, 'pyvenv.cfg'), venvConfig(layout)) }; return request.args[0] === 'pip' ? { exitCode: 1, stdout: '', stderr: 'fixture failure', durationMs: 1 } : { exitCode: 0, stdout: request.executable === python ? 'Python 3.13.15\n' : '', stderr: '', durationMs: 1 } } })
    await expect(installer.ensureInstalled()).rejects.toThrow(/failed/i)
    await expect(readFile(join(venv, 'provenance.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a provenance replacement raced after destination identity verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-provenance-race-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const runtime = await verifiedRuntime(layout); const venv = join(layout.runtimeDir, 'spec-kit/.venv'); const python = join(venv, 'bin/python'); const specify = join(venv, 'bin/specify'); const target = join(layout.runtimeDir, 'spec-kit/provenance.json'); const replacement = join(layout.runtimeDir, 'spec-kit/replacement')
    const restore = __setSpecKitInstallerTestHooksForTest({ beforeProvenanceTemporaryUnlink: async (path) => { await writeFile(replacement, 'user provenance', { mode: 0o600 }); await rename(replacement, path) } })
    try {
      const installer = new SpecKitInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: runtime.plan, installedUv: runtime.installedUv, manifest, ...runtimeDeps(runtime), runCommand: async (request) => { if (request.args[0] === 'venv') { await mkdir(join(venv, 'bin'), { recursive: true }); await writeFile(python, 'python'); await writeFile(specify, 'specify'); await writeFile(join(venv, 'pyvenv.cfg'), venvConfig(layout)) }; return { exitCode: 0, stdout: request.executable === python ? 'Python 3.13.15\n' : request.executable === specify ? 'specify 0.16.5\n' : '', stderr: '', durationMs: 1 } } })
      await expect(installer.ensureInstalled()).rejects.toThrow(/replaced|provenance/i)
    } finally { restore() }
    expect(await readFile(target, 'utf8')).toBe('user provenance')
  })

  it('rejects a hand-constructed InstalledUv object before any command executes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-forged-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const runtime = await verifiedRuntime(layout); let commands = 0
    const forged = { ...runtime.installedUv } as InstalledUv
    const installer = new SpecKitInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: runtime.plan, installedUv: forged, manifest, ...runtimeDeps(runtime), runCommand: async () => { commands++; throw new Error('must not run') } })

    await expect(installer.ensureInstalled()).rejects.toThrow(/verified|evidence|UvInstaller/i)
    expect(commands).toBe(0)
  })

  it('rechecks signed uv and uvx content immediately before Spec Kit uses the evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-uv-replaced-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const runtime = await verifiedRuntime(layout); let commands = 0
    await writeFile(runtime.installedUv.uvxPath, 'tampered', { mode: 0o700 })
    const installer = new SpecKitInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: runtime.plan, installedUv: runtime.installedUv, manifest, ...runtimeDeps(runtime), runCommand: async () => { commands++; throw new Error('must not run') } })

    await expect(installer.ensureInstalled()).rejects.toThrow(/content|evidence|verified/i)
    expect(commands).toBe(0)
  })

  it('uses one callback-scoped session for the fixture archive and every local command without global fallbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-session-')); roots.push(root)
    const globals = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-globals-')); roots.push(globals)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const env = buildRuntimeEnvironment(layout)
    const archive = tar([
      { name: 'uv-aarch64-apple-darwin/', body: '', type: '5' },
      { name: 'uv-aarch64-apple-darwin/uv', body: '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "uv 0.12.3 (aarch64-apple-darwin)\\n"; elif [ "$1" = "python" ]; then mkdir -p "$UV_PYTHON_INSTALL_DIR/3.13.15/bin"; printf "managed python\\n" > "$UV_PYTHON_INSTALL_DIR/3.13.15/bin/python3.13"; chmod 700 "$UV_PYTHON_INSTALL_DIR/3.13.15/bin/python3.13"; elif [ "$1" = "venv" ]; then for target do :; done; mkdir -p "$target/bin"; printf "#!/bin/sh\\necho Python 3.13.15\\n" > "$target/bin/python"; printf "#!/bin/sh\\necho specify 0.16.5\\n" > "$target/bin/specify"; printf "home = %s/3.13.15/bin\\nimplementation = CPython\\nuv = 0.12.3\\nversion_info = 3.13.15\\ninclude-system-site-packages = false\\n" "$UV_PYTHON_INSTALL_DIR" > "$target/pyvenv.cfg"; chmod 700 "$target/bin/python" "$target/bin/specify"; fi\n' },
      { name: 'uv-aarch64-apple-darwin/uvx', body: '#!/bin/sh\nexit 0\n' },
    ])
    const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: archive.byteLength, sha256: createHash('sha256').update(archive).digest('hex'), allowedHosts: ['releases.example.test'] })
    const uv = join(layout.runtimeDir, 'bin/uv'); const venv = join(layout.runtimeDir, 'spec-kit/.venv'); const python = join(venv, 'bin/python'); const specify = join(venv, 'bin/specify')
    const command = (executable: string, args: readonly string[], cwd: string) => ({ executable, args, cwd, env, executionFingerprint: sha256Canonical({ executable, args, cwd, env, codeWillExecute: true, networkPolicy: 'deny' }), codeWillExecute: true as const, networkPolicy: 'deny' as const })
    const plan = { intent: 'runtime-install' as const, tool: 'uv', version: '0.12.3', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', license: 'MIT', destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz', artifacts: [artifact, ...selectSpecKitArtifacts(manifest, 'arm64')], managedPaths: [], commands: [command(uv, ['--version'], join(layout.runtimeDir, 'bin')), command(uv, ['python', 'install', '--offline', manifest.python], join(layout.runtimeDir, 'bin')), command(uv, ['venv', '--offline', '--python', manifest.python, venv], join(layout.runtimeDir, 'bin')), command(python, ['--version'], join(venv, 'bin')), command(uv, ['pip', 'install', '--offline', '--no-index', '--no-deps', '--python', python, ...specKitWheelPaths(layout)], join(layout.runtimeDir, 'bin')), command(uv, ['pip', 'check', '--offline', '--python', python], join(layout.runtimeDir, 'bin')), command(specify, ['--version'], join(venv, 'bin'))] }
    const store = new FileStateStore(root); const state: BackendTeamState = { schemaVersion: 1, revision: 0, workspaceRoot: store.workspaceRoot, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] }; await store.create(state)
    const context: PolicyContext = { phase: 'BUILD', workspace: layout }; const tokens = new ApprovalTokenService(store, { now: () => new Date('2026-08-25T00:00:00.000Z'), randomBytes: () => Buffer.alloc(32, 9), tokenId: () => 'runtime-install-session' })
    const token = await tokens.issue({ kind: 'install', workspaceRoot: root, context, action: installApprovalAction(plan), expiresAt: '2026-08-25T00:10:00.000Z' })
    const calls = join(root, 'global-called')
    for (const executable of ['python', 'uv', 'specify']) await writeFile(join(globals, executable), `#!/bin/sh\nprintf global > '${calls}'\n`, { mode: 0o700 })
    const previousPath = process.env.PATH; process.env.PATH = globals
    try {
      const runner = new NodeCommandRunner({ context, policyEngine: { authorize: async () => { throw new Error('session runner must not use policy engine') } }, approvalTokens: { executeApprovedCommand: async () => { throw new Error('session runner must not use raw token') } } })
      const session = new InstallSessionService(tokens)
      await session.execute(token, { workspaceRoot: root, context, plan }, async (approved) => {
        const downloader = new ArtifactDownloader({ workspaceRoot: root, capability: approved.artifacts, fetch: async (input) => String(input).includes('releases.example.test/uv.tar.gz') ? new Response(archive) : new Response('a') })
        const runCommand = (request: Parameters<NodeCommandRunner['runApprovedInstall']>[1]) => runner.runApprovedInstall(approved.commands, { ...request, codeWillExecute: true })
        const uvInstaller = new (await import('../src/uv-installer.js')).UvInstaller({ layout, environment: env, plan, artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader, runCommand })
        const installedUv = await uvInstaller.ensureInstalled()
        const installer = new SpecKitInstaller({ layout, environment: env, plan, installedUv, manifest, architecture: 'arm64', downloader, runCommand })
        await installer.ensureInstalled()
      })
    } finally { process.env.PATH = previousPath }
    await expect(readFile(calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)
})

const manifest: SpecKitManifest = specKitManifest()
interface MutableProvenance { fingerprint?: unknown; completedAt: string; commands: { cwd: string }[]; artifacts: { destination: string; sha256: string }[] }
function planFor(layout: Awaited<ReturnType<typeof initializeWorkspaceLayout>>, artifact: InstallPlanArtifact) {
  const env = buildRuntimeEnvironment(layout); const uv = join(layout.runtimeDir, 'bin/uv'); const venv = join(layout.runtimeDir, 'spec-kit/.venv'); const python = join(venv, 'bin/python'); const specify = join(venv, 'bin/specify')
  const command = (executable: string, args: readonly string[], cwd: string) => ({ executable, args, cwd, env, executionFingerprint: sha256Canonical({ executable, args, cwd, env, codeWillExecute: true, networkPolicy: 'deny' }), codeWillExecute: true as const, networkPolicy: 'deny' as const })
  return { intent: 'runtime-install' as const, tool: 'uv', version: '0.12.3', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', license: 'MIT', destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz', artifacts: [artifact, ...selectSpecKitArtifacts(manifest, 'arm64')], managedPaths: [], commands: [command(uv, ['--version'], join(layout.runtimeDir, 'bin')), command(uv, ['python', 'install', '--offline', '3.13.15'], join(layout.runtimeDir, 'bin')), command(uv, ['venv', '--offline', '--python', '3.13.15', venv], join(layout.runtimeDir, 'bin')), command(python, ['--version'], join(venv, 'bin')), command(uv, ['pip', 'install', '--offline', '--no-index', '--no-deps', '--python', python, ...specKitWheelPaths(layout)], join(layout.runtimeDir, 'bin')), command(uv, ['pip', 'check', '--offline', '--python', python], join(layout.runtimeDir, 'bin')), command(specify, ['--version'], join(venv, 'bin'))] }
}

async function verifiedRuntime(layout: Awaited<ReturnType<typeof initializeWorkspaceLayout>>): Promise<{ readonly plan: ReturnType<typeof planFor>; readonly installedUv: InstalledUv; readonly downloader: ArtifactDownloader }> {
  const archive = tar([{ name: 'uv-aarch64-apple-darwin/', body: '', type: '5' }, { name: 'uv-aarch64-apple-darwin/uv', body: 'uv' }, { name: 'uv-aarch64-apple-darwin/uvx', body: 'uvx' }])
  const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: archive.byteLength, sha256: createHash('sha256').update(archive).digest('hex'), allowedHosts: ['releases.example.test'] })
    const plan = planFor(layout, artifact)
    const downloader = fixtureDownloader(layout, archive)
    const installedUv = await new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan, artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader, runCommand: async () => ({ exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 }) }).ensureInstalled()
    await mkdir(join(layout.runtimeDir, 'python/3.13.15/bin'), { recursive: true })
    await writeFile(join(layout.runtimeDir, 'python/3.13.15/bin/python3.13'), 'managed python', { mode: 0o700 })
  return { plan, installedUv, downloader }
}

function runtimeDeps(runtime: Awaited<ReturnType<typeof verifiedRuntime>>): { readonly architecture: 'arm64'; readonly downloader: ArtifactDownloader } { return { architecture: 'arm64', downloader: runtime.downloader } }

function venvConfig(layout: Awaited<ReturnType<typeof initializeWorkspaceLayout>>): string { return `home = ${join(layout.runtimeDir, 'python/3.13.15/bin')}\nimplementation = CPython\nuv = 0.12.3\nversion_info = 3.13.15\ninclude-system-site-packages = false\n` }

function uvArtifact(value: { readonly url: string; readonly bytes: number; readonly sha256: string; readonly allowedHosts: readonly string[] }): InstallPlanArtifact { return { component: 'uv', version: '0.12.3', license: 'MIT', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', ...value, destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz' } }
function specKitArtifact(component: string, version: string, filename: string, source = 'https://files.pythonhosted.org/'): InstallPlanArtifact { return { component, version, license: component === 'python' ? 'PSF-2.0' : 'MIT', source, url: `${source}${filename}`, bytes: 1, sha256: createHash('sha256').update('a').digest('hex'), allowedHosts: [new URL(source).hostname], destination: `.backend-team/cache/wheels/${filename}` } }
function specKitManifest(): SpecKitManifest {
  const common = [['specify-cli', '0.16.5', 'specify_cli-0.16.5-py3-none-any.whl'], ['python-dependency', '0.27.1', 'typer-0.27.1-py3-none-any.whl'], ['python-dependency', '8.4.2', 'click-8.4.2-py3-none-any.whl'], ['python-dependency', '15.0.0', 'rich-15.0.0-py3-none-any.whl'], ['python-dependency', '4.11.4', 'platformdirs-4.11.4-py3-none-any.whl'], ['python-dependency', '4.2.2', 'readchar-4.2.2-py3-none-any.whl'], ['python-dependency', '26.3', 'packaging-26.3-py3-none-any.whl'], ['python-dependency', '1.1.1', 'pathspec-1.1.1-py3-none-any.whl'], ['python-dependency', '0.15.0', 'json5-0.15.0-py3-none-any.whl'], ['python-dependency', '1.5.4', 'shellingham-1.5.4-py2.py3-none-any.whl'], ['python-dependency', '0.0.5', 'annotated_doc-0.0.5-py3-none-any.whl'], ['python-dependency', '4.2.0', 'markdown_it_py-4.2.0-py3-none-any.whl'], ['python-dependency', '2.21.0', 'pygments-2.21.0-py3-none-any.whl'], ['python-dependency', '0.1.2', 'mdurl-0.1.2-py3-none-any.whl']] as const
  const commonArtifacts = common.map(([component, version, filename]) => specKitArtifact(component, version, filename))
  const python = (filename: string, destination: string) => ({ ...specKitArtifact('python', '3.13.15', filename, 'https://github.com/astral-sh/python-build-standalone/releases/download/20260807/'), destination })
  return { component: 'specify-cli', version: '0.16.5', source: 'https://github.com/github/spec-kit/tree/v0.16.5', license: 'MIT', python: '3.13.15', executable: 'specify', expectedVersion: '0.16.5', artifacts: { common: commonArtifacts, 'darwin-arm64': [python('cpython-3.13.15+20260807-aarch64-apple-darwin-install_only_stripped.tar.gz', '.backend-team/cache/python-mirror/20260807/cpython-3.13.15+20260807-aarch64-apple-darwin-install_only_stripped.tar.gz'), specKitArtifact('python-dependency', '6.0.3', 'pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl')], 'darwin-x64': [python('cpython-3.13.15+20260807-x86_64-apple-darwin-install_only_stripped.tar.gz', '.backend-team/cache/python-mirror/20260807/cpython-3.13.15+20260807-x86_64-apple-darwin-install_only_stripped.tar.gz'), specKitArtifact('python-dependency', '6.0.3', 'pyyaml-6.0.3-cp313-cp313-macosx_10_13_x86_64.whl')] } }
}
function specKitWheelPaths(layout: Awaited<ReturnType<typeof initializeWorkspaceLayout>>): readonly string[] { return Object.freeze(['specify_cli-0.16.5-py3-none-any.whl', 'typer-0.27.1-py3-none-any.whl', 'click-8.4.2-py3-none-any.whl', 'rich-15.0.0-py3-none-any.whl', 'platformdirs-4.11.4-py3-none-any.whl', 'readchar-4.2.2-py3-none-any.whl', 'packaging-26.3-py3-none-any.whl', 'pathspec-1.1.1-py3-none-any.whl', 'json5-0.15.0-py3-none-any.whl', 'shellingham-1.5.4-py2.py3-none-any.whl', 'annotated_doc-0.0.5-py3-none-any.whl', 'markdown_it_py-4.2.0-py3-none-any.whl', 'pygments-2.21.0-py3-none-any.whl', 'mdurl-0.1.2-py3-none-any.whl', 'pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl'].map((name) => join(layout.cacheDir, 'wheels', name))) }
function manifestFor(artifact: Pick<InstallPlanArtifact, 'url' | 'bytes' | 'sha256'>): UvManifest { const selected = uvArtifact({ ...artifact, allowedHosts: ['releases.example.test'] }); return { component: 'uv', version: '0.12.3', license: 'MIT', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', artifacts: { 'darwin-arm64': selected, 'darwin-x64': selected } } }

function fixtureDownloader(layout: Awaited<ReturnType<typeof initializeWorkspaceLayout>>, archive: Buffer): ArtifactDownloader { return new ArtifactDownloader({ workspaceRoot: layout.root, capability: { executeApprovedArtifact: async (_scope, _signal, operation) => operation() }, fetch: async (input) => String(input).includes('releases.example.test/uv.tar.gz') ? new Response(archive) : new Response('a') }) }

function tar(entries: readonly { name: string; body: string; type?: string }[]): Buffer {
  const files = entries.flatMap((entry) => {
    const header = Buffer.alloc(512)
    const size = Buffer.byteLength(entry.body)
    header.write(entry.name); header.write('0000700\0', 100); header.write(`${size.toString(8).padStart(11, '0')}\0`, 124); header.write(entry.type ?? '0', 156); header.write('ustar\0', 257); header.write('00', 263); header.fill(0x20, 148, 156); header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
    return [header, Buffer.concat([Buffer.from(entry.body), Buffer.alloc((512 - size % 512) % 512)])]
  })
  return Buffer.concat([...files, Buffer.alloc(1024)])
}
