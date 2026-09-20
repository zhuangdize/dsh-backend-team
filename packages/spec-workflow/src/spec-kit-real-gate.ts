import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { BackendTeamState, PolicyContext, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { FileStateStore, sha256Canonical } from '@dsh-backend-team/core'
import { ApprovalTokenService, DefaultPolicyEngine, InstallSessionService, installApprovalAction } from '@dsh-backend-team/policy-engine'
import { ArtifactDownloader, NodeCommandRunner, createWorkspaceLayout, initializeWorkspaceLayout, type CommandExecutor } from '@dsh-backend-team/platform-macos'
import { buildInstallPlan, type InstallPlan, type InstallPlanCommand } from './install-plan.js'
import { buildRuntimeEnvironment, runtimePath, runtimePythonPath } from './runtime-environment.js'
import { parseSpecKitManifest, parseUvManifest, selectSpecKitArtifacts, type RuntimeManifest } from './runtime-manifest.js'
import { SpecKitAdapter, type PreparedSpecKitInitialization, type SpecKitInstallSession, type SpecKitSessionCommandCapability } from './spec-kit-adapter.js'
import { SpecKitCommandLoader } from './spec-kit-command-loader.js'
import { readRuntimeProvenance, SpecKitInstaller, type InstalledSpecKit } from './spec-kit-installer.js'
import { UvInstaller } from './uv-installer.js'

const COMMAND_IDS = Object.freeze(['speckit.specify', 'speckit.clarify', 'speckit.plan', 'speckit.tasks', 'speckit.analyze'] as const)
const RUNTIME_APPROVAL_ENV = 'DSH_REAL_RUNTIME_INSTALL_APPROVAL'
const INIT_APPROVAL_ENV = 'DSH_REAL_SPEC_KIT_INIT_APPROVAL'
const GATE_ROOT_ENV = 'DSH_REAL_SPEC_KIT_GATE_ROOT'
const WORKSPACE_ENV = 'DSH_REAL_SPEC_KIT_WORKSPACE'
const EVIDENCE_RELATIVE_PATH = 'spec-kit-real-gate-evidence.json'

/** Test-only, externally supplied approval record. No approval token is persisted. */
export interface RealGateApprovalMaterial { readonly schemaVersion: 1; readonly intent: 'runtime-install' | 'spec-kit-init'; readonly approvalDigest: string }
export interface RealGateBlocked { readonly status: 'BLOCKED'; readonly gate: 'spec-kit-real-cli'; readonly reason: string; readonly required?: readonly string[]; readonly plan?: InstallPlan; readonly approvalDigest?: string }
export interface RealGateLoadedCommand { readonly id: typeof COMMAND_IDS[number]; readonly sourceSha256: string }

export function parseRealGateApprovalMaterial(value: string, expectedIntent: RealGateApprovalMaterial['intent']): RealGateApprovalMaterial {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('real gate approval material is invalid JSON') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('real gate approval material is invalid')
  const record = parsed as Record<string, unknown>; const keys = Object.keys(record).sort()
  if (keys.length !== 3 || keys[0] !== 'approvalDigest' || keys[1] !== 'intent' || keys[2] !== 'schemaVersion' || record.schemaVersion !== 1 || record.intent !== expectedIntent || typeof record.approvalDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.approvalDigest)) throw new Error('real gate approval material schema is invalid')
  return Object.freeze({ schemaVersion: 1, intent: expectedIntent, approvalDigest: record.approvalDigest })
}

/** A controller may only advance each irreversible real-world stage after the exact plan digest supplied by an external approver. */
export function requireRealGateApproval(material: RealGateApprovalMaterial | undefined, plan: InstallPlan): void {
  if (material === undefined || material.intent !== plan.intent || material.approvalDigest !== sha256Canonical(plan)) throw new Error(JSON.stringify(blockedForPlan(plan)))
}
export function blockedForMissingMaterials(): RealGateBlocked { return Object.freeze({ status: 'BLOCKED', gate: 'spec-kit-real-cli', reason: 'MISSING_EXTERNAL_APPROVAL_MATERIALS', required: Object.freeze([RUNTIME_APPROVAL_ENV, INIT_APPROVAL_ENV]) }) }
export function blockedForPlan(plan: InstallPlan): RealGateBlocked { return Object.freeze({ status: 'BLOCKED', gate: 'spec-kit-real-cli', reason: `MISSING_OR_MISMATCHED_${plan.intent.toUpperCase()}_APPROVAL`, plan, approvalDigest: sha256Canonical(plan) }) }
export function blockedForMissingGateEnvironment(): RealGateBlocked { return Object.freeze({ status: 'BLOCKED', gate: 'spec-kit-real-cli', reason: 'MISSING_REAL_GATE_ENVIRONMENT', required: Object.freeze([GATE_ROOT_ENV, WORKSPACE_ENV, RUNTIME_APPROVAL_ENV, INIT_APPROVAL_ENV]) }) }

export interface RealSpecKitGateEvidenceInput {
  readonly runtimePlan: InstallPlan
  readonly initPlan: InstallPlan
  readonly commands: readonly RealGateLoadedCommand[]
  readonly beforeOutside: string
  readonly afterOutside: string
}
export interface RealSpecKitGateDependencies {
  readonly runtimePlan: () => Promise<InstallPlan>
  readonly installRuntime: () => Promise<void>
  readonly initPlan: () => Promise<InstallPlan>
  readonly initialize: () => Promise<void>
  readonly loadCommand: (id: typeof COMMAND_IDS[number]) => Promise<RealGateLoadedCommand>
  readonly outsideSnapshot: () => Promise<string>
  readonly writeEvidence: (value: RealSpecKitGateEvidenceInput) => Promise<void>
}
export interface RealSpecKitGateOptions { readonly runtimeMaterial?: string; readonly initMaterial?: string; readonly dependencies: RealSpecKitGateDependencies }
export interface CreateRealSpecKitGateDependenciesOptions {
  readonly gateRoot: string
  readonly workspaceRoot: string
  readonly repositoryRoot: string
  readonly platform?: NodeJS.Platform
  readonly architecture?: NodeJS.Architecture
}
interface CreateRealSpecKitGateTestDependenciesOptions extends CreateRealSpecKitGateDependenciesOptions { readonly fetch?: typeof globalThis.fetch; readonly commandExecutor?: CommandExecutor; readonly manifests?: RuntimeManifest }

/**
 * Staged controller used by the real-gate harness. Dependencies deliberately own
 * process/network work so fixture tests can prove that an absent or mismatched
 * approval reaches no side effect. Callers may resume at init after runtime exists.
 */
export async function runRealSpecKitGate(options?: RealSpecKitGateOptions): Promise<void> {
  if (options === undefined) throw new Error(JSON.stringify(blockedForMissingMaterials()))
  const beforeOutside = await options.dependencies.outsideSnapshot()
  const runtimePlan = await options.dependencies.runtimePlan()
  const runtime = approvalForStage(options.runtimeMaterial, 'runtime-install', runtimePlan)
  requireRealGateApproval(runtime, runtimePlan)
  await options.dependencies.installRuntime()
  const afterRuntimeOutside = await options.dependencies.outsideSnapshot()
  if (beforeOutside !== afterRuntimeOutside) throw new Error('real gate isolation snapshot changed outside its workspace')
  const initPlan = await options.dependencies.initPlan()
  const init = approvalForStage(options.initMaterial, 'spec-kit-init', initPlan)
  requireRealGateApproval(init, initPlan)
  await options.dependencies.initialize()
  const commands: RealGateLoadedCommand[] = []
  for (const command of COMMAND_IDS) commands.push(await options.dependencies.loadCommand(command))
  const afterOutside = await options.dependencies.outsideSnapshot()
  if (beforeOutside !== afterOutside) throw new Error('real gate isolation snapshot changed outside its workspace')
  await options.dependencies.writeEvidence({ runtimePlan, initPlan, commands: Object.freeze(commands), beforeOutside, afterOutside })
}

/** Strict production entry point used by the conditionally enabled integration gate. */
export async function createRealSpecKitGateOptionsFromEnvironment(environment: Readonly<Record<string, string | undefined>>): Promise<RealSpecKitGateOptions> {
  const gateRoot = environment[GATE_ROOT_ENV]
  const workspaceRoot = environment[WORKSPACE_ENV]
  if (gateRoot === undefined || gateRoot.length === 0 || workspaceRoot === undefined || workspaceRoot.length === 0) throw new Error(JSON.stringify(blockedForMissingGateEnvironment()))
  let dependencies: RealSpecKitGateDependencies
  try {
    dependencies = await createRealSpecKitGateDependencies({ gateRoot, workspaceRoot, repositoryRoot: process.cwd() })
  } catch (error: unknown) {
    if (isBlockedError(error)) throw error
    throw new Error(JSON.stringify({ status: 'BLOCKED', gate: 'spec-kit-real-cli', reason: 'INVALID_REAL_GATE_ENVIRONMENT', required: [GATE_ROOT_ENV, WORKSPACE_ENV] } satisfies RealGateBlocked))
  }
  return Object.freeze({
    ...(environment[RUNTIME_APPROVAL_ENV] === undefined ? {} : { runtimeMaterial: environment[RUNTIME_APPROVAL_ENV] }),
    ...(environment[INIT_APPROVAL_ENV] === undefined ? {} : { initMaterial: environment[INIT_APPROVAL_ENV] }),
    dependencies,
  })
}

/**
 * Concrete persistent-workspace adapter. The caller must provision the complete
 * gate fixture. Construction validates and plans read-only; layout/state creation,
 * token issuance, fetch, and command execution start only inside installRuntime().
 */
export async function createRealSpecKitGateDependencies(options: CreateRealSpecKitGateDependenciesOptions): Promise<RealSpecKitGateDependencies> {
  return createRealSpecKitGateDependenciesInternal(options)
}

/** Test-only dependency seam; intentionally absent from the package barrel. */
export async function __createRealSpecKitGateDependenciesForTest(options: CreateRealSpecKitGateTestDependenciesOptions): Promise<RealSpecKitGateDependencies> {
  return createRealSpecKitGateDependenciesInternal(options)
}

async function createRealSpecKitGateDependenciesInternal(options: CreateRealSpecKitGateTestDependenciesOptions): Promise<RealSpecKitGateDependencies> {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  if (platform !== 'darwin' || (architecture !== 'arm64' && architecture !== 'x64')) throw new Error(JSON.stringify({ status: 'BLOCKED', gate: 'spec-kit-real-cli', reason: 'UNSUPPORTED_REAL_GATE_PLATFORM' } satisfies RealGateBlocked))
  const repositoryRoot = await requireCanonicalDirectory(options.repositoryRoot, 'real gate repository root')
  const gateRoot = await requireCanonicalDirectory(options.gateRoot, 'real gate root')
  const workspaceRoot = await requireWorkspaceRoot(options.workspaceRoot, gateRoot)
  await requireOutsideFixture(gateRoot)
  const layout = createWorkspaceLayout(workspaceRoot)
  const environment = buildRuntimeEnvironment(layout)
  const manifests = options.manifests ?? await readRuntimeManifests(repositoryRoot)
  const runtimePlan = buildRealSpecKitRuntimePlan(layout, manifests, architecture)
  const context: PolicyContext = Object.freeze({ phase: 'BUILD', workspace: layout })
  let installedSpecKit: InstalledSpecKit | undefined
  let adapter: SpecKitAdapter | undefined
  let prepared: PreparedSpecKitInitialization | undefined
  let initializedCommandsDirectory: string | undefined
  let servicesPromise: Promise<GateServices> | undefined
  const services = () => servicesPromise ??= createGateServices(layout, context, options.commandExecutor)

  const dependencies: RealSpecKitGateDependencies = {
    runtimePlan: async () => runtimePlan,
    installRuntime: async () => {
      await initializeWorkspaceLayout(layout)
      const active = await services()
      const token = await issueInstallToken(active.tokens, context, layout.root, runtimePlan)
      installedSpecKit = await active.sessions.execute(token, { workspaceRoot: layout.root, context, plan: runtimePlan }, async (session) => {
        const downloader = new ArtifactDownloader({ workspaceRoot: layout.root, capability: session.artifacts, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
        const execute = (request: import('@dsh-backend-team/contracts').CommandRequest) => active.runner.runApprovedInstall(session.commands, Object.freeze({ ...request, codeWillExecute: true as const }))
        const installedUv = await new UvInstaller({ layout, environment, plan: runtimePlan, artifact: runtimePlan.artifacts[0]!, manifest: manifests.uv, architecture, downloader, runCommand: execute }).ensureInstalled()
        return new SpecKitInstaller({ layout, environment, plan: runtimePlan, installedUv, manifest: manifests.specKit, architecture, downloader, runCommand: execute }).ensureInstalled()
      })
    },
    initPlan: async () => {
      if (installedSpecKit === undefined) throw new Error('real gate runtime evidence is unavailable')
      const active = await services()
      const adapterSession: SpecKitInstallSession = Object.freeze({
        async execute<T>(token: string, input: { readonly workspaceRoot: string; readonly context: PolicyContext; readonly plan: InstallPlan }, callback: (session: { readonly commands: SpecKitSessionCommandCapability }) => Promise<T>): Promise<T> {
          return active.sessions.execute<T>(token, input, (session) => callback(Object.freeze({ commands: session.commands })))
        },
      })
      adapter = new SpecKitAdapter({ layout, installedSpecKit, environment, context, session: adapterSession, runner: active.runner })
      prepared = await adapter.prepareInitialization()
      return prepared.plan
    },
    initialize: async () => {
      if (adapter === undefined || prepared === undefined) throw new Error('real gate initialization plan is unavailable')
      const active = await services()
      const token = await issueInstallToken(active.tokens, context, layout.root, prepared.plan)
      const initialized = await adapter.initialize(prepared, token)
      initializedCommandsDirectory = initialized.commandsDirectory
    },
    loadCommand: async (id) => {
      if (initializedCommandsDirectory === undefined) throw new Error('real gate generic commands are unavailable')
      const loaded = await new SpecKitCommandLoader({ commandsDirectory: initializedCommandsDirectory }).load(id, '')
      return Object.freeze({ id, sourceSha256: loaded.sourceSha256 })
    },
    outsideSnapshot: async () => snapshotOutsideFixture(gateRoot),
    writeEvidence: async (value) => {
      if (installedSpecKit === undefined) throw new Error('real gate runtime evidence is unavailable')
      const provenance = await readRuntimeProvenance(installedSpecKit.provenancePath)
      const commandSourceSha256 = Object.fromEntries(value.commands.map((command) => [command.id, command.sourceSha256]))
      const evidence = {
        schemaVersion: 1,
        runtimePlan: { plan: value.runtimePlan, approvalDigest: sha256Canonical(value.runtimePlan) },
        initPlan: { plan: value.initPlan, approvalDigest: sha256Canonical(value.initPlan) },
        runtime: { uv: provenance.uv.version, python: provenance.python.version, specKit: provenance.specify.version, provenanceFingerprint: provenance.fingerprint },
        commandSourceSha256,
        outside: { beforeSha256: sha256Snapshot(value.beforeOutside), afterSha256: sha256Snapshot(value.afterOutside), status: 'unchanged' as const },
      }
      await writeEvidenceFile(layout, `${JSON.stringify(evidence)}\n`)
    },
  }
  return Object.freeze(dependencies)
}

/** Builds the seven-command canonical offline runtime authorization contract. */
export function buildRealSpecKitRuntimePlan(layout: WorkspaceLayout, manifests: RuntimeManifest, architecture: 'arm64' | 'x64'): InstallPlan {
  const environment = buildRuntimeEnvironment(layout)
  const uv = runtimePath(layout, 'bin/uv')
  const venv = runtimePath(layout, 'spec-kit/.venv')
  const python = runtimePythonPath(layout)
  const specify = runtimePath(layout, 'spec-kit/.venv/bin/specify')
  const uvCwd = dirname(uv)
  const wheelPaths = selectSpecKitArtifacts(manifests.specKit, architecture).filter((artifact) => artifact.component !== 'python').map((artifact) => resolve(layout.root, artifact.destination))
  const commands = Object.freeze([
    runtimeCommand(uv, ['--version'], uvCwd, environment),
    runtimeCommand(uv, ['python', 'install', '--offline', '3.13.15'], uvCwd, environment),
    runtimeCommand(uv, ['venv', '--offline', '--python', '3.13.15', venv], uvCwd, environment),
    runtimeCommand(python, ['--version'], dirname(python), environment),
    runtimeCommand(uv, ['pip', 'install', '--offline', '--no-index', '--no-deps', '--python', python, ...wheelPaths], uvCwd, environment),
    runtimeCommand(uv, ['pip', 'check', '--offline', '--python', python], uvCwd, environment),
    runtimeCommand(specify, ['--version'], dirname(specify), environment),
  ])
  return buildInstallPlan(layout, manifests, architecture, commands, '.backend-team/cache/downloads/uv-0.12.3.tar.gz')
}

interface GateServices { readonly tokens: ApprovalTokenService; readonly sessions: InstallSessionService; readonly runner: NodeCommandRunner }

async function createGateServices(layout: WorkspaceLayout, context: PolicyContext, commandExecutor: CommandExecutor | undefined): Promise<GateServices> {
  const store = new FileStateStore(layout.root)
  if (await store.load() === null) {
    const state: BackendTeamState = { schemaVersion: 1, revision: 0, workspaceRoot: store.workspaceRoot, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] }
    await store.create(state)
  }
  const tokens = new ApprovalTokenService(store)
  const sessions = new InstallSessionService(tokens)
  const runner = new NodeCommandRunner({ context, policyEngine: new DefaultPolicyEngine(), approvalTokens: tokens, ...(commandExecutor === undefined ? {} : { executor: commandExecutor }) })
  return Object.freeze({ tokens, sessions, runner })
}

async function issueInstallToken(tokens: ApprovalTokenService, context: PolicyContext, workspaceRoot: string, plan: InstallPlan): Promise<string> {
  return tokens.issue({ kind: 'install', workspaceRoot, context, action: installApprovalAction(plan), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() })
}

function runtimeCommand(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): InstallPlanCommand {
  const base = Object.freeze({ executable, args: Object.freeze([...args]), cwd, env: Object.freeze({ ...env }), codeWillExecute: true as const, networkPolicy: 'deny' as const })
  return Object.freeze({ ...base, executionFingerprint: sha256Canonical(base) })
}

async function readRuntimeManifests(repositoryRoot: string): Promise<RuntimeManifest> {
  const uvPath = resolve(repositoryRoot, 'runtime-manifests/uv-0.12.3.json')
  const specKitPath = resolve(repositoryRoot, 'runtime-manifests/spec-kit-0.16.5.json')
  const uv = parseUvManifest(await readManifestJson(uvPath, repositoryRoot))
  const specKit = parseSpecKitManifest(await readManifestJson(specKitPath, repositoryRoot))
  if (uv.version !== '0.12.3' || specKit.version !== '0.16.5' || specKit.python !== '3.13.15' || specKit.executable !== 'specify' || specKit.expectedVersion !== '0.16.5') throw new Error('real gate manifests do not match the pinned runtime contract')
  return Object.freeze({ uv, specKit })
}

async function readManifestJson(path: string, repositoryRoot: string): Promise<unknown> {
  if (!inside(repositoryRoot, path) || await realpath(path) !== path) throw new Error('real gate manifest escapes the repository')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 64 * 1024 || current.isSymbolicLink() || !sameIdentity(opened, current)) throw new Error('real gate manifest is unsafe')
    const bytes = await handle.readFile()
    const final = await handle.stat(); const finalPath = await lstat(path)
    if (!sameIdentity(opened, final) || !sameIdentity(opened, finalPath) || final.size !== opened.size) throw new Error('real gate manifest changed during read')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally { await handle.close() }
}

async function requireCanonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) throw new Error(`${label} must be an absolute canonical path`)
  const canonical = await realpath(path)
  const details = await lstat(path)
  if (canonical !== path || details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${label} must be a real directory`)
  return canonical
}

async function requireWorkspaceRoot(path: string, gateRoot: string): Promise<string> {
  const expected = resolve(gateRoot, 'workspace')
  if (path !== expected || dirname(path) !== gateRoot) throw new Error('real gate workspace must be the pre-existing canonical workspace child of the gate root')
  return requireCanonicalDirectory(path, 'real gate workspace')
}

async function requireOutsideFixture(gateRoot: string): Promise<void> {
  await requireCanonicalDirectory(resolve(gateRoot, 'fake-home'), 'real gate fake home')
  await requireCanonicalDirectory(resolve(gateRoot, 'fake-global-bin'), 'real gate fake global bin')
  await requireCanonicalRegularFile(resolve(gateRoot, 'parent-sentinel.txt'), gateRoot, 'real gate parent sentinel')
}

async function requireCanonicalRegularFile(path: string, root: string, label: string): Promise<void> {
  if (!inside(root, path) || await realpath(path) !== path) throw new Error(`${label} escapes the real gate root`)
  const details = await lstat(path)
  if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) throw new Error(`${label} must be a canonical regular file`)
}

async function snapshotOutsideFixture(gateRoot: string): Promise<string> {
  const entries: OutsideSnapshotEntry[] = []
  await snapshotOutsidePath(gateRoot, '.', entries)
  return JSON.stringify(entries.sort((left, right) => compareText(left.path, right.path)))
}

interface OutsideSnapshotEntry {
  readonly path: string
  readonly type: 'directory' | 'file'
  readonly mode: number
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly sha256?: string
}

async function snapshotOutsidePath(gateRoot: string, relativePath: string, entries: OutsideSnapshotEntry[]): Promise<void> {
  const path = relativePath === '.' ? gateRoot : resolve(gateRoot, relativePath)
  if (!inside(gateRoot, path) || await realpath(path) !== path) throw new Error('real gate outside snapshot path escapes its canonical root')
  const details = await lstat(path)
  if (details.isSymbolicLink()) throw new Error('real gate outside snapshot contains a symlink')
  if (details.isDirectory()) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat(); const current = await lstat(path)
      if (!opened.isDirectory() || current.isSymbolicLink() || !sameSnapshotMetadata(opened, current)) throw new Error('real gate outside snapshot directory changed')
      const names = (await readdir(path)).sort(compareText)
      for (const name of names) {
        const child = relativePath === '.' ? name : `${relativePath}/${name}`
        if (child === 'workspace') continue
        await snapshotOutsidePath(gateRoot, child, entries)
      }
      const final = await handle.stat(); const finalPath = await lstat(path)
      if (!final.isDirectory() || finalPath.isSymbolicLink() || !sameSnapshotMetadata(opened, final) || !sameSnapshotMetadata(opened, finalPath)) throw new Error('real gate outside snapshot directory changed')
      entries.push(snapshotEntry(relativePath, 'directory', opened))
    } finally { await handle.close() }
    return
  }
  if (!details.isFile() || details.nlink !== 1) throw new Error('real gate outside snapshot contains a non-regular file')
  entries.push(await snapshotOutsideFile(path, relativePath))
}

async function snapshotOutsideFile(path: string, relativePath: string): Promise<OutsideSnapshotEntry> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || current.nlink !== 1 || !sameSnapshotMetadata(opened, current)) throw new Error('real gate outside snapshot file is unsafe')
    const first = await readHandle(handle); const second = await readHandle(handle)
    const final = await handle.stat(); const finalPath = await lstat(path)
    if (!final.isFile() || finalPath.isSymbolicLink() || final.nlink !== 1 || finalPath.nlink !== 1 || !sameSnapshotMetadata(opened, final) || !sameSnapshotMetadata(opened, finalPath) || !first.equals(second)) throw new Error('real gate outside snapshot file changed during read')
    return snapshotEntry(relativePath, 'file', opened, createHash('sha256').update(first).digest('hex'))
  } finally { await handle.close() }
}

function snapshotEntry(path: string, type: OutsideSnapshotEntry['type'], details: { readonly mode: number; readonly dev: number; readonly ino: number; readonly size: number }, sha256?: string): OutsideSnapshotEntry {
  return Object.freeze({ path, type, mode: details.mode, dev: details.dev, ino: details.ino, size: details.size, ...(sha256 === undefined ? {} : { sha256 }) })
}

async function writeEvidenceFile(layout: WorkspaceLayout, content: string): Promise<void> {
  const path = resolve(layout.logsDir, EVIDENCE_RELATIVE_PATH)
  let existed = true
  try { const current = await lstat(path); if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) throw new Error('real gate evidence file is unsafe') } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') existed = false; else throw error }
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | (existed ? 0 : constants.O_EXCL) | constants.O_NOFOLLOW, 0o600)
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || !sameIdentity(opened, current)) throw new Error('real gate evidence file is unsafe')
    await handle.chmod(0o600)
    await handle.truncate(0)
    await handle.writeFile(content)
    await handle.sync()
    const final = await handle.stat(); const finalPath = await lstat(path)
    if (!sameIdentity(opened, final) || !sameIdentity(opened, finalPath)) throw new Error('real gate evidence file changed during write')
  } finally { await handle.close() }
}

async function readHandle(handle: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const chunks: Buffer[] = []
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    position += bytesRead
  }
  return Buffer.concat(chunks)
}

function approvalForStage(value: string | undefined, intent: RealGateApprovalMaterial['intent'], plan: InstallPlan): RealGateApprovalMaterial | undefined {
  if (value === undefined) return undefined
  try { return parseRealGateApprovalMaterial(value, intent) } catch { throw new Error(JSON.stringify(blockedForPlan(plan))) }
}
function sha256Snapshot(value: string): string { return sha256Canonical(JSON.parse(value) as unknown) }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino }
function sameSnapshotMetadata(left: { readonly dev: number; readonly ino: number; readonly mode: number; readonly size: number }, right: { readonly dev: number; readonly ino: number; readonly mode: number; readonly size: number }): boolean { return sameIdentity(left, right) && left.mode === right.mode && left.size === right.size }
function inside(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
function isBlockedError(error: unknown): boolean { if (!(error instanceof Error)) return false; try { return (JSON.parse(error.message) as { status?: unknown }).status === 'BLOCKED' } catch { return false } }
