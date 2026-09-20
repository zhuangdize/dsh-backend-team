import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandRequest, CommandResult } from '@dsh-backend-team/contracts'
import { sha256Canonical } from '@dsh-backend-team/core'
import { createWorkspaceLayout, initializeWorkspaceLayout } from '@dsh-backend-team/platform-macos'
import { installApprovalAction } from '@dsh-backend-team/policy-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRuntimeEnvironment } from '../src/runtime-environment.js'
import { SpecKitAdapter, buildSpecKitInitPlan, type SpecKitInstallSession, type SpecKitSessionCommandCapability } from '../src/spec-kit-adapter.js'
import { SpecKitInstaller } from '../src/spec-kit-installer.js'
import { UvInstaller } from '../src/uv-installer.js'
import { ArtifactDownloader } from '@dsh-backend-team/platform-macos'
import type { InstallPlanArtifact } from '../src/install-plan.js'
import { selectSpecKitArtifacts } from '../src/runtime-manifest.js'
import type { SpecKitManifest, UvManifest } from '../src/runtime-manifest.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('SpecKitAdapter', () => {
  it('prepares an unforgeable init plan before approval and rechecks the same tree before spawn', async () => {
    const fixture = await createFixture()
    const adapter = new SpecKitAdapter({ layout: fixture.layout, installedSpecKit: fixture.installedSpecKit, environment: fixture.environment, context: fixture.context, session: new FakeInstallSession(), runner: new FakeRunner(async () => ok()) })

    const prepared = await adapter.prepareInitialization()
    const copied = { ...prepared }
    await expect(adapter.initialize(copied, 'token')).rejects.toThrow(/prepared/i)
    await mkdir(join(fixture.root, '.specify'), { recursive: true }); await writeFile(join(fixture.root, '.specify/changed'), 'changed')
    await expect(adapter.initialize(prepared, 'token')).rejects.toThrow(/precondition|snapshot/i)
  })

  it('uses a distinct spec-kit-init plan with the exact official generic command', async () => {
    const fixture = await createFixture()
    const plan = await buildSpecKitInitPlan(fixture.layout, fixture.installedSpecKit, fixture.environment, [])

    expect(plan).toMatchObject({
      intent: 'spec-kit-init', tool: 'specify-cli', version: '0.16.5', destination: '.specify', artifacts: [],
      commands: [{ executable: fixture.specifyPath, args: ['init', '--here', '--force', '--non-interactive', '--script', 'sh', '--integration', 'generic', '--integration-options=--commands-dir .backend-team/runtime/spec-kit/commands', '--ignore-agent-tools'], cwd: fixture.root, env: fixture.environment, codeWillExecute: true }],
    })
    expect(plan.commands[0]!.executionFingerprint).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('produces a complete init plan accepted by the policy install action boundary', async () => {
    const fixture = await createFixture()
    const prepared = await new SpecKitAdapter({ layout: fixture.layout, installedSpecKit: fixture.installedSpecKit, environment: fixture.environment, context: fixture.context, session: new FakeInstallSession(), runner: new FakeRunner(async () => ok()) }).prepareInitialization()

    expect(() => installApprovalAction(prepared.plan)).not.toThrow()
    expect(installApprovalAction(prepared.plan).packages).toEqual([`install-plan:${prepared.approvalDigest}`])
  })

  it('initializes through a fresh callback-scoped session and validates official generic output', async () => {
    const fixture = await createFixture()
    const runner = new FakeRunner(async () => {
      await mkdir(join(fixture.root, '.specify'), { recursive: true })
      await writeFile(join(fixture.root, '.specify/integration.json'), officialIntegration())
      await mkdir(join(fixture.layout.runtimeDir, 'spec-kit/commands'), { recursive: true })
      return ok()
    })
    const session = new FakeInstallSession()
    const adapter = new SpecKitAdapter({ layout: fixture.layout, installedSpecKit: fixture.installedSpecKit, environment: fixture.environment, context: fixture.context, session, runner })

    const prepared = await adapter.prepareInitialization()
    const initialized = await adapter.initialize(prepared, 'spec-kit-init-token')

    expect(session.calls).toHaveLength(1)
    expect(session.calls[0]).toMatchObject({ token: 'spec-kit-init-token', input: { workspaceRoot: fixture.root, plan: { intent: 'spec-kit-init' } } })
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]).toMatchObject({ executable: fixture.specifyPath, args: ['init', '--here', '--force', '--non-interactive', '--script', 'sh', '--integration', 'generic', '--integration-options=--commands-dir .backend-team/runtime/spec-kit/commands', '--ignore-agent-tools'], cwd: fixture.root, risk: 'install', codeWillExecute: true })
    expect(initialized.integration).toBe('generic')
    expect(initialized.commandsDirectory).toBe(join(fixture.layout.runtimeDir, 'spec-kit/commands'))
  })

  it('snapshots existing managed files by exact bytes before --force', async () => {
    const fixture = await createFixture()
    await mkdir(join(fixture.root, '.specify'), { recursive: true })
    await writeFile(join(fixture.root, '.specify/existing.md'), 'unchanged bytes\r\n')
    await mkdir(join(fixture.layout.runtimeDir, 'spec-kit/commands'), { recursive: true })
    await writeFile(join(fixture.layout.runtimeDir, 'spec-kit/commands/speckit.specify.md'), 'old $ARGUMENTS')
    const runner = new FakeRunner(async () => {
      await writeFile(join(fixture.root, '.specify/integration.json'), officialIntegration())
      return ok()
    })
    const adapter = new SpecKitAdapter({ layout: fixture.layout, installedSpecKit: fixture.installedSpecKit, environment: fixture.environment, context: fixture.context, session: new FakeInstallSession(), runner })

    const initialized = await adapter.initialize(await adapter.prepareInitialization(), 'fresh')

    expect(initialized.beforeForce).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.specify', state: 'directory' }),
      expect.objectContaining({ path: '.specify/existing.md', state: 'file', sha256: 'fbbf1277d5babfe07626f3274a65e93805f062e841922a6bf96e186311d0835e' }),
      expect.objectContaining({ path: '.backend-team/runtime/spec-kit/commands', state: 'directory' }),
      expect.objectContaining({ path: '.backend-team/runtime/spec-kit/commands/speckit.specify.md', state: 'file' }),
    ]))
  })

  it('fails closed when the CLI exits unsuccessfully or output is not the strict generic schema', async () => {
    const fixture = await createFixture()
    const failed = new SpecKitAdapter({ layout: fixture.layout, installedSpecKit: fixture.installedSpecKit, environment: fixture.environment, context: fixture.context, session: new FakeInstallSession(), runner: new FakeRunner(async () => ({ ...ok(), exitCode: 2, stderr: 'failed' })) })
    await expect(failed.initialize(await failed.prepareInitialization(), 'fresh')).rejects.toThrow(/initialization failed/i)

    const malformed = new SpecKitAdapter({ layout: fixture.layout, installedSpecKit: fixture.installedSpecKit, environment: fixture.environment, context: fixture.context, session: new FakeInstallSession(), runner: new FakeRunner(async () => {
      await mkdir(join(fixture.root, '.specify'), { recursive: true })
      await writeFile(join(fixture.root, '.specify/integration.json'), '{"default_integration":"generic","extra":true}')
      await mkdir(join(fixture.layout.runtimeDir, 'spec-kit/commands'), { recursive: true })
      return ok()
    }) })
    await expect(malformed.initialize(await malformed.prepareInitialization(), 'fresh')).rejects.toThrow(/integration.*schema/i)
  })
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-adapter-')); roots.push(root)
  const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
  const environment = buildRuntimeEnvironment(layout); const uv = join(layout.runtimeDir, 'bin/uv'); const venv = join(layout.runtimeDir, 'spec-kit/.venv'); const python = join(venv, 'bin/python'); const specifyPath = join(venv, 'bin/specify')
  const archive = Buffer.concat([tar('uv-aarch64-apple-darwin/', '', '5'), tar('uv-aarch64-apple-darwin/uv', 'uv'), tar('uv-aarch64-apple-darwin/uvx', 'uvx'), Buffer.alloc(1024)])
  const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), allowedHosts: ['releases.example.test'] })
  const command = (executable: string, args: readonly string[], cwd: string) => ({ executable, args, cwd, env: environment, executionFingerprint: sha256Canonical({ executable, args, cwd, env: environment, codeWillExecute: true, networkPolicy: 'deny' }), codeWillExecute: true as const, networkPolicy: 'deny' as const })
  const kitManifest = specKitManifest()
  const plan = { intent: 'runtime-install' as const, tool: 'uv', version: '0.12.3', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', license: 'MIT', destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz', artifacts: [artifact, ...selectSpecKitArtifacts(kitManifest, 'arm64')], managedPaths: [], commands: [command(uv, ['--version'], join(layout.runtimeDir, 'bin')), command(uv, ['python', 'install', '--offline', '3.13.15'], join(layout.runtimeDir, 'bin')), command(uv, ['venv', '--offline', '--python', '3.13.15', venv], join(layout.runtimeDir, 'bin')), command(python, ['--version'], join(venv, 'bin')), command(uv, ['pip', 'install', '--offline', '--no-index', '--no-deps', '--python', python, ...specKitWheelPaths(layout)], join(layout.runtimeDir, 'bin')), command(uv, ['pip', 'check', '--offline', '--python', python], join(layout.runtimeDir, 'bin')), command(specifyPath, ['--version'], join(venv, 'bin'))] }
  const manifest: UvManifest = { component: 'uv', version: '0.12.3', license: 'MIT', source: plan.source, artifacts: { 'darwin-arm64': artifact, 'darwin-x64': artifact } }
  const downloader = new ArtifactDownloader({ workspaceRoot: layout.root, capability: { executeApprovedArtifact: async (_scope, _signal, operation) => operation() }, fetch: async (input) => String(input).includes('releases.example.test/uv.tar.gz') ? new Response(archive) : new Response('a') })
  const installedUv = await new UvInstaller({ layout, environment, plan, artifact, manifest, architecture: 'arm64', downloader, runCommand: async () => ({ ...ok(), stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n' }) }).ensureInstalled()
  await mkdir(join(layout.runtimeDir, 'python/3.13.15/bin'), { recursive: true })
  await writeFile(join(layout.runtimeDir, 'python/3.13.15/bin/python3.13'), 'managed python', { mode: 0o700 })
  const installedSpecKit = await new SpecKitInstaller({ layout, environment, plan, installedUv, manifest: kitManifest, architecture: 'arm64', downloader, runCommand: async (request) => { if (request.args[0] === 'venv') { await mkdir(join(venv, 'bin'), { recursive: true }); await writeFile(python, 'python'); await writeFile(specifyPath, 'specify'); await writeFile(join(venv, 'pyvenv.cfg'), venvConfig(layout)) }; return { ...ok(), stdout: request.executable === python ? 'Python 3.13.15\n' : request.executable === specifyPath ? 'specify 0.16.5\n' : '' } } }).ensureInstalled()
  return { root: layout.root, layout, specifyPath, environment, installedSpecKit, context: { phase: 'BUILD' as const, workspace: layout } }
}
function tar(name: string, body: string, type = '0'): Buffer { const header = Buffer.alloc(512); header.write(name); header.write('0000700\0', 100); header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263); header.fill(0x20, 148, 156); header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148); return Buffer.concat([header, Buffer.from(body), Buffer.alloc((512 - body.length % 512) % 512)]) }
function ok(): CommandResult { return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 } }
function officialIntegration(): string { return JSON.stringify({ version: '0.16.5', integration_state_schema: 1, installed_integrations: ['generic'], integration_settings: { generic: { script: 'sh', raw_options: '--commands-dir .backend-team/runtime/spec-kit/commands', parsed_options: { commands_dir: '.backend-team/runtime/spec-kit/commands' }, invoke_separator: '.' } }, integration: 'generic', default_integration: 'generic' }) }
function venvConfig(layout: Awaited<ReturnType<typeof initializeWorkspaceLayout>>): string { return `home = ${join(layout.runtimeDir, 'python/3.13.15/bin')}\nimplementation = CPython\nuv = 0.12.3\nversion_info = 3.13.15\ninclude-system-site-packages = false\n` }
function uvArtifact(value: { readonly url: string; readonly bytes: number; readonly sha256: string; readonly allowedHosts: readonly string[] }): InstallPlanArtifact { return { component: 'uv', version: '0.12.3', license: 'MIT', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', ...value, destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz' } }
function specKitManifest(): SpecKitManifest {
  const common = [['specify-cli', '0.16.5', 'specify_cli-0.16.5-py3-none-any.whl'], ['python-dependency', '0.27.1', 'typer-0.27.1-py3-none-any.whl'], ['python-dependency', '8.4.2', 'click-8.4.2-py3-none-any.whl'], ['python-dependency', '15.0.0', 'rich-15.0.0-py3-none-any.whl'], ['python-dependency', '4.11.4', 'platformdirs-4.11.4-py3-none-any.whl'], ['python-dependency', '4.2.2', 'readchar-4.2.2-py3-none-any.whl'], ['python-dependency', '26.3', 'packaging-26.3-py3-none-any.whl'], ['python-dependency', '1.1.1', 'pathspec-1.1.1-py3-none-any.whl'], ['python-dependency', '0.15.0', 'json5-0.15.0-py3-none-any.whl'], ['python-dependency', '1.5.4', 'shellingham-1.5.4-py2.py3-none-any.whl'], ['python-dependency', '0.0.5', 'annotated_doc-0.0.5-py3-none-any.whl'], ['python-dependency', '4.2.0', 'markdown_it_py-4.2.0-py3-none-any.whl'], ['python-dependency', '2.21.0', 'pygments-2.21.0-py3-none-any.whl'], ['python-dependency', '0.1.2', 'mdurl-0.1.2-py3-none-any.whl']] as const
  const artifact = (component: string, version: string, filename: string, source = 'https://files.pythonhosted.org/'): InstallPlanArtifact => ({ component, version, license: component === 'python' ? 'PSF-2.0' : 'MIT', source, url: `${source}${filename}`, bytes: 1, sha256: createHash('sha256').update('a').digest('hex'), allowedHosts: [new URL(source).hostname], destination: `.backend-team/cache/wheels/${filename}` })
  const commonArtifacts = common.map(([component, version, filename]) => artifact(component, version, filename))
  const armPython = artifact('python', '3.13.15', 'cpython-3.13.15+20260807-aarch64-apple-darwin-install_only_stripped.tar.gz', 'https://github.com/astral-sh/python-build-standalone/releases/download/20260807/')
  const x64Python = artifact('python', '3.13.15', 'cpython-3.13.15+20260807-x86_64-apple-darwin-install_only_stripped.tar.gz', 'https://github.com/astral-sh/python-build-standalone/releases/download/20260807/')
  return { component: 'specify-cli', version: '0.16.5', source: 'https://github.com/github/spec-kit/tree/v0.16.5', license: 'MIT', python: '3.13.15', executable: 'specify', expectedVersion: '0.16.5', artifacts: { common: commonArtifacts, 'darwin-arm64': [Object.freeze({ ...armPython, destination: '.backend-team/cache/python-mirror/20260807/cpython-3.13.15+20260807-aarch64-apple-darwin-install_only_stripped.tar.gz' }), artifact('python-dependency', '6.0.3', 'pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl')], 'darwin-x64': [Object.freeze({ ...x64Python, destination: '.backend-team/cache/python-mirror/20260807/cpython-3.13.15+20260807-x86_64-apple-darwin-install_only_stripped.tar.gz' }), artifact('python-dependency', '6.0.3', 'pyyaml-6.0.3-cp313-cp313-macosx_10_13_x86_64.whl')] } }
}
function specKitWheelPaths(layout: Awaited<ReturnType<typeof initializeWorkspaceLayout>>): readonly string[] { return Object.freeze(['specify_cli-0.16.5-py3-none-any.whl', 'typer-0.27.1-py3-none-any.whl', 'click-8.4.2-py3-none-any.whl', 'rich-15.0.0-py3-none-any.whl', 'platformdirs-4.11.4-py3-none-any.whl', 'readchar-4.2.2-py3-none-any.whl', 'packaging-26.3-py3-none-any.whl', 'pathspec-1.1.1-py3-none-any.whl', 'json5-0.15.0-py3-none-any.whl', 'shellingham-1.5.4-py2.py3-none-any.whl', 'annotated_doc-0.0.5-py3-none-any.whl', 'markdown_it_py-4.2.0-py3-none-any.whl', 'pygments-2.21.0-py3-none-any.whl', 'mdurl-0.1.2-py3-none-any.whl', 'pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl'].map((name) => join(layout.cacheDir, 'wheels', name))) }

class FakeInstallSession implements SpecKitInstallSession {
  readonly calls: { token: string; input: unknown }[] = []
  async execute<T>(token: string, input: Parameters<SpecKitInstallSession['execute']>[1], callback: (session: { readonly commands: SpecKitSessionCommandCapability }) => Promise<T>): Promise<T> {
    this.calls.push({ token, input })
    return callback({ commands: { executeApprovedInstallCommand: async (command, operation) => operation({ canonicalExecutable: command.executable, executableContentDigest: 'a'.repeat(64), canonicalCwd: command.cwd, args: command.args, env: command.env, executionFingerprint: command.executionFingerprint }) } })
  }
}
class FakeRunner {
  readonly requests: (CommandRequest & { readonly codeWillExecute: true })[] = []
  constructor(private readonly run: (request: CommandRequest & { readonly codeWillExecute: true }) => Promise<CommandResult>) {}
  async runApprovedInstall(_session: unknown, request: CommandRequest & { readonly codeWillExecute: true }): Promise<CommandResult> { this.requests.push(request); return this.run(request) }
}
