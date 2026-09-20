import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { CommandResult, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { sha256Canonical, sha256WorkspaceTree } from '@dsh-backend-team/core'
import { ArtifactDownloader } from '@dsh-backend-team/platform-macos'
import type { InstallPlan, InstallPlanArtifact, InstallPlanCommand, RuntimeTreePrecondition } from './install-plan.js'
import { selectSpecKitArtifacts, type RuntimeArtifact, type SpecKitManifest } from './runtime-manifest.js'
import { assertRuntimeEnvironment, runtimePath, runtimePythonPath } from './runtime-environment.js'
import { approvedCommand, assertInstalledUvEvidence, parseUvVersion, toRequest, type ApprovedRuntimeCommandRunner, type InstalledUv } from './uv-installer.js'

export interface SpecKitInstallerOptions {
  readonly layout: WorkspaceLayout
  readonly environment: Readonly<Record<string, string>>
  readonly plan: InstallPlan
  readonly installedUv: InstalledUv
  readonly manifest: SpecKitManifest
  readonly architecture: 'arm64' | 'x64'
  readonly downloader: ArtifactDownloader
  readonly runCommand: ApprovedRuntimeCommandRunner['run']
}

const installedSpecKitBrand: unique symbol = Symbol('InstalledSpecKit')
export interface InstalledSpecKit { readonly [installedSpecKitBrand]: true; readonly pythonPath: string; readonly pythonSha256: string; readonly specifyPath: string; readonly provenancePath: string; readonly specifySha256: string; readonly runtimeClosure: readonly RuntimeTreePrecondition[] }
interface ProvenanceArtifact extends InstallPlanArtifact { readonly path: string }
interface ProvenanceCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly executionFingerprint: string
  readonly networkPolicy: 'deny'
  readonly result: 'ok' | 'uv 0.12.3' | 'Python 3.13.15' | '0.16.5'
}
interface RuntimeProvenanceContent {
  readonly schemaVersion: 3
  readonly offlineInstall: true
  readonly artifacts: readonly ProvenanceArtifact[]
  readonly uv: { readonly version: '0.12.3'; readonly path: string; readonly uvxPath: string; readonly executableSha256: string; readonly uvxSha256: string }
  readonly python: { readonly version: '3.13.15'; readonly path: string; readonly sha256: string }
  readonly specify: { readonly version: '0.16.5'; readonly path: string; readonly sha256: string }
  readonly runtimeClosure: readonly RuntimeTreePrecondition[]
  readonly commands: readonly ProvenanceCommand[]
  readonly completedAt: string
}
export interface RuntimeProvenance extends RuntimeProvenanceContent { readonly fingerprint: string }
export interface SpecKitInstallerTestHooks { readonly beforeProvenanceTemporaryUnlink?: (target: string) => Promise<void> }
let hooks: SpecKitInstallerTestHooks = {}
const issuedSpecKitEvidence = new WeakMap<object, { readonly root: string; readonly provenance: string; readonly pythonSha256: string; readonly specifySha256: string; readonly runtimeClosure: string }>()
const RUNTIME_CLOSURE_PATHS = Object.freeze(['.backend-team/runtime/python', '.backend-team/runtime/spec-kit/.venv'] as const)
export function __setSpecKitInstallerTestHooksForTest(value: SpecKitInstallerTestHooks): () => void { const old = hooks; hooks = value; return () => { hooks = old } }

/** Installs through exact pre-fetched artifacts and a callback-scoped command capability. */
export class SpecKitInstaller {
  constructor(private readonly options: SpecKitInstallerOptions) {}

  async ensureInstalled(): Promise<InstalledSpecKit> {
    assertRuntimeEnvironment(this.options.layout, this.options.environment)
    const venv = runtimePath(this.options.layout, 'spec-kit/.venv')
    const python = runtimePythonPath(this.options.layout)
    const specify = runtimePath(this.options.layout, `spec-kit/.venv/bin/${this.options.manifest.executable}`)
    const uv = runtimePath(this.options.layout, 'bin/uv')
    await assertInstalledUvEvidence(this.options.installedUv, this.options.layout, this.options.plan)
    const selected = approvedSpecKitArtifacts(this.options)
    const fetched = await this.fetchAll(selected)
    const wheelPaths = fetched.filter((entry) => entry.artifact.component !== 'python').map((entry) => entry.path)
    if (await exists(venv) || await exists(runtimePath(this.options.layout, 'spec-kit/provenance.json'))) {
      await assertPythonExecutable(python, venv, this.options.layout); await assertPythonVersion(venv, this.options.layout)
      await assertVenvExecutable(specify, venv, 'Spec Kit executable')
      const provenancePath = runtimePath(this.options.layout, 'spec-kit/provenance.json')
      await validateProvenance(provenancePath, this.options, python, specify, wheelPaths)
      return issueInstalledSpecKit(this.options.layout, python, specify, provenancePath)
    }

    const completed: ProvenanceCommand[] = []
    if (this.options.installedUv.versionEvidence === 'executed') completed.push(completedCommand(this.options.installedUv.verifiedCommand, 'uv 0.12.3'))
    else {
      const uvVersion = await this.run(uv, ['--version'], dirname(uv), 'verify recovered workspace-local uv', completed)
      if (parseUvVersion(uvVersion.stdout, this.options.architecture) === undefined) throw new Error('recovered workspace-local uv version verification failed')
    }
    await this.run(uv, ['python', 'install', '--offline', this.options.manifest.python], dirname(uv), 'install pinned workspace Python', completed)
    await this.run(uv, ['venv', '--offline', '--python', this.options.manifest.python, venv], dirname(uv), 'create workspace Spec Kit venv', completed)
    await assertPythonExecutable(python, venv, this.options.layout); await assertPythonVersion(venv, this.options.layout)
    const pythonVersion = await this.run(python, ['--version'], dirname(python), 'verify workspace Python', completed)
    if (parsePythonVersion(pythonVersion) === undefined) throw new Error('workspace Python version verification failed')
    await this.run(uv, ['pip', 'install', '--offline', '--no-index', '--no-deps', '--python', python, ...wheelPaths], dirname(uv), 'install pinned Spec Kit wheel closure', completed)
    await this.run(uv, ['pip', 'check', '--offline', '--python', python], dirname(uv), 'verify pinned Spec Kit wheel closure', completed)
    await assertVenvExecutable(specify, venv, 'Spec Kit executable')
    const version = await this.run(specify, ['--version'], dirname(specify), 'verify workspace Spec Kit', completed)
    if (parseSpecifyVersion(version.stdout) === undefined) throw new Error('workspace Spec Kit version verification failed')
    const provenancePath = await writeProvenance(this.options, python, specify, completed)
    return issueInstalledSpecKit(this.options.layout, python, specify, provenancePath)
  }

  private async fetchAll(artifacts: readonly InstallPlanArtifact[]): Promise<readonly { readonly artifact: InstallPlanArtifact; readonly path: string }[]> {
    const fetched: { artifact: InstallPlanArtifact; path: string }[] = []
    for (const artifact of artifacts) {
      const destination = resolve(this.options.layout.root, artifact.destination)
      assertInside(this.options.layout.root, destination, 'runtime artifact')
      const path = await this.options.downloader.fetch({ component: artifact.component, version: artifact.version, license: artifact.license, source: artifact.source, url: artifact.url, allowedHosts: artifact.allowedHosts, destination, bytes: artifact.bytes, sha256: artifact.sha256 })
      if (path !== destination) throw new Error('runtime artifact downloader returned an unexpected destination')
      fetched.push(Object.freeze({ artifact, path }))
    }
    return Object.freeze(fetched)
  }

  private async run(executable: string, args: readonly string[], cwd: string, purpose: string, completed: ProvenanceCommand[]): Promise<CommandResult> {
    const command = approvedCommand(this.options.plan, executable, args, cwd, this.options.environment)
    if (command.networkPolicy !== 'deny') throw new Error('runtime install command must deny network access')
    const result = await this.options.runCommand(toRequest(command, purpose))
    if (result.exitCode !== 0 || result.outputLimitExceeded === true) throw new Error(`${purpose} failed: ${result.stderr}`)
    completed.push(completedCommand(command, safeResult(args, result, this.options.architecture)))
    return result
  }
}

export async function assertInstalledSpecKitEvidence(installed: InstalledSpecKit, layout: WorkspaceLayout): Promise<InstalledSpecKit> {
  const issued = issuedSpecKitEvidence.get(installed)
  if (issued === undefined || issued.root !== layout.root || installed.specifyPath !== runtimePath(layout, 'spec-kit/.venv/bin/specify') || installed.provenancePath !== runtimePath(layout, 'spec-kit/provenance.json') || installed.pythonPath !== runtimePythonPath(layout)) throw new Error('Spec Kit evidence is not verified for this workspace')
  const provenance = await readRuntimeProvenance(installed.provenancePath)
  const currentSpecify = await executableSha256(installed.specifyPath, layout)
  const currentPython = await executableSha256(await realpath(installed.pythonPath), layout)
  const currentClosure = await snapshotRuntimeClosure(layout)
  if (provenance.specify.path !== installed.specifyPath || provenance.specify.sha256 !== issued.specifySha256 || installed.specifySha256 !== issued.specifySha256 || currentSpecify !== issued.specifySha256 || provenance.python.path !== installed.pythonPath || provenance.python.sha256 !== issued.pythonSha256 || installed.pythonSha256 !== issued.pythonSha256 || currentPython !== issued.pythonSha256 || JSON.stringify(provenance.runtimeClosure) !== issued.runtimeClosure || JSON.stringify(installed.runtimeClosure) !== issued.runtimeClosure || JSON.stringify(currentClosure) !== issued.runtimeClosure || sha256Canonical(provenance) !== issued.provenance) throw new Error('Spec Kit execution closure evidence changed')
  return installed
}

async function issueInstalledSpecKit(layout: WorkspaceLayout, pythonPath: string, specifyPath: string, provenancePath: string): Promise<InstalledSpecKit> {
  const provenance = await readRuntimeProvenance(provenancePath)
  const specifySha256 = await executableSha256(specifyPath, layout)
  const pythonSha256 = await executableSha256(await realpath(pythonPath), layout)
  const runtimeClosure = await snapshotRuntimeClosure(layout)
  if (provenance.specify.path !== specifyPath || provenance.specify.sha256 !== specifySha256 || provenance.python.path !== pythonPath || provenance.python.sha256 !== pythonSha256 || JSON.stringify(provenance.runtimeClosure) !== JSON.stringify(runtimeClosure)) throw new Error('Spec Kit provenance does not match execution closure evidence')
  const installed = Object.freeze({ [installedSpecKitBrand]: true as const, pythonPath, pythonSha256, specifyPath, provenancePath, specifySha256, runtimeClosure })
  issuedSpecKitEvidence.set(installed, Object.freeze({ root: layout.root, provenance: sha256Canonical(provenance), pythonSha256, specifySha256, runtimeClosure: JSON.stringify(runtimeClosure) }))
  return installed
}

function approvedSpecKitArtifacts(options: SpecKitInstallerOptions): readonly InstallPlanArtifact[] {
  const selected = selectSpecKitArtifacts(options.manifest, options.architecture)
  if (options.plan.intent !== 'runtime-install' || options.plan.artifacts.length !== selected.length + 1 || options.plan.artifacts.filter((artifact) => artifact.component === 'uv').length !== 1) throw new Error('runtime install plan does not contain the exact composite artifact closure')
  const approved = selected.map((artifact) => {
    const matched = options.plan.artifacts.find((candidate) => sameArtifact(candidate, artifact))
    if (matched === undefined) throw new Error(`runtime install plan does not approve ${artifact.destination}`)
    return Object.freeze({ ...matched, allowedHosts: Object.freeze([...matched.allowedHosts]) })
  })
  if (new Set(approved.map((artifact) => artifact.destination)).size !== approved.length) throw new Error('runtime install plan has duplicate Spec Kit artifact destinations')
  return Object.freeze(approved)
}
function sameArtifact(left: InstallPlanArtifact, right: RuntimeArtifact): boolean { return left.component === right.component && left.version === right.version && left.license === right.license && left.source === right.source && left.url === right.url && left.bytes === right.bytes && left.sha256 === right.sha256 && left.destination === right.destination && sameStrings(left.allowedHosts, right.allowedHosts) }

async function assertPythonExecutable(path: string, venv: string, layout: WorkspaceLayout): Promise<void> {
  if (!isAbsolute(path) || !inside(venv, path)) throw new Error('Python executable path must remain inside the workspace venv')
  const canonical = await realpath(path)
  const managedPython = runtimePath(layout, 'python')
  if (!inside(venv, canonical) && !inside(managedPython, canonical)) throw new Error('Python executable target escapes the workspace-managed Python runtime')
  const details = await lstat(canonical)
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) throw new Error('Python venv executable is unsafe')
}
async function assertVenvExecutable(path: string, venv: string, label: string): Promise<void> {
  if (!isAbsolute(path) || !inside(venv, path)) throw new Error(`${label} path must remain inside the workspace venv`)
  const canonical = await realpath(path)
  if (!inside(venv, canonical)) throw new Error(`${label} target escapes workspace-local venv`)
  const details = await lstat(canonical)
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) throw new Error(`${label} venv executable is unsafe`)
}
async function executableSha256(path: string, layout: WorkspaceLayout): Promise<string> {
  assertInside(layout.root, path, 'Spec Kit executable')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('Spec Kit executable is unsafe')
    const first = await sha256Handle(handle); const second = await sha256Handle(handle)
    const final = await handle.stat(); const finalPath = await lstat(path)
    if (first !== second || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino) throw new Error('Spec Kit executable changed')
    return first
  } finally { await handle.close() }
}
async function assertPythonVersion(venv: string, layout: WorkspaceLayout): Promise<void> {
  const path = resolve(venv, 'pyvenv.cfg')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const details = await handle.stat(); const current = await lstat(path)
    if (!details.isFile() || details.nlink !== 1 || details.size > 16 * 1024 || current.isSymbolicLink() || details.dev !== current.dev || details.ino !== current.ino) throw new Error('workspace venv Python configuration is unsafe')
    const config = await handle.readFile({ encoding: 'utf8' })
    const final = await handle.stat(); const finalPath = await lstat(path)
    if (final.dev !== details.dev || final.ino !== details.ino || final.size !== details.size || finalPath.isSymbolicLink() || finalPath.dev !== details.dev || finalPath.ino !== details.ino) throw new Error('workspace venv Python configuration changed')
    const fields = new Map<string, string>()
    for (const line of config.split(/\r?\n/u)) {
      if (line.length === 0) continue
      const match = /^([a-z][a-z0-9_-]*) = (.+)$/u.exec(line)
      if (match === null || fields.has(match[1]!)) throw new Error('workspace venv Python configuration is invalid')
      fields.set(match[1]!, match[2]!)
    }
    if (fields.get('version_info') !== '3.13.15' || fields.get('implementation') !== 'CPython' || fields.get('uv') !== '0.12.3' || fields.get('include-system-site-packages') !== 'false') throw new Error('workspace venv Python version is invalid')
    const home = fields.get('home')
    if (home === undefined || !isAbsolute(home)) throw new Error('workspace venv Python home is invalid')
    const canonicalHome = await realpath(home); const managedPython = runtimePath(layout, 'python')
    if (!inside(managedPython, canonicalHome) || !(await lstat(canonicalHome)).isDirectory()) throw new Error('workspace venv Python home escapes the managed runtime')
  } finally { await handle.close() }
}

async function writeProvenance(options: SpecKitInstallerOptions, python: string, specify: string, commands: readonly ProvenanceCommand[]): Promise<string> {
  const target = runtimePath(options.layout, 'spec-kit/provenance.json'); const parent = dirname(target)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const runtimeClosure = await snapshotRuntimeClosure(options.layout)
  const content: RuntimeProvenanceContent = {
    schemaVersion: 3,
    offlineInstall: true,
    artifacts: provenanceArtifacts(options),
    uv: { version: '0.12.3', path: options.installedUv.uvPath, uvxPath: options.installedUv.uvxPath, executableSha256: options.installedUv.uvSha256, uvxSha256: options.installedUv.uvxSha256 },
    python: { version: '3.13.15', path: python, sha256: await executableSha256(await realpath(python), options.layout) },
    specify: { version: '0.16.5', path: specify, sha256: await executableSha256(specify, options.layout) },
    runtimeClosure,
    commands: Object.freeze([...commands]),
    completedAt: new Date().toISOString(),
  }
  const data: RuntimeProvenance = { ...content, fingerprint: sha256Canonical(content) }
  const bytes = Buffer.from(`${JSON.stringify(data)}\n`)
  const temporary = `${target}.tmp-${randomUUID()}`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.chmod(0o600); await handle.sync() } finally { await handle.close() }
  let owner: { readonly dev: number; readonly ino: number } | undefined; let linked = false
  try {
    const current = await lstat(temporary)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) throw new Error('provenance temporary file is unsafe')
    owner = { dev: current.dev, ino: current.ino }
    const { link } = await import('node:fs/promises'); await link(temporary, target); linked = true
    await assertPrivateIdentity(target, owner, 2)
    await hooks.beforeProvenanceTemporaryUnlink?.(target)
    await unlinkPrivate(temporary, owner, 2)
    await assertPrivateIdentity(target, owner, 1)
  } finally { if (owner !== undefined && !linked) await removePrivate(temporary, owner) }
  return target
}

export async function readRuntimeProvenance(path: string): Promise<RuntimeProvenance> {
  const value = await readProvenanceValue(path)
  if (!record(value) || !keys(value, ['schemaVersion', 'offlineInstall', 'artifacts', 'uv', 'python', 'specify', 'runtimeClosure', 'commands', 'completedAt', 'fingerprint']) || value.schemaVersion !== 3 || value.offlineInstall !== true || !canonicalTimestamp(value.completedAt) || !sha(value.fingerprint) || !Array.isArray(value.artifacts) || value.artifacts.length < 2 || !value.artifacts.every(validArtifact) || !record(value.uv) || !keys(value.uv, ['version', 'path', 'uvxPath', 'executableSha256', 'uvxSha256']) || value.uv.version !== '0.12.3' || typeof value.uv.path !== 'string' || typeof value.uv.uvxPath !== 'string' || !sha(value.uv.executableSha256) || !sha(value.uv.uvxSha256) || !record(value.python) || !keys(value.python, ['version', 'path', 'sha256']) || value.python.version !== '3.13.15' || typeof value.python.path !== 'string' || !sha(value.python.sha256) || !record(value.specify) || !keys(value.specify, ['version', 'path', 'sha256']) || value.specify.version !== '0.16.5' || typeof value.specify.path !== 'string' || !sha(value.specify.sha256) || !validRuntimeClosure(value.runtimeClosure) || !Array.isArray(value.commands) || value.commands.length !== 7 || !value.commands.every(validCommand)) throw new Error('runtime provenance is invalid')
  const provenance = value as unknown as RuntimeProvenance
  const { fingerprint, ...content } = provenance
  if (sha256Canonical(content) !== fingerprint) throw new Error('runtime provenance fingerprint does not match its canonical content')
  return provenance
}
async function readProvenanceValue(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat(); const current = await lstat(path)
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024 || current.isSymbolicLink() || before.dev !== current.dev || before.ino !== current.ino) throw new Error('runtime provenance file is unsafe')
    const bytes = await handle.readFile(); const after = await handle.stat(); const finalPath = await lstat(path)
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || finalPath.dev !== before.dev || finalPath.ino !== before.ino) throw new Error('runtime provenance changed during read')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally { await handle.close() }
}

async function validateProvenance(path: string, options: SpecKitInstallerOptions, python: string, specify: string, wheelPaths: readonly string[]): Promise<void> {
  const provenance = await readRuntimeProvenance(path)
  const expectedArtifacts = provenanceArtifacts(options)
  const runtimeClosure = await snapshotRuntimeClosure(options.layout)
  if (provenance.uv.path !== options.installedUv.uvPath || provenance.uv.uvxPath !== options.installedUv.uvxPath || provenance.uv.executableSha256 !== options.installedUv.uvSha256 || provenance.uv.uvxSha256 !== options.installedUv.uvxSha256 || provenance.python.path !== python || provenance.python.sha256 !== await executableSha256(await realpath(python), options.layout) || provenance.specify.path !== specify || provenance.specify.sha256 !== await executableSha256(specify, options.layout) || JSON.stringify(provenance.runtimeClosure) !== JSON.stringify(runtimeClosure) || JSON.stringify(provenance.artifacts) !== JSON.stringify(expectedArtifacts) || !sameCommands(provenance.commands, expectedCommands(options, python, specify, wheelPaths))) throw new Error('runtime provenance does not match verified execution closure')
}
async function snapshotRuntimeClosure(layout: WorkspaceLayout): Promise<readonly RuntimeTreePrecondition[]> {
  const allowed = [...RUNTIME_CLOSURE_PATHS]
  const entries: RuntimeTreePrecondition[] = []
  for (const path of RUNTIME_CLOSURE_PATHS) entries.push(Object.freeze({ path, sha256: await sha256WorkspaceTree(layout.root, path, allowed) }))
  return Object.freeze(entries)
}
function provenanceArtifacts(options: SpecKitInstallerOptions): readonly ProvenanceArtifact[] { return Object.freeze(options.plan.artifacts.map((artifact) => Object.freeze({ ...artifact, allowedHosts: Object.freeze([...artifact.allowedHosts]), path: resolve(options.layout.root, artifact.destination) }))) }
function expectedCommands(options: SpecKitInstallerOptions, python: string, specify: string, wheelPaths: readonly string[]): readonly ProvenanceCommand[] {
  const uv = options.installedUv.uvPath; const env = options.environment; const cwd = dirname(uv); const venv = runtimePath(options.layout, 'spec-kit/.venv')
  const make = (executable: string, args: readonly string[], commandCwd: string, result: ProvenanceCommand['result']) => completedCommand(approvedCommand(options.plan, executable, args, commandCwd, env), result)
  return Object.freeze([
    completedCommand(options.installedUv.verifiedCommand, 'uv 0.12.3'),
    make(uv, ['python', 'install', '--offline', options.manifest.python], cwd, 'ok'),
    make(uv, ['venv', '--offline', '--python', options.manifest.python, venv], cwd, 'ok'),
    make(python, ['--version'], dirname(python), 'Python 3.13.15'),
    make(uv, ['pip', 'install', '--offline', '--no-index', '--no-deps', '--python', python, ...wheelPaths], cwd, 'ok'),
    make(uv, ['pip', 'check', '--offline', '--python', python], cwd, 'ok'),
    make(specify, ['--version'], dirname(specify), '0.16.5'),
  ])
}
function completedCommand(command: InstallPlanCommand, result: ProvenanceCommand['result']): ProvenanceCommand {
  if (command.networkPolicy !== 'deny') throw new Error('runtime provenance requires deny-network command evidence')
  return Object.freeze({ executable: command.executable, args: Object.freeze([...command.args]), cwd: command.cwd, env: Object.freeze({ ...command.env }), executionFingerprint: command.executionFingerprint, networkPolicy: 'deny', result })
}
function validArtifact(value: unknown): boolean { return record(value) && keys(value, ['component', 'version', 'license', 'source', 'url', 'bytes', 'sha256', 'allowedHosts', 'destination', 'path']) && typeof value.component === 'string' && value.component.length > 0 && typeof value.version === 'string' && value.version.length > 0 && typeof value.license === 'string' && value.license.length > 0 && typeof value.source === 'string' && value.source.length > 0 && typeof value.url === 'string' && safeArtifactUrl(value.url) && Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0 && sha(value.sha256) && Array.isArray(value.allowedHosts) && value.allowedHosts.length > 0 && value.allowedHosts.every((host) => typeof host === 'string' && host.length > 0) && typeof value.destination === 'string' && typeof value.path === 'string' }
function validCommand(value: unknown): boolean {
  if (!record(value) || !keys(value, ['executable', 'args', 'cwd', 'env', 'executionFingerprint', 'networkPolicy', 'result']) || typeof value.executable !== 'string' || !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string') || typeof value.cwd !== 'string' || !record(value.env) || !Object.values(value.env).every((entry) => typeof entry === 'string') || !sha(value.executionFingerprint) || value.networkPolicy !== 'deny' || (value.result !== 'ok' && value.result !== 'uv 0.12.3' && value.result !== 'Python 3.13.15' && value.result !== '0.16.5')) return false
  return value.executionFingerprint === sha256Canonical({ executable: value.executable, args: value.args, cwd: value.cwd, env: value.env, codeWillExecute: true, networkPolicy: 'deny' })
}
function validRuntimeClosure(value: unknown): value is readonly RuntimeTreePrecondition[] { return Array.isArray(value) && value.length === RUNTIME_CLOSURE_PATHS.length && value.every((entry, index) => record(entry) && keys(entry, ['path', 'sha256']) && entry.path === RUNTIME_CLOSURE_PATHS[index] && sha(entry.sha256)) }
function safeResult(args: readonly string[], result: CommandResult, architecture: 'arm64' | 'x64'): ProvenanceCommand['result'] { if (args[0] === '--version' && parseUvVersion(result.stdout, architecture) !== undefined) return 'uv 0.12.3'; if (args[0] === '--version' && parsePythonVersion(result) !== undefined) return 'Python 3.13.15'; if (args[0] === '--version' && parseSpecifyVersion(result.stdout) !== undefined) return '0.16.5'; return 'ok' }
function parsePythonVersion(result: CommandResult): 'Python 3.13.15' | undefined { return /^Python 3\.13\.15\r?\n?$/u.test(result.stdout) ? 'Python 3.13.15' : undefined }
export function parseSpecifyVersion(value: string): '0.16.5' | undefined { return /^specify 0\.16\.5\r?\n?$/u.test(value) ? '0.16.5' : undefined }
function sameCommands(left: readonly ProvenanceCommand[], right: readonly ProvenanceCommand[]): boolean { return JSON.stringify(left) === JSON.stringify(right) }
async function sha256Handle(handle: Awaited<ReturnType<typeof open>>): Promise<string> { const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0; for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (bytesRead === 0) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead } return hash.digest('hex') }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function unlinkPrivate(path: string, owner: { readonly dev: number; readonly ino: number }, links: number): Promise<void> { const current = await lstat(path); if (!current.isFile() || current.isSymbolicLink() || current.nlink !== links || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error('refusing to remove replaced provenance temporary'); await unlink(path) }
async function removePrivate(path: string, owner: { readonly dev: number; readonly ino: number }): Promise<void> { try { await unlinkPrivate(path, owner, 1) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
async function assertPrivateIdentity(path: string, owner: { readonly dev: number; readonly ino: number }, links: number): Promise<void> { const current = await lstat(path); if (!current.isFile() || current.isSymbolicLink() || current.nlink !== links || current.dev !== owner.dev || current.ino !== owner.ino || (current.mode & 0o777) !== 0o600) throw new Error('provenance publication was replaced') }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]) }
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function safeArtifactUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' } catch { return false } }
function canonicalTimestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
function assertInside(root: string, path: string, label: string): void { if (!inside(root, path)) throw new Error(`${label} escapes workspace runtime`) }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]) }
