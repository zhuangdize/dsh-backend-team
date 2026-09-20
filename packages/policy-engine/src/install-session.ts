import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PolicyAction, PolicyContext } from '@dsh-backend-team/contracts'
import { sha256Canonical, sha256WorkspaceTree } from '@dsh-backend-team/core'
import { ApprovalTokenService, type CommandExecutionEvidence } from './approval-token.js'

export interface InstallPlanArtifact { readonly component: string; readonly version: string; readonly license: string; readonly source: string; readonly url: string; readonly bytes: number; readonly sha256: string; readonly allowedHosts: readonly string[]; readonly destination: string }
export interface ManagedPathPrecondition { readonly path: string; readonly state: 'missing' | 'directory' | 'file'; readonly dev?: number; readonly ino?: number; readonly mode?: number; readonly size?: number; readonly sha256?: string }
export interface RuntimeTreePrecondition { readonly path: string; readonly sha256: string }
export type NetworkPolicy = 'deny' | 'allow'
export interface InstallPlanCommand { readonly executable: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly executionFingerprint: string; readonly codeWillExecute: boolean; readonly networkPolicy: NetworkPolicy; readonly expectedExecutableSha256?: string }
export type InstallPlanIntent = 'runtime-install' | 'spec-kit-init'
export interface InstallPlan { readonly intent: InstallPlanIntent; readonly tool: string; readonly version: string; readonly source: string; readonly license: string; readonly destination: string; readonly artifacts: readonly InstallPlanArtifact[]; readonly commands: readonly InstallPlanCommand[]; readonly managedPaths: readonly ManagedPathPrecondition[]; readonly runtimeClosure?: readonly RuntimeTreePrecondition[] }
export interface InstallArtifactScope { readonly component: string; readonly version: string; readonly license: string; readonly source: string; readonly url: string; readonly allowedHosts: readonly string[]; readonly destination: string; readonly bytes: number; readonly sha256: string }
export interface ApprovedInstallArtifactCapability { executeApprovedArtifact<T>(scope: InstallArtifactScope, signal: AbortSignal, operation: () => Promise<T>): Promise<T> }
export interface ApprovedInstallCommandCapability { executeApprovedInstallCommand<T>(command: InstallPlanCommand, operation: (evidence: CommandExecutionEvidence) => Promise<T>): Promise<T> }
export interface ApprovedInstallSession { readonly artifacts: ApprovedInstallArtifactCapability; readonly commands: ApprovedInstallCommandCapability }
export interface InstallSessionExecution { readonly workspaceRoot: string; readonly context: PolicyContext; readonly plan: InstallPlan }

interface InstallSessionTestHooks {
  readonly afterPlanSnapshot?: () => Promise<void>
  readonly afterCommandSnapshot?: () => Promise<void>
}
let installSessionTestHooks: InstallSessionTestHooks = {}
/** Package-internal deterministic interleaving hook; intentionally absent from the public barrel. */
export function __setInstallSessionTestHooksForTest(hooks: InstallSessionTestHooks): () => void {
  const previous = installSessionTestHooks
  installSessionTestHooks = hooks
  return () => { installSessionTestHooks = previous }
}

export class InstallSessionService {
  constructor(private readonly tokens: ApprovalTokenService) {}

  async execute<T>(token: string, input: InstallSessionExecution, callback: (session: ApprovedInstallSession) => Promise<T>): Promise<T> {
    const plan = snapshotInstallPlan(input.plan)
    assertPlanIntentSemantics(plan)
    await installSessionTestHooks.afterPlanSnapshot?.()
    const workspaceRoot = await realpath(input.workspaceRoot)
    if (workspaceRoot !== await realpath(input.context.workspace.root)) throw new Error('install session workspace does not match policy context')
    validatePlan(plan, workspaceRoot)
    await assertCurrentManagedPreconditions(plan, workspaceRoot)
    await assertCurrentRuntimeClosure(plan, workspaceRoot)
    await assertCurrentArtifacts(plan, workspaceRoot, true)
    const consumed = await this.tokens.consume(token, { kind: 'install', workspaceRoot, context: input.context, action: installApprovalAction(plan) })
    if (!consumed) throw new Error('install approval token was rejected')
    let active = true
    let accepting = true
    const inFlight = new Set<Promise<unknown>>()
    const assertAvailable = () => { if (!active || !accepting) throw new Error('approved install session is closed') }
    const track = <R>(operation: () => Promise<R>): Promise<R> => {
      const pending = operation()
      inFlight.add(pending)
      void pending.then(() => { inFlight.delete(pending) }, () => { inFlight.delete(pending) })
      return pending
    }
    const session: ApprovedInstallSession = Object.freeze({
      artifacts: Object.freeze({ executeApprovedArtifact: async <R>(scope: InstallArtifactScope, signal: AbortSignal, operation: () => Promise<R>): Promise<R> => {
        const snapshot = snapshotArtifactScope(scope)
        assertAvailable(); assertArtifactScope(plan, workspaceRoot, snapshot)
        return track(async () => { assertAvailable(); if (signal.aborted) throw abortError(); return operation() })
      } }),
      commands: Object.freeze({ executeApprovedInstallCommand: async <R>(command: InstallPlanCommand, operation: (evidence: CommandExecutionEvidence) => Promise<R>): Promise<R> => {
        const snapshot = snapshotInstallCommand(command)
        assertAvailable(); assertCommandScope(plan, snapshot)
        return track(async () => {
          await installSessionTestHooks.afterCommandSnapshot?.()
          assertAvailable()
          await assertCurrentManagedPreconditions(plan, workspaceRoot)
          await assertCurrentRuntimeClosure(plan, workspaceRoot)
          await assertCurrentArtifacts(plan, workspaceRoot, false)
          let result: R | undefined
          let commandError: unknown
          try { result = await executeVerifiedInstallCommand(snapshot, workspaceRoot, async (evidence) => { assertAvailable(); return operation(evidence) }) } catch (error: unknown) { commandError = error }
          try { await assertCurrentRuntimeClosure(plan, workspaceRoot); await assertCurrentArtifacts(plan, workspaceRoot, false) } catch (verificationError: unknown) {
            if (commandError !== undefined) throw new AggregateError([commandError, verificationError], 'install command failed and runtime artifact integrity changed')
            throw verificationError
          }
          if (commandError !== undefined) throw commandError
          return result as R
        })
      } }),
    })
    try { return await callback(session) } finally {
      accepting = false
      await Promise.allSettled([...inFlight])
      active = false
    }
  }
}

export function installApprovalDigest(plan: InstallPlan): string {
  assertPlanIntentSemantics(plan)
  /* The init action itself is an authorization boundary: a caller must not be
   * able to mint a digest for a weak hand-written init plan and only fail later. */
  if (plan.intent === 'spec-kit-init') {
    const cwd = plan.commands[0]?.cwd
    if (cwd === undefined || !isAbsolute(cwd)) throw new Error('spec-kit-init approval requires an absolute workspace cwd')
    validatePlan(plan, resolve(cwd))
  }
  return sha256Canonical(plan)
}
export function installApprovalAction(plan: InstallPlan): Extract<PolicyAction, { kind: 'install' }> { return { kind: 'install', packages: [`install-plan:${installApprovalDigest(plan)}`] } }

function validatePlan(plan: InstallPlan, workspaceRoot: string): void {
  if (!isRecord(plan) || (plan.intent !== 'runtime-install' && plan.intent !== 'spec-kit-init') || !nonEmpty(plan.tool) || !nonEmpty(plan.version) || !nonEmpty(plan.source) || !nonEmpty(plan.license) || !nonEmpty(plan.destination) || !Array.isArray(plan.artifacts) || !Array.isArray(plan.commands) || !Array.isArray(plan.managedPaths)) throw new Error('invalid install plan')
  assertPlanIntentSemantics(plan)
  const destination = resolve(workspaceRoot, plan.destination)
  if (!inside(workspaceRoot, destination)) throw new Error('install destination must remain inside the workspace')
  const destinations = new Set<string>()
  if (plan.intent === 'runtime-install' && plan.artifacts.length < 2) throw new Error('runtime-install plan must contain the composite uv and Spec Kit artifact closure')
  for (const artifact of plan.artifacts) { if (destinations.has(artifact.destination)) throw new Error('install artifact destinations must be unique'); destinations.add(artifact.destination); if (!inside(workspaceRoot, resolve(workspaceRoot, artifact.destination))) throw new Error('install artifact destination escapes workspace') }
  for (const artifact of plan.artifacts) validateArtifact(artifact)
  for (const command of plan.commands) validateCommand(command)
  validateManagedPaths(plan, workspaceRoot)
  validateRuntimeClosure(plan)
  assertSpecKitInitPlan(plan, workspaceRoot)
}
function validateArtifact(artifact: InstallPlanArtifact): void {
  if (!isRecord(artifact) || !exactKeys(artifact, ['allowedHosts', 'bytes', 'component', 'destination', 'license', 'sha256', 'source', 'url', 'version']) || !nonEmpty(artifact.component) || !nonEmpty(artifact.version) || !nonEmpty(artifact.license) || !nonEmpty(artifact.source) || !nonEmpty(artifact.url) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !Array.isArray(artifact.allowedHosts) || artifact.allowedHosts.length === 0 || !artifact.allowedHosts.every(nonEmpty) || !nonEmpty(artifact.destination) || !isWorkspaceRelative(artifact.destination)) throw new Error('invalid install plan artifact')
  validateApprovedUrl(artifact.url, artifact.allowedHosts)
}
function validateCommand(command: InstallPlanCommand): void {
  if (!isRecord(command) || !nonEmpty(command.executable) || !Array.isArray(command.args) || !command.args.every((value) => typeof value === 'string') || !nonEmpty(command.cwd) || !isRecord(command.env) || !Object.values(command.env).every((value) => typeof value === 'string') || typeof command.codeWillExecute !== 'boolean' || command.networkPolicy !== 'deny' || typeof command.executionFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(command.executionFingerprint) || (command.expectedExecutableSha256 !== undefined && !validSha(command.expectedExecutableSha256))) throw new Error('runtime/install commands must deny network access')
  const canonical = { executable: command.executable, args: command.args, cwd: command.cwd, env: command.env, codeWillExecute: command.codeWillExecute, networkPolicy: command.networkPolicy, ...(command.expectedExecutableSha256 === undefined ? {} : { expectedExecutableSha256: command.expectedExecutableSha256 }) }
  if (command.executionFingerprint !== sha256Canonical(canonical)) throw new Error('install command fingerprint does not bind network policy and command fields')
}
function assertPlanIntentSemantics(plan: InstallPlan): void {
  if (!Array.isArray(plan.managedPaths)) throw new Error('install plan managed preconditions are required')
  if (plan.intent === 'runtime-install' && plan.commands.some((command) => basename(command.executable).toLowerCase() === 'specify' && command.args.includes('init'))) throw new Error('specify init requires a separate spec-kit-init install plan')
  if (plan.intent === 'runtime-install' && (plan.managedPaths.length !== 0 || (plan.runtimeClosure?.length ?? 0) !== 0)) throw new Error('runtime-install plan must not contain managed or runtime closure preconditions')
  if (plan.intent === 'spec-kit-init' && (plan.managedPaths.length < 2 || plan.commands.length !== 1 || !validSha(plan.commands[0]!.expectedExecutableSha256) || plan.runtimeClosure?.length !== 2)) throw new Error('spec-kit-init requires managed preconditions, executable hash, and complete runtime closure')
}
function validateManagedPaths(plan: InstallPlan, workspaceRoot: string): void {
  const roots = ['.specify', '.backend-team/runtime/spec-kit/commands']
  const seen = new Set<string>()
  for (const path of plan.managedPaths) {
    if (!isRecord(path) || !nonEmpty(path.path) || isAbsolute(path.path) || path.path.includes('\0') || path.path.split('/').some((part) => part === '' || part === '.' || part === '..') || seen.has(path.path) || !roots.some((root) => path.path === root || path.path.startsWith(`${root}/`)) || !['missing', 'directory', 'file'].includes(path.state)) throw new Error('invalid managed precondition')
    seen.add(path.path); const target = resolve(workspaceRoot, path.path); if (!inside(workspaceRoot, target)) throw new Error('managed precondition escapes workspace')
    if (path.state === 'missing') { if (path.dev !== undefined || path.ino !== undefined || path.mode !== undefined || path.size !== undefined || path.sha256 !== undefined) throw new Error('invalid missing managed precondition') } else if (!Number.isSafeInteger(path.dev) || !Number.isSafeInteger(path.ino) || !Number.isSafeInteger(path.mode) || !Number.isSafeInteger(path.size) || (path.state === 'file' && !validSha(path.sha256)) || (path.state === 'directory' && path.sha256 !== undefined)) throw new Error('invalid managed precondition identity')
  }
  if (plan.intent === 'spec-kit-init') {
    if (!roots.every((root) => seen.has(root)) || plan.managedPaths.length !== seen.size || !sameStrings(plan.managedPaths.map((item) => item.path), [...plan.managedPaths].map((item) => item.path).sort())) throw new Error('spec-kit-init managed preconditions must be complete and sorted')
  }
}
function validateRuntimeClosure(plan: InstallPlan): void {
  const closure = plan.runtimeClosure ?? []
  const expectedPaths = ['.backend-team/runtime/python', '.backend-team/runtime/spec-kit/.venv']
  if (!Array.isArray(closure) || closure.some((entry) => !isRecord(entry) || !exactKeys(entry, ['path', 'sha256']) || !nonEmpty(entry.path) || !validSha(entry.sha256))) throw new Error('invalid runtime closure precondition')
  if (plan.intent === 'spec-kit-init' && (!sameStrings(closure.map((entry) => entry.path), expectedPaths) || new Set(closure.map((entry) => entry.path)).size !== expectedPaths.length)) throw new Error('spec-kit-init runtime closure must contain the exact executable trees')
}
function assertSpecKitInitPlan(plan: InstallPlan, workspaceRoot: string): void {
  if (plan.intent !== 'spec-kit-init') return
  const executable = resolve(workspaceRoot, '.backend-team/runtime/spec-kit/.venv/bin/specify')
  const expectedArgs = ['init', '--here', '--force', '--non-interactive', '--script', 'sh', '--integration', 'generic', '--integration-options=--commands-dir .backend-team/runtime/spec-kit/commands', '--ignore-agent-tools']
  const expectedEnv = specKitEnvironment(workspaceRoot)
  const command = plan.commands[0]
  if (plan.tool !== 'specify-cli' || plan.version !== '0.16.5' || plan.source !== 'https://github.com/github/spec-kit/tree/v0.16.5' || plan.license !== 'MIT' || plan.destination !== '.specify' || plan.artifacts.length !== 0 || command === undefined || command.executable !== executable || command.cwd !== workspaceRoot || !sameStrings(command.args, expectedArgs) || !sameRecord(command.env, expectedEnv) || command.codeWillExecute !== true || command.networkPolicy !== 'deny' || !validSha(command.expectedExecutableSha256) || command.executionFingerprint !== sha256Canonical({ executable, args: expectedArgs, cwd: workspaceRoot, env: expectedEnv, codeWillExecute: true, networkPolicy: 'deny', expectedExecutableSha256: command.expectedExecutableSha256 })) throw new Error('spec-kit-init plan does not match the pinned official contract')
}
function specKitEnvironment(root: string): Readonly<Record<string, string>> {
  const base = resolve(root, '.backend-team')
  const bin = resolve(base, 'runtime/bin')
  return { HOME: base, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: resolve(base, 'cache'), XDG_CACHE_HOME: resolve(base, 'cache'), XDG_CONFIG_HOME: resolve(base, 'state'), XDG_DATA_HOME: resolve(base, 'runtime'), XDG_STATE_HOME: resolve(base, 'state'), UV_PROJECT_ENVIRONMENT: resolve(base, 'runtime/spec-kit/.venv'), UV_CACHE_DIR: resolve(base, 'cache/uv'), UV_PYTHON_INSTALL_DIR: resolve(base, 'runtime/python'), UV_PYTHON_BIN_DIR: bin, UV_PYTHON_INSTALL_BIN: '0', UV_TOOL_DIR: resolve(base, 'runtime/uv-tools'), UV_TOOL_BIN_DIR: bin, UV_NO_SYSTEM_CONFIG: '1', UV_NO_CONFIG: '1', UV_NO_MODIFY_PATH: '1', UV_PYTHON_PREFERENCE: 'only-managed', UV_PYTHON_DOWNLOADS: 'manual', UV_PYTHON_INSTALL_MIRROR: pathToFileURL(resolve(base, 'cache/python-mirror')).href, UV_OFFLINE: '1', PIP_CONFIG_FILE: '/dev/null', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
}
function assertArtifactScope(plan: InstallPlan, workspaceRoot: string, scope: InstallArtifactScope): void {
  const matched = plan.artifacts.some((artifact) => scope.component === artifact.component && scope.version === artifact.version && scope.license === artifact.license && scope.source === artifact.source && scope.destination === resolve(workspaceRoot, artifact.destination) && scope.bytes === artifact.bytes && scope.sha256 === artifact.sha256 && sameStrings(scope.allowedHosts, artifact.allowedHosts) && isAuthorizedArtifactUrl(scope.url, artifact))
  if (!matched) throw new Error('approved artifact scope mismatch')
}
function assertCommandScope(plan: InstallPlan, command: InstallPlanCommand): void {
  if (!plan.commands.some((approved) => sameCommand(approved, command))) throw new Error('approved command scope mismatch')
}
function isAuthorizedArtifactUrl(url: string, artifact: InstallPlanArtifact): boolean {
  if (url === artifact.url) return true
  try { validateApprovedUrl(url, artifact.allowedHosts); return true } catch { return false }
}
function validateApprovedUrl(value: string, allowedHosts: readonly string[]): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || !allowedHosts.includes(url.hostname)) throw new Error('approved artifact URL is invalid')
}
function sameCommand(left: InstallPlanCommand, right: InstallPlanCommand): boolean { return left.executable === right.executable && left.cwd === right.cwd && left.executionFingerprint === right.executionFingerprint && left.codeWillExecute === right.codeWillExecute && left.networkPolicy === right.networkPolicy && left.expectedExecutableSha256 === right.expectedExecutableSha256 && sameStrings(left.args, right.args) && sameRecord(left.env, right.env) }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]) }
function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean { const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort(); return sameStrings(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key]) }
function abortError(): Error { const error = new Error('install operation aborted'); error.name = 'AbortError'; return error }
function inside(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function snapshotInstallPlan(plan: InstallPlan): InstallPlan {
  const artifacts = plan.artifacts.map((artifact) => Object.freeze({ component: artifact.component, version: artifact.version, license: artifact.license, source: artifact.source, url: artifact.url, bytes: artifact.bytes, sha256: artifact.sha256, allowedHosts: Object.freeze([...artifact.allowedHosts]), destination: artifact.destination }))
  const commands = plan.commands.map(snapshotInstallCommand)
  const managedPaths = plan.managedPaths.map((item) => Object.freeze({ ...item }))
  const runtimeClosure = plan.runtimeClosure?.map((item) => Object.freeze({ path: item.path, sha256: item.sha256 }))
  return Object.freeze({ intent: plan.intent, tool: plan.tool, version: plan.version, source: plan.source, license: plan.license, destination: plan.destination, artifacts: Object.freeze(artifacts), commands: Object.freeze(commands), managedPaths: Object.freeze(managedPaths), ...(runtimeClosure === undefined ? {} : { runtimeClosure: Object.freeze(runtimeClosure) }) })
}
function snapshotArtifactScope(scope: InstallArtifactScope): InstallArtifactScope { if (!exactKeys(scope as unknown as Record<string, unknown>, ['allowedHosts', 'bytes', 'component', 'destination', 'license', 'sha256', 'source', 'url', 'version'])) throw new Error('approved artifact scope has unexpected fields'); return Object.freeze({ component: scope.component, version: scope.version, license: scope.license, source: scope.source, url: scope.url, allowedHosts: Object.freeze([...scope.allowedHosts]), destination: scope.destination, bytes: scope.bytes, sha256: scope.sha256 }) }
function snapshotInstallCommand(command: InstallPlanCommand): InstallPlanCommand { const expectedKeys = command.expectedExecutableSha256 === undefined ? ['args', 'codeWillExecute', 'cwd', 'env', 'executable', 'executionFingerprint', 'networkPolicy'] : ['args', 'codeWillExecute', 'cwd', 'env', 'executable', 'executionFingerprint', 'expectedExecutableSha256', 'networkPolicy']; if (!exactKeys(command as unknown as Record<string, unknown>, expectedKeys)) throw new Error('approved command has unexpected fields'); return Object.freeze({ executable: command.executable, args: Object.freeze([...command.args]), cwd: command.cwd, env: Object.freeze({ ...command.env }), executionFingerprint: command.executionFingerprint, codeWillExecute: command.codeWillExecute, networkPolicy: command.networkPolicy, ...(command.expectedExecutableSha256 === undefined ? {} : { expectedExecutableSha256: command.expectedExecutableSha256 }) }) }

/** Re-reads the entire controlled tree through nofollow handles.  This catches
 * replacement before token use and once more immediately before the spawn boundary;
 * a same-UID actor can still race after this last check (the OS does not offer an
 * atomic directory transaction here). */
async function assertCurrentManagedPreconditions(plan: InstallPlan, workspaceRoot: string): Promise<void> {
  if (plan.managedPaths.length === 0) return
  const actual: ManagedPathPrecondition[] = []
  await snapshotManagedPath(workspaceRoot, '.backend-team/runtime/spec-kit/commands', actual)
  await snapshotManagedPath(workspaceRoot, '.specify', actual)
  actual.sort((a, b) => a.path.localeCompare(b.path))
  if (JSON.stringify(actual) !== JSON.stringify(plan.managedPaths)) throw new Error('managed precondition snapshot changed')
}
async function assertCurrentRuntimeClosure(plan: InstallPlan, workspaceRoot: string): Promise<void> {
  const closure = plan.runtimeClosure ?? []
  if (closure.length === 0) return
  const allowed = closure.map((entry) => entry.path)
  for (const expected of closure) {
    const current = await sha256WorkspaceTree(workspaceRoot, expected.path, allowed)
    if (current !== expected.sha256) throw new Error(`approved runtime closure changed: ${expected.path}`)
  }
}
async function assertCurrentArtifacts(plan: InstallPlan, workspaceRoot: string, allowMissing: boolean): Promise<void> {
  for (const artifact of plan.artifacts) {
    const path = resolve(workspaceRoot, artifact.destination)
    await assertArtifactAncestors(workspaceRoot, dirname(path))
    try { await lstat(`${path}.partial`); throw new Error(`partial runtime artifact exists: ${artifact.destination}`) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let before: Awaited<ReturnType<typeof lstat>>
    try { before = await lstat(path) } catch (error: unknown) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`approved runtime artifact is missing: ${artifact.destination}`)
      throw error
    }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size !== artifact.bytes || (before.mode & 0o777) !== 0o600) throw new Error(`approved runtime artifact identity changed: ${artifact.destination}`)
    const canonical = await realpath(path)
    if (canonical !== path || !inside(workspaceRoot, canonical)) throw new Error(`approved runtime artifact escapes workspace: ${artifact.destination}`)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat(); const first = await sha256Handle(handle); const second = await sha256Handle(handle); const after = await handle.stat(); const current = await lstat(path)
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== artifact.bytes || (opened.mode & 0o777) !== 0o600 || first !== artifact.sha256 || second !== first || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(`approved runtime artifact bytes or identity changed: ${artifact.destination}`)
    } finally { await handle.close() }
  }
}
async function assertArtifactAncestors(workspaceRoot: string, parent: string): Promise<void> {
  const rel = relative(workspaceRoot, parent)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('runtime artifact parent escapes workspace')
  let current = workspaceRoot
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    try { const details = await lstat(current); if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('runtime artifact parent is unsafe') } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
}
async function snapshotManagedPath(root: string, relativePath: string, out: ManagedPathPrecondition[]): Promise<void> {
  const path = resolve(root, relativePath)
  let before: Awaited<ReturnType<typeof lstat>>
  try { before = await lstat(path) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try { await lstat(path); throw new Error('managed path appeared during snapshot') } catch (second: unknown) { if ((second as NodeJS.ErrnoException).code !== 'ENOENT') throw second }
    out.push({ path: relativePath, state: 'missing' }); return
  }
  if (before.isSymbolicLink()) throw new Error('managed path contains symlink')
  if (before.isDirectory()) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat(); const current = await lstat(path)
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(opened, current)) throw new Error('managed directory identity changed')
      out.push({ path: relativePath, state: 'directory', dev: opened.dev, ino: opened.ino, mode: opened.mode & 0o777, size: opened.size })
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new Error('managed path contains symlink')
        await snapshotManagedPath(root, `${relativePath}/${entry.name}`, out)
      }
      const final = await lstat(path); if (!final.isDirectory() || final.isSymbolicLink() || !sameIdentity(opened, final)) throw new Error('managed directory identity changed')
    } finally { await handle.close() }
    return
  }
  if (!before.isFile() || before.nlink !== 1) throw new Error('managed path is not a regular file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || !sameIdentity(opened, current)) throw new Error('managed file identity changed')
    const first = await sha256Handle(handle); const second = await sha256Handle(handle); const final = await handle.stat(); const finalPath = await lstat(path)
    if (first !== second || !sameIdentity(opened, final) || !sameIdentity(opened, finalPath) || final.size !== opened.size) throw new Error('managed file changed during snapshot')
    out.push({ path: relativePath, state: 'file', dev: opened.dev, ino: opened.ino, mode: opened.mode & 0o777, size: opened.size, sha256: first })
  } finally { await handle.close() }
}
function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino }

async function executeVerifiedInstallCommand<T>(command: InstallPlanCommand, workspaceRoot: string, operation: (evidence: CommandExecutionEvidence) => Promise<T>): Promise<T> {
  if (!isAbsolute(command.executable)) throw new Error('approved command executable must be absolute')
  const canonicalExecutable = await realpath(command.executable)
  const canonicalCwd = await realpath(command.cwd)
  if (!inside(workspaceRoot, canonicalCwd)) throw new Error('approved command cwd escapes workspace')
  const handle = await open(canonicalExecutable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat(); const currentPath = await realpath(canonicalExecutable); const current = await stat(currentPath)
    if (!opened.isFile() || opened.nlink !== 1 || currentPath !== canonicalExecutable || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('approved command executable is not a verified regular file')
    const executableContentDigest = await sha256Handle(handle)
    const final = await handle.stat(); const finalPath = await realpath(canonicalExecutable); const finalCurrent = await stat(finalPath)
    if (!final.isFile() || final.nlink !== 1 || finalPath !== canonicalExecutable || final.dev !== finalCurrent.dev || final.ino !== finalCurrent.ino || await sha256Handle(handle) !== executableContentDigest || (command.expectedExecutableSha256 !== undefined && executableContentDigest !== command.expectedExecutableSha256)) throw new Error('approved command executable identity changed')
    const evidence = Object.freeze({ canonicalExecutable, executableContentDigest, canonicalCwd, args: Object.freeze([...command.args]), env: Object.freeze({ ...command.env }), executionFingerprint: command.executionFingerprint })
    return await operation(evidence)
  } finally { await handle.close() }
}
async function sha256Handle(handle: FileHandle): Promise<string> { const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0; for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (bytesRead === 0) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead } return hash.digest('hex') }
function validSha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function isWorkspaceRelative(value: string): boolean { return !value.includes('\0') && !value.startsWith('/') && !value.split('/').some((part) => part === '' || part === '.' || part === '..') }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { return sameStrings(Object.keys(value).sort(), [...expected].sort()) }
