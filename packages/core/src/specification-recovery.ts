import { constants, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { BackendTeamStateSchema, type BackendTeamPhase, type BackendTeamState, type StateStore } from '@dsh-backend-team/contracts'
import { sha256Canonical } from './content-hash.js'
import { sha256WorkspaceTree } from './workspace-tree.js'
import { phaseForArtifactPath } from './state-machine.js'

export interface RecoveryArtifactSnapshot {
  readonly featureDirectory?: string
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[]
}

export interface RecoveryArtifactRegistryPort {
  snapshot(): RecoveryArtifactSnapshot | Readonly<Record<string, string>> | Promise<RecoveryArtifactSnapshot | Readonly<Record<string, string>>>
}

export interface RecoveryIssue {
  readonly code: 'INVALID_STATE' | 'FEATURE_DIRECTORY_MISSING' | 'FEATURE_DIRECTORY_INVALID' | 'RUNTIME_PROVENANCE_MISSING' | 'RUNTIME_PROVENANCE_INVALID' | 'ARTIFACT_REGISTRY_MISSING' | 'STALE_APPROVAL' | 'MISSING_REQUIREMENTS_APPROVAL' | 'MISSING_DESIGN_APPROVAL' | 'ACTIVE_RUNTIME_LOCK' | 'UNSAFE_RUNTIME_LOCK'
  readonly message: string
  readonly paths?: readonly string[]
}

export interface RecoveryAudit {
  readonly status: 'ready' | 'blocked'
  readonly phase: BackendTeamPhase
  readonly lastVerifiedPhase: BackendTeamPhase
  readonly interruptedRunIds: readonly string[]
  readonly staleApprovalPaths: readonly string[]
  readonly cleanedLocks: readonly string[]
  readonly issues: readonly RecoveryIssue[]
}

export interface SpecificationRecoveryOptions {
  readonly stateStore: StateStore
  readonly workspaceRoot: string
  readonly artifactRegistry?: RecoveryArtifactRegistryPort
  readonly runtimeProvenancePath?: string
  readonly locksDirectory?: string
}

const PHASE_ORDER: readonly BackendTeamPhase[] = [
  'DISCOVER', 'SPECIFY', 'AWAIT_REQUIREMENTS_APPROVAL', 'DESIGN',
  'AWAIT_DESIGN_APPROVAL', 'PLAN', 'BUILD', 'VERIFY', 'DELIVER',
]

export class SpecificationRecovery {
  private readonly root: string
  private readonly stateStore: StateStore
  private readonly artifactRegistry: RecoveryArtifactRegistryPort | undefined
  private readonly runtimeProvenancePath: string
  private readonly locksDirectory: string

  constructor(options: SpecificationRecoveryOptions) {
    if (!isAbsolute(options.workspaceRoot) || options.workspaceRoot.includes('\0')) throw new TypeError('workspace root must be an absolute path')
    this.root = realpathSync.native(resolve(options.workspaceRoot))
    this.stateStore = options.stateStore
    this.artifactRegistry = options.artifactRegistry
    this.runtimeProvenancePath = resolveWorkspacePath(this.root, options.runtimeProvenancePath ?? '.backend-team/runtime/spec-kit/provenance.json')
    this.locksDirectory = resolveWorkspacePath(this.root, options.locksDirectory ?? '.backend-team/locks')
  }

  async audit(): Promise<RecoveryAudit> {
    const canonicalRoot = await realpath(this.root)
    const pathIssues: RecoveryIssue[] = []
    if (!(await pathInside(canonicalRoot, this.runtimeProvenancePath)) || !(await pathInside(canonicalRoot, this.locksDirectory))) {
      pathIssues.push(issue('UNSAFE_RUNTIME_LOCK', 'runtime provenance and lock paths must remain inside the workspace'))
    }
    if (pathIssues.length === 0) {
      try { await assertPrivateDirectory(canonicalRoot, this.locksDirectory) } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') pathIssues.push(issue('UNSAFE_RUNTIME_LOCK', `runtime lock directory is unsafe: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    const loaded = await this.stateStore.load()
    if (loaded === null) throw new Error('backend team state has not been created')
    let state: BackendTeamState
    try { state = BackendTeamStateSchema.parse(loaded) } catch (error: unknown) { throw new Error(`recovery state is invalid: ${error instanceof Error ? error.message : String(error)}`) }
    if (state.workspaceRoot !== canonicalRoot) throw new Error('recovery state workspace root does not match the workspace')

    const interruptedRunIds = state.runs.filter((run) => run.status === 'running').map((run) => run.id)
    if (interruptedRunIds.length > 0) {
      const interruptedAt = new Date().toISOString()
      state = await this.stateStore.transact(state.revision, (current) => ({
        ...current,
        runs: current.runs.map((run) => run.status === 'running'
          ? { ...run, status: 'interrupted' as const, completedAt: interruptedAt, summary: run.summary ?? 'interrupted during recovery' }
          : run),
      }))
    }

    const issues: RecoveryIssue[] = [...pathIssues]
    await this.validateFeatureDirectory(canonicalRoot, issues)
    await this.validateRuntimeProvenance(canonicalRoot, issues)
    const currentHashes = await this.readArtifactHashes(issues)
    const staleApprovalPaths = currentHashes === undefined ? [] : validateApprovals(state, currentHashes, issues)
    const cleanedLocks = issues.some(({ code }) => code === 'UNSAFE_RUNTIME_LOCK') ? [] : await this.reclaimLocks(canonicalRoot, issues)
    return Object.freeze({
      status: issues.length === 0 ? 'ready' : 'blocked',
      phase: state.phase,
      lastVerifiedPhase: state.phase,
      interruptedRunIds: Object.freeze(interruptedRunIds),
      staleApprovalPaths: Object.freeze(staleApprovalPaths),
      cleanedLocks: Object.freeze(cleanedLocks),
      issues: Object.freeze(issues),
    })
  }

  async resumeFromLastVerified(): Promise<BackendTeamState> {
    const audit = await this.audit()
    if (audit.status !== 'ready') throw new Error(`recovery blocked: ${audit.issues.map((issue) => issue.code).join(', ')}`)
    const state = await this.stateStore.load()
    if (state === null) throw new Error('backend team state disappeared during recovery')
    return state
  }

  private async readArtifactHashes(issues: RecoveryIssue[]): Promise<Readonly<Record<string, string>> | undefined> {
    if (this.artifactRegistry === undefined) {
      if (this.requiresApproval(await this.stateStore.load())) issues.push(issue('ARTIFACT_REGISTRY_MISSING', 'artifact registry is required to verify approval hashes'))
      return undefined
    }
    try {
      const value = await this.artifactRegistry.snapshot()
      const entries = isRecoverySnapshot(value) ? value.artifacts.map((artifact) => [artifact.path, artifact.sha256] as const) : Object.entries(value)
      if (entries.length === 0 || entries.some(([path, hash]) => path.length === 0 || !/^[a-f0-9]{64}$/u.test(hash))) throw new Error('artifact hash snapshot is invalid')
      return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))))
    } catch (error: unknown) {
      issues.push(issue('ARTIFACT_REGISTRY_MISSING', `artifact registry snapshot failed: ${error instanceof Error ? error.message : String(error)}`))
      return undefined
    }
  }

  private requiresApproval(state: BackendTeamState | null): boolean {
    return state !== null && phaseAtLeast(state.phase, 'DESIGN')
  }

  private async validateFeatureDirectory(root: string, issues: RecoveryIssue[]): Promise<void> {
    const featureFile = resolve(root, '.specify/feature.json')
    let raw: string
    try {
      raw = await readPrivateWorkspaceFile(root, featureFile)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { issues.push(issue('FEATURE_DIRECTORY_MISSING', '.specify/feature.json is missing')); return }
      issues.push(issue('FEATURE_DIRECTORY_INVALID', `cannot read .specify/feature.json: ${error instanceof Error ? error.message : String(error)}`)); return
    }
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      const declared = ['feature_directory', 'featureDirectory', 'directory', 'path'].map((key) => value[key]).find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
      if (declared === undefined) throw new Error('feature directory is not declared')
      const specsPath = resolve(root, 'specs')
      const specsDetails = await lstat(specsPath)
      if (specsDetails.isSymbolicLink() || !specsDetails.isDirectory() || await realpath(specsPath) !== specsPath) throw new Error('workspace specs directory is not canonical')
      const specs = specsPath
      const candidatePath = isAbsolute(declared) ? declared : resolve(root, declared)
      const candidateDetails = await lstat(candidatePath)
      const candidate = await realpath(candidatePath)
      if (candidateDetails.isSymbolicLink() || !inside(specs, candidate) || candidate === specs || !(await lstat(candidate)).isDirectory()) throw new Error('feature directory must remain below workspace/specs')
    } catch (error: unknown) {
      issues.push(issue('FEATURE_DIRECTORY_INVALID', `active feature directory is invalid: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  private async validateRuntimeProvenance(root: string, issues: RecoveryIssue[]): Promise<void> {
    let raw: string
    try {
      raw = await readPrivateWorkspaceFile(root, this.runtimeProvenancePath)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') issues.push(issue('RUNTIME_PROVENANCE_MISSING', 'workspace Spec Kit runtime provenance is missing'))
      else issues.push(issue('RUNTIME_PROVENANCE_INVALID', `cannot read runtime provenance: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      if (!record(value) || value.schemaVersion !== 3 || value.offlineInstall !== true || typeof value.fingerprint !== 'string' || !sha(value.fingerprint) || !Array.isArray(value.artifacts) || value.artifacts.length === 0 || !Array.isArray(value.commands) || value.commands.length !== 7) throw new Error('schema, artifact inventory, command count, or offline marker is invalid')
      const { fingerprint, ...content } = value
      if (sha256Canonical(content) !== fingerprint) throw new Error('provenance fingerprint does not match')
      const expectedPaths = {
        uv: resolve(root, '.backend-team/runtime/bin/uv'),
        uvx: resolve(root, '.backend-team/runtime/bin/uvx'),
        python: resolve(root, '.backend-team/runtime/spec-kit/.venv/bin/python'),
        specify: resolve(root, '.backend-team/runtime/spec-kit/.venv/bin/specify'),
      } as const
      if (!record(value.uv) || value.uv.version !== '0.12.3' || value.uv.path !== expectedPaths.uv || value.uv.uvxPath !== expectedPaths.uvx || !sha(value.uv.executableSha256) || !sha(value.uv.uvxSha256) || !record(value.python) || value.python.version !== '3.13.15' || value.python.path !== expectedPaths.python || !sha(value.python.sha256) || !record(value.specify) || value.specify.version !== '0.16.5' || value.specify.path !== expectedPaths.specify || !sha(value.specify.sha256)) throw new Error('runtime versions or executable paths are not the pinned values')
      if (await hashRuntimeExecutable(root, expectedPaths.uv, false) !== value.uv.executableSha256 || await hashRuntimeExecutable(root, expectedPaths.uvx, false) !== value.uv.uvxSha256 || await hashRuntimeExecutable(root, expectedPaths.python, true) !== value.python.sha256 || await hashRuntimeExecutable(root, expectedPaths.specify, false) !== value.specify.sha256) throw new Error('runtime executable hash does not match provenance')
      const closure = value.runtimeClosure
      if (!Array.isArray(closure) || closure.length !== 2 || JSON.stringify(closure.map((entry) => record(entry) ? entry.path : undefined)) !== JSON.stringify(['.backend-team/runtime/python', '.backend-team/runtime/spec-kit/.venv']) || !closure.every((entry) => record(entry) && sha(entry.sha256))) throw new Error('runtime closure is not the pinned structure')
      const closurePaths = ['.backend-team/runtime/python', '.backend-team/runtime/spec-kit/.venv'] as const
      for (const entry of closure) {
        if (!record(entry) || typeof entry.path !== 'string' || !inside(root, resolve(root, entry.path))) throw new Error('runtime closure escapes the workspace')
        const currentDigest = await sha256WorkspaceTree(root, entry.path, closurePaths)
        if (currentDigest !== entry.sha256) throw new Error(`runtime closure hash does not match ${entry.path}`)
      }
      if (!value.commands.every((command) => isValidCommand(root, command))) throw new Error('runtime command provenance is not an exact offline command record')
    } catch (error: unknown) {
      issues.push(issue('RUNTIME_PROVENANCE_INVALID', `runtime provenance is invalid: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  private async reclaimLocks(root: string, issues: RecoveryIssue[]): Promise<string[]> {
    const result: string[] = []
    let entries: Array<{ readonly name: string; isFile(): boolean }>
    try { entries = await readdir(this.locksDirectory, { withFileTypes: true }) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
      issues.push(issue('UNSAFE_RUNTIME_LOCK', `cannot inspect runtime locks: ${error instanceof Error ? error.message : String(error)}`)); return result
    }
    for (const entry of entries) {
      const path = resolve(this.locksDirectory, entry.name)
      if (!entry.isFile()) { issues.push(issue('UNSAFE_RUNTIME_LOCK', `runtime lock is not a regular file: ${path}`)); continue }
      try {
        const details = await lstat(path)
        if (details.isSymbolicLink() || details.nlink !== 1 || details.size > 8192) throw new Error('lock identity is unsafe')
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        let value: Record<string, unknown>
        try {
          const opened = await handle.stat()
          if (opened.dev !== details.dev || opened.ino !== details.ino || opened.nlink !== 1) throw new Error('lock identity changed while reading')
          value = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as Record<string, unknown>
          const after = await handle.stat()
          if (after.dev !== details.dev || after.ino !== details.ino || after.size !== opened.size) throw new Error('lock changed while reading')
        } finally { await handle.close() }
        if (!record(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.nonce) || value.workspaceRoot !== root) throw new Error('lock owner is not workspace-owned')
        if (processAlive(Number(value.pid))) { issues.push(issue('ACTIVE_RUNTIME_LOCK', `runtime lock is held by process ${value.pid}: ${path}`)); continue }
        const current = await lstat(path)
        if (current.dev !== details.dev || current.ino !== details.ino) throw new Error('lock changed while reclaiming')
        await unlink(path)
        result.push(relative(this.root, path).split(sep).join('/'))
      } catch (error: unknown) {
        issues.push(issue('UNSAFE_RUNTIME_LOCK', `runtime lock was not reclaimed: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    return result
  }
}

function validateApprovals(state: BackendTeamState, current: Readonly<Record<string, string>>, issues: RecoveryIssue[]): string[] {
  const required: readonly ('requirements' | 'design')[] = phaseAtLeast(state.phase, 'PLAN') ? ['requirements', 'design'] : phaseAtLeast(state.phase, 'DESIGN') ? ['requirements'] : []
  const stale: string[] = []
  for (const kind of required) {
    const approval = [...state.approvals].reverse().find((candidate) => candidate.kind === kind)
    if (approval === undefined) { issues.push(issue(kind === 'requirements' ? 'MISSING_REQUIREMENTS_APPROVAL' : 'MISSING_DESIGN_APPROVAL', `${kind} approval is required before resuming ${state.phase}`)); continue }
    const paths = [...new Set([...Object.keys(current), ...Object.keys(approval.artifactHashes)])]
      .filter((path) => approvalCoversPath(kind, path))
      .filter((path) => approval.artifactHashes[path] !== current[path])
    if (paths.length > 0) { stale.push(...paths); issues.push({ ...issue('STALE_APPROVAL', `${kind} approval hashes no longer match`, paths), paths: Object.freeze(paths) }) }
  }
  return [...new Set(stale)].sort()
}

function approvalCoversPath(kind: 'requirements' | 'design', path: string): boolean {
  const phase = phaseForArtifactPath(path)
  if (phase === null) return true
  if (kind === 'requirements') return phase === 'SPECIFY'
  return phase === 'SPECIFY' || phase === 'DESIGN'
}

function phaseAtLeast(actual: BackendTeamPhase, expected: BackendTeamPhase): boolean { return phaseOrder(actual) >= phaseOrder(expected) }
function phaseOrder(phase: BackendTeamPhase): number { const index = PHASE_ORDER.indexOf(phase); if (index < 0) throw new Error(`unknown backend team phase: ${phase}`); return index }
function isRecoverySnapshot(value: RecoveryArtifactSnapshot | Readonly<Record<string, string>>): value is RecoveryArtifactSnapshot { return typeof value === 'object' && value !== null && Array.isArray((value as { readonly artifacts?: unknown }).artifacts) }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function issue(code: RecoveryIssue['code'], message: string, paths?: readonly string[]): RecoveryIssue { return paths === undefined ? { code, message } : { code, message, paths } }
function inside(root: string, target: string): boolean { const rel = relative(root, target); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
function resolveWorkspacePath(root: string, target: string): string { return resolve(root, target) }
async function assertPrivateDirectory(root: string, target: string): Promise<void> {
  const resolved = resolveWorkspacePath(root, target)
  const details = await lstat(resolved)
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`path is not a canonical directory: ${target}`)
  if (!inside(root, resolved) || await realpath(resolved) !== resolved) throw new Error(`path escapes workspace: ${target}`)
}
async function readPrivateWorkspaceFile(root: string, target: string): Promise<string> {
  const resolved = resolveWorkspacePath(root, target)
  const before = await lstat(resolved)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || !inside(root, resolved) || await realpath(resolved) !== resolved) throw new Error(`path is not a private regular file: ${target}`)
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`file identity changed: ${target}`)
    const content = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat(); const finalPath = await lstat(resolved)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || finalPath.isSymbolicLink() || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino) throw new Error(`file changed while reading: ${target}`)
    return content
  } finally { await handle.close() }
}
async function pathInside(root: string, target: string): Promise<boolean> { const resolved = resolveWorkspacePath(root, target); const canonical = await realpath(resolved).catch(() => resolved); return inside(root, canonical) }
async function hashRuntimeExecutable(root: string, target: string, allowFinalSymlink: boolean): Promise<string> {
  const resolved = resolveWorkspacePath(root, target)
  if (!inside(root, resolved)) throw new Error(`runtime executable escapes workspace: ${target}`)
  const initial = await lstat(resolved)
  let filePath = resolved
  if (initial.isSymbolicLink()) {
    if (!allowFinalSymlink) throw new Error(`runtime executable may not be a symlink: ${target}`)
    filePath = await realpath(resolved)
    const managedPython = resolve(root, '.backend-team/runtime/python')
    const venv = resolve(root, '.backend-team/runtime/spec-kit/.venv')
    if (!inside(managedPython, filePath) && !inside(venv, filePath)) throw new Error(`runtime executable symlink escapes managed roots: ${target}`)
  } else if (!initial.isFile() || initial.nlink !== 1 || await realpath(resolved) !== resolved) {
    throw new Error(`runtime executable is not a canonical regular file: ${target}`)
  }
  const before = await lstat(filePath)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`runtime executable is unsafe: ${target}`)
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new Error(`runtime executable changed: ${target}`)
    const first = await hashHandle(handle); const second = await hashHandle(handle)
    const after = await handle.stat(); const finalPath = await lstat(filePath)
    if (first !== second || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino) throw new Error(`runtime executable changed while hashing: ${target}`)
    return first
  } finally { await handle.close() }
}
async function hashHandle(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0
  for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (bytesRead === 0) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead }
  return hash.digest('hex')
}
function isValidCommand(root: string, value: unknown): boolean {
  if (!record(value) || !record(value.env) || !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string') || typeof value.executable !== 'string' || typeof value.cwd !== 'string' || !isAbsolute(value.executable) || !isAbsolute(value.cwd) || !inside(root, resolve(value.executable)) || !inside(root, resolve(value.cwd)) || !isAllowedRuntimeExecutable(root, value.executable) || value.networkPolicy !== 'deny' || !sha(value.executionFingerprint) || typeof value.result !== 'string' || !['ok', 'uv 0.12.3', 'Python 3.13.15', '0.16.5'].includes(value.result) || !Object.values(value.env).every((entry) => typeof entry === 'string')) return false
  return value.executionFingerprint === sha256Canonical({ executable: value.executable, args: value.args, cwd: value.cwd, env: value.env, codeWillExecute: true, networkPolicy: 'deny' })
}
function isAllowedRuntimeExecutable(root: string, path: string): boolean { return path === resolve(root, '.backend-team/runtime/bin/uv') || path === resolve(root, '.backend-team/runtime/spec-kit/.venv/bin/python') || path === resolve(root, '.backend-team/runtime/spec-kit/.venv/bin/specify') }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error: unknown) { const code = (error as NodeJS.ErrnoException).code; return code !== 'ESRCH' }
}
