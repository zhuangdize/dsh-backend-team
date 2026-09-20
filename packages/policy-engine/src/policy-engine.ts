import { constants } from 'node:fs'
import { lstat, open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { PolicyActionSchema, PolicyContextSchema, type PolicyAction, type PolicyContext, type PolicyDecision } from '@dsh-backend-team/contracts'
import { canonicalizeTargetPath } from './canonical-path.js'
import { evaluateRules } from './rules.js'

export class PolicyDeniedError extends Error {
  readonly decision: PolicyDecision
  constructor(decision: PolicyDecision) { super(`policy ${decision.effect}: ${decision.ruleId}`); this.name = 'PolicyDeniedError'; this.decision = decision }
}
class UnsafeHandleError extends Error {}
class CleanupRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'CleanupRefusedError' }
}

export interface OwnedWriteGrantVerifier { verify(input: Readonly<{ action: Extract<PolicyAction, { kind: 'write' }>; canonicalTargetPath: string; phase: PolicyContext['phase'] }>): Promise<boolean> }
export interface SpecificationWriteGrantVerifier { verify(input: Readonly<{ action: Extract<PolicyAction, { kind: 'write' }>; canonicalTargetPath: string; phase: PolicyContext['phase'] }>): Promise<boolean> }
export interface DefaultPolicyEngineOptions { readonly ownedWriteGrantVerifier?: OwnedWriteGrantVerifier; readonly specificationWriteGrantVerifier?: SpecificationWriteGrantVerifier }

/**
 * authorize is diagnostic only. Read/write I/O is callback-bound to a verified
 * FileHandle, so callers cannot authorize one pathname and reopen another.
 * Same-UID changes after the final descriptor check are the accepted OS boundary.
 */
export class DefaultPolicyEngine {
  private readonly verifier: OwnedWriteGrantVerifier | undefined
  private readonly specificationVerifier: SpecificationWriteGrantVerifier | undefined
  constructor(options: DefaultPolicyEngineOptions = {}) {
    this.verifier = options.ownedWriteGrantVerifier
    this.specificationVerifier = options.specificationWriteGrantVerifier
  }

  async authorize(actionInput: unknown, contextInput: unknown): Promise<PolicyDecision> {
    const prepared = await this.normalize(actionInput, contextInput)
    if (prepared === null) return invalidContractDecision()
    const decision = await evaluateRules(prepared.action, prepared.context)
    return prepared.canonicalTargetPath === undefined ? decision : { ...decision, canonicalTargetPath: prepared.canonicalTargetPath }
  }

  async enforce(actionInput: unknown, contextInput: unknown): Promise<PolicyDecision> {
    const decision = await this.authorize(actionInput, contextInput)
    const action = PolicyActionSchema.safeParse(actionInput)
    if (!action.success || isPathAction(action.data)) throw new PolicyDeniedError(decision.effect === 'deny' ? decision : denyHandle(decision.canonicalTargetPath))
    if (decision.effect !== 'allow') throw new PolicyDeniedError(decision)
    return decision
  }

  async preflightOwnedWrite(actionInput: unknown, contextInput: unknown): Promise<PolicyDecision> {
    const prepared = await this.normalize(actionInput, contextInput)
    if (prepared === null || prepared.action.kind !== 'write' || prepared.canonicalTargetPath === undefined) {
      return prepared === null ? invalidContractDecision() : denyHandle(prepared.canonicalTargetPath)
    }
    const decision = await evaluateRules(prepared.action, prepared.context)
    if (decision.ruleId !== 'deny-unknown' || !isOwnedWritePhase(prepared.context.phase) || this.verifier === undefined) {
      return denyOwnedWrite(decision, prepared.canonicalTargetPath)
    }
    if (!await this.hasSafeExistingParent(prepared.requestedTargetPath ?? prepared.action.targetPath, prepared.canonicalTargetPath, prepared.context.workspace.root)) {
      return denyOwnedWrite(decision, prepared.canonicalTargetPath)
    }
    if (!await this.verifier.verify({ action: prepared.action, canonicalTargetPath: prepared.canonicalTargetPath, phase: prepared.context.phase })) {
      return denyOwnedWrite(decision, prepared.canonicalTargetPath)
    }
    return { ...decision, effect: 'allow', ruleId: 'allow-owned-write', reason: 'host-owned write grant verified for the canonical target', canonicalTargetPath: prepared.canonicalTargetPath }
  }

  async executeApprovedRead<T>(actionInput: unknown, contextInput: unknown, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    const prepared = await this.normalize(actionInput, contextInput)
    if (prepared === null || prepared.action.kind !== 'read') throw new PolicyDeniedError(prepared === null ? invalidContractDecision() : denyHandle(prepared.canonicalTargetPath))
    const decision = await evaluateRules(prepared.action, prepared.context)
    if (decision.effect !== 'allow') throw new PolicyDeniedError({ ...decision, canonicalTargetPath: prepared.canonicalTargetPath })
    try { return await this.executeVerifiedHandle(prepared.action.targetPath, prepared.context.workspace.root, constants.O_RDONLY, operation) } catch (error: unknown) { if (error instanceof UnsafeHandleError) throw new PolicyDeniedError(denyHandle(prepared.canonicalTargetPath)); throw error }
  }

  async executeApprovedWrite<T>(actionInput: unknown, contextInput: unknown, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    const prepared = await this.normalize(actionInput, contextInput)
    if (prepared === null || prepared.action.kind !== 'write') throw new PolicyDeniedError(prepared === null ? invalidContractDecision() : denyHandle(prepared.canonicalTargetPath))
    const decision = await evaluateRules(prepared.action, prepared.context)
    if (decision.ruleId !== 'deny-unknown' || this.verifier === undefined || !isOwnedWritePhase(prepared.context.phase) || !await this.verifier.verify({ action: prepared.action, canonicalTargetPath: prepared.action.targetPath, phase: prepared.context.phase })) throw new PolicyDeniedError(denyHandle(prepared.canonicalTargetPath))
    try { return await this.executeVerifiedHandle(prepared.action.targetPath, prepared.context.workspace.root, constants.O_WRONLY, operation) } catch (error: unknown) { if (error instanceof UnsafeHandleError) throw new PolicyDeniedError(denyHandle(prepared.canonicalTargetPath)); throw error }
  }

  async executeApprovedCreate<T>(actionInput: unknown, contextInput: unknown, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    const prepared = await this.normalize(actionInput, contextInput)
    if (prepared === null || prepared.action.kind !== 'write' || prepared.canonicalTargetPath === undefined) {
      throw new PolicyDeniedError(prepared === null ? invalidContractDecision() : denyHandle(prepared.canonicalTargetPath))
    }
    const decision = await evaluateRules(prepared.action, prepared.context)
    if (decision.ruleId !== 'deny-unknown' || this.verifier === undefined || !isOwnedWritePhase(prepared.context.phase) || !await this.hasSafeExistingParent(prepared.requestedTargetPath ?? prepared.action.targetPath, prepared.canonicalTargetPath, prepared.context.workspace.root) || !await this.verifier.verify({ action: prepared.action, canonicalTargetPath: prepared.action.targetPath, phase: prepared.context.phase })) {
      throw new PolicyDeniedError(denyHandle(prepared.canonicalTargetPath))
    }
    try {
      return await this.executeVerifiedCreate(prepared.action.targetPath, prepared.context.workspace.root, operation)
    } catch (error: unknown) {
      if (error instanceof UnsafeHandleError) throw new PolicyDeniedError(denyHandle(prepared.canonicalTargetPath))
      throw error
    }
  }

  async executeSpecificationWrite<T>(actionInput: unknown, contextInput: unknown, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    const prepared = await this.normalize(actionInput, contextInput)
    if (prepared === null || prepared.action.kind !== 'write' || prepared.canonicalTargetPath === undefined) {
      throw new PolicyDeniedError(prepared === null ? invalidContractDecision() : denyHandle(prepared.canonicalTargetPath))
    }
    const decision = await evaluateRules(prepared.action, prepared.context)
    if (decision.ruleId !== 'deny-unknown' || this.specificationVerifier === undefined || !isSpecificationWritePhase(prepared.context.phase) || !isAllowedSpecificationTarget(prepared.context.workspace.root, prepared.canonicalTargetPath, prepared.context.phase) || !await this.hasSafeExistingParent(prepared.requestedTargetPath ?? prepared.action.targetPath, prepared.canonicalTargetPath, prepared.context.workspace.root) || !await this.specificationVerifier.verify({ action: prepared.action, canonicalTargetPath: prepared.canonicalTargetPath, phase: prepared.context.phase })) {
      throw new PolicyDeniedError(denyHandle(prepared.canonicalTargetPath))
    }
    try { return await this.executeVerifiedHandle(prepared.action.targetPath, prepared.context.workspace.root, constants.O_WRONLY, operation) } catch (error: unknown) { if (error instanceof UnsafeHandleError) throw new PolicyDeniedError(denyHandle(prepared.canonicalTargetPath)); throw error }
  }

  async executeSpecificationCreate<T>(actionInput: unknown, contextInput: unknown, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    const prepared = await this.normalize(actionInput, contextInput)
    if (prepared === null || prepared.action.kind !== 'write' || prepared.canonicalTargetPath === undefined) {
      throw new PolicyDeniedError(prepared === null ? invalidContractDecision() : denyHandle(prepared.canonicalTargetPath))
    }
    const decision = await evaluateRules(prepared.action, prepared.context)
    if (decision.ruleId !== 'deny-unknown' || this.specificationVerifier === undefined || !isSpecificationWritePhase(prepared.context.phase) || !isAllowedSpecificationTarget(prepared.context.workspace.root, prepared.canonicalTargetPath, prepared.context.phase) || !await this.hasSafeExistingParent(prepared.requestedTargetPath ?? prepared.action.targetPath, prepared.canonicalTargetPath, prepared.context.workspace.root) || !await this.specificationVerifier.verify({ action: prepared.action, canonicalTargetPath: prepared.canonicalTargetPath, phase: prepared.context.phase })) {
      throw new PolicyDeniedError(denyHandle(prepared.canonicalTargetPath))
    }
    try {
      return await this.executeVerifiedCreate(prepared.action.targetPath, prepared.context.workspace.root, operation)
    } catch (error: unknown) {
      if (error instanceof UnsafeHandleError) throw new PolicyDeniedError(denyHandle(prepared.canonicalTargetPath))
      throw error
    }
  }

  private async normalize(actionInput: unknown, contextInput: unknown): Promise<{ action: PolicyAction; context: PolicyContext; canonicalTargetPath?: string; requestedTargetPath?: string } | null> {
    const actionResult = PolicyActionSchema.safeParse(actionInput)
    const contextResult = PolicyContextSchema.safeParse(contextInput)
    if (!actionResult.success || !contextResult.success) return null
    let context: PolicyContext
    try { context = await canonicalizeContext(contextResult.data) } catch { return null }
    if (actionResult.data.kind === 'command') {
      try {
        const cwd = await realpath(actionResult.data.cwd)
        if (await canonicalizeTargetPath(context.workspace.root, cwd) !== cwd) return null
        return { action: { ...actionResult.data, cwd }, context }
      } catch { return null }
    }
    if (!isPathAction(actionResult.data)) return { action: actionResult.data, context }
    try {
      const canonicalTargetPath = await canonicalizeTargetPath(context.workspace.root, actionResult.data.targetPath)
      return { action: { ...actionResult.data, targetPath: canonicalTargetPath }, context, canonicalTargetPath, requestedTargetPath: actionResult.data.targetPath }
    } catch { return null }
  }

  private async executeVerifiedHandle<T>(targetPath: string, workspaceRoot: string, mode: number, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    let handle: FileHandle | undefined
    let thrown = false
    let primary: unknown
    let callbackStarted = false
    try {
      handle = await open(targetPath, mode | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const opened = await handle.stat()
      const currentPath = await realpath(targetPath)
      const current = await stat(currentPath)
      if (!opened.isFile() || opened.nlink !== 1 || currentPath !== targetPath || opened.dev !== current.dev || opened.ino !== current.ino || !isInside(workspaceRoot, currentPath)) throw new UnsafeHandleError()
      const rechecked = await handle.stat()
      if (!rechecked.isFile() || rechecked.nlink !== 1) throw new UnsafeHandleError()
      callbackStarted = true
      return await operation(handle)
    } catch (error: unknown) {
      thrown = true
      primary = callbackStarted ? error : new UnsafeHandleError()
      throw primary
    } finally {
      try { await closeWithRetry(handle) } catch (closeError: unknown) {
        if (thrown) throw new AggregateError([primary, closeError], 'file operation and handle close failed')
        throw closeError
      }
    }
  }

  private async executeVerifiedCreate<T>(targetPath: string, workspaceRoot: string, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    let handle: FileHandle | undefined
    let created = false
    let createdIdentity: FileIdentity | undefined
    let thrown = false
    let primary: unknown
    let callbackStarted = false
    try {
      handle = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      created = true
      let opened: Awaited<ReturnType<FileHandle['stat']>>
      try {
        opened = await handle.stat()
      } catch {
        throw new UnsafeHandleError()
      }
      createdIdentity = identityOf(opened)
      const currentPath = await realpath(targetPath)
      const current = await stat(currentPath)
      const parentPath = dirname(targetPath)
      if (!opened.isFile() || opened.nlink !== 1 || currentPath !== targetPath || opened.dev !== current.dev || opened.ino !== current.ino || !isInside(workspaceRoot, currentPath) || await realpath(parentPath) !== parentPath) throw new UnsafeHandleError()
      const rechecked = await handle.stat()
      if (!rechecked.isFile() || rechecked.nlink !== 1 || rechecked.dev !== createdIdentity.dev || rechecked.ino !== createdIdentity.ino) throw new UnsafeHandleError()
      callbackStarted = true
      return await operation(handle)
    } catch (error: unknown) {
      thrown = true
      primary = callbackStarted ? error : new UnsafeHandleError()
      throw primary
    } finally {
      const cleanupErrors: unknown[] = []
      if (created && thrown) {
        try {
          if (handle === undefined) throw new CleanupRefusedError('created inode cleanup refused: descriptor is unavailable')
          if (createdIdentity === undefined) {
            try { createdIdentity = identityOf(await handle.stat()) } catch { throw new CleanupRefusedError('created inode cleanup refused: descriptor identity cannot be proven') }
          }
          await unlinkCreatedInode(targetPath, createdIdentity, handle)
        } catch (cleanupError: unknown) { cleanupErrors.push(cleanupError) }
      }
      try { await closeWithRetry(handle) } catch (closeError: unknown) { cleanupErrors.push(closeError) }
      if (cleanupErrors.length > 0) {
        if (thrown) throw new AggregateError([primary, ...cleanupErrors], 'file operation and create cleanup failed')
        throw new AggregateError(cleanupErrors, 'create cleanup failed')
      }
    }
  }

  private async hasSafeExistingParent(requestedTargetPath: string, canonicalTargetPath: string, workspaceRoot: string): Promise<boolean> {
    const canonicalParent = dirname(canonicalTargetPath)
    try {
      const parent = await lstat(canonicalParent)
      if (!parent.isDirectory() || await realpath(canonicalParent) !== canonicalParent || !isInside(workspaceRoot, canonicalParent)) return false
      const requestedPath = resolve(workspaceRoot, requestedTargetPath)
      const requestedParent = dirname(requestedPath)
      return await realpath(requestedParent) === requestedParent && requestedParent === canonicalParent
    } catch { return false }
  }
}

function invalidContractDecision(): PolicyDecision { return { effect: 'deny', ruleId: 'deny-invalid-contract', reason: 'policy action or context failed validation' } }
function denyHandle(canonicalTargetPath: string | undefined): PolicyDecision { return { effect: 'deny', ruleId: 'deny-path-requires-handle', reason: 'path I/O requires a verified file handle callback', ...(canonicalTargetPath === undefined ? {} : { canonicalTargetPath }) } }
function denyOwnedWrite(decision: PolicyDecision, canonicalTargetPath: string): PolicyDecision { return { ...decision, effect: 'deny', canonicalTargetPath } }
function isPathAction(action: PolicyAction): action is Extract<PolicyAction, { targetPath: string }> { return ['read', 'write', 'delete', 'migration', 'shared-config'].includes(action.kind) }
function isOwnedWritePhase(phase: PolicyContext['phase']): boolean { return phase === 'BUILD' || phase === 'VERIFY' }
function isSpecificationWritePhase(phase: PolicyContext['phase']): boolean { return phase === 'SPECIFY' || phase === 'DESIGN' || phase === 'PLAN' }
function isAllowedSpecificationTarget(workspaceRoot: string, canonicalTargetPath: string, phase: PolicyContext['phase']): boolean {
  if (!isInside(workspaceRoot, canonicalTargetPath)) return false
  const segments = relative(workspaceRoot, canonicalTargetPath).split(sep)
  if (segments[0] !== 'specs' || segments[1] === '') return false
  if (phase === 'DESIGN' && segments.length === 4 && segments[2] === 'contracts') return segments[3] === 'openapi.yaml'
  if (segments.length !== 3) return false
  const allowed = phase === 'SPECIFY' ? ['spec.md', 'clarification.md'] : phase === 'DESIGN' ? ['plan.md', 'architecture.md', 'data-model.md', 'test-plan.md', 'research.md', 'decisions.md'] : phase === 'PLAN' ? ['tasks.md'] : []
  return allowed.includes(segments[2] ?? '')
}
async function canonicalizeContext(context: PolicyContext): Promise<PolicyContext> { const root = await realpath(context.workspace.root); return { ...context, workspace: { ...context.workspace, root } } }
function isInside(root: string, target: string): boolean { return target === root || target.startsWith(`${root}/`) }
type FileIdentity = Pick<Awaited<ReturnType<FileHandle['stat']>>, 'dev' | 'ino'>
function identityOf(stats: FileIdentity): FileIdentity { return { dev: stats.dev, ino: stats.ino } }
async function unlinkCreatedInode(targetPath: string, created: FileIdentity, handle: FileHandle): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>
  try {
    current = await lstat(targetPath)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await confirmCreatedInodeDeleted(handle, created, 'created inode cleanup refused: target path no longer names the created inode')
      return
    }
    throw new CleanupRefusedError('created inode cleanup refused: target path cannot be inspected')
  }
  if (current.dev !== created.dev || current.ino !== created.ino) {
    await confirmCreatedInodeDeleted(handle, created, 'created inode cleanup refused: target path was replaced before cleanup')
    return
  }
  try {
    await unlink(targetPath)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await confirmCreatedInodeDeleted(handle, created, 'created inode cleanup refused: target path disappeared during cleanup')
      return
    }
    throw new CleanupRefusedError('created inode cleanup refused: created inode could not be unlinked')
  }
}
async function confirmCreatedInodeDeleted(handle: FileHandle, created: FileIdentity, reason: string): Promise<void> {
  try {
    const current = await handle.stat()
    if (current.dev === created.dev && current.ino === created.ino && current.nlink === 0) return
  } catch { /* An open descriptor should remain stat-able; failure is not proof of deletion. */ }
  throw new CleanupRefusedError(reason)
}
async function closeWithRetry(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return
  let firstError: unknown
  try { await handle.close(); return } catch (error: unknown) { firstError = error }
  try { await handle.close() } catch (secondError: unknown) { throw new AggregateError([firstError, secondError], 'file handle close failed after retry') }
}
