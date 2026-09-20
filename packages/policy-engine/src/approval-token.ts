import { createHash, randomBytes as secureRandomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { ApprovalKindSchema, PolicyActionSchema, PolicyContextSchema, type ApprovalKind, type BackendTeamState, type PolicyAction, type PolicyContext, type StateStore } from '@dsh-backend-team/contracts'
import { StateRevisionConflictError, sha256Canonical } from '@dsh-backend-team/core'
import { canonicalizeTargetPath, UnsafeTargetPathError } from './canonical-path.js'
import { DefaultPolicyEngine } from './policy-engine.js'

const TOKEN_PREFIX = 'dsh-at1'
// FileStateStore uses an exclusive lock and reports contention as EEXIST.
// macOS can hold that lock across fsync/rename long enough for a short fixed
// retry window to fail under a burst of concurrent approvals.
const RETRY_LIMIT = 200

class TokenNotConsumableError extends Error {
  constructor() {
    super('approval token cannot be consumed')
  }
}

export interface ApprovalTokenServiceOptions {
  readonly now?: () => Date
  readonly randomBytes?: () => Uint8Array
  readonly tokenId?: () => string
}

interface ApprovalTokenTestHooks {
  readonly afterCommandOpen?: (handle: FileHandle) => Promise<void>
}

let approvalTokenTestHooks: ApprovalTokenTestHooks = {}

/** Package-internal deterministic fault injection; intentionally absent from the public barrel. */
export function __setApprovalTokenTestHooksForTest(hooks: ApprovalTokenTestHooks): () => void {
  const previous = approvalTokenTestHooks
  approvalTokenTestHooks = hooks
  return () => { approvalTokenTestHooks = previous }
}

export interface ApprovalTokenIssue {
  readonly kind: ApprovalKind
  readonly workspaceRoot: string
  readonly context: PolicyContext
  readonly action: PolicyAction
  readonly expiresAt: string
}

export interface ApprovalTokenUse {
  readonly kind: ApprovalKind
  readonly workspaceRoot: string
  readonly context: PolicyContext
  readonly action: PolicyAction
}

export interface CommandExecutionEvidence {
  readonly canonicalExecutable: string
  readonly executableContentDigest: string
  readonly canonicalCwd: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly executionFingerprint: string
}

export class ApprovalTokenService {
  private readonly now: () => Date
  private readonly randomBytes: () => Uint8Array
  private readonly tokenId: () => string
  private readonly policyEngine = new DefaultPolicyEngine()

  constructor(private readonly stateStore: StateStore, options: ApprovalTokenServiceOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.randomBytes = options.randomBytes ?? (() => secureRandomBytes(32))
    this.tokenId = options.tokenId ?? randomUUID
  }

  async issue(input: ApprovalTokenIssue): Promise<string> {
    const actionResult = PolicyActionSchema.safeParse(input.action)
    const contextResult = PolicyContextSchema.safeParse(input.context)
    const kindResult = ApprovalKindSchema.safeParse(input.kind)
    if (!actionResult.success || !contextResult.success || !kindResult.success) throw new Error('approval issue input failed validation')
    const decision = await this.policyEngine.authorize(actionResult.data, contextResult.data)
    if (decision.effect !== 'ask' || decision.approvalKind !== kindResult.data) throw new Error('approval token issuance requires a matching policy approval')
    const workspaceRoot = await canonicalWorkspaceRoot(input.workspaceRoot)
    if (workspaceRoot !== await canonicalWorkspaceRoot(contextResult.data.workspace.root)) throw new Error('approval token workspace does not match policy context')
    const expiresAt = new Date(input.expiresAt)
    if (!isCanonicalTimestamp(input.expiresAt) || expiresAt <= this.now()) {
      throw new Error('approval token expiry timestamp must be canonical UTC and in the future')
    }
    const secret = this.randomBytes()
    if (secret.byteLength !== 32) throw new Error('approval token secret must be 256 bits')
    const tokenId = this.tokenId()
    if (!isSafeTokenId(tokenId)) throw new Error('approval token id must use the safe opaque-token alphabet')
    const actionDigest = await canonicalActionDigest(actionResult.data, workspaceRoot)
    const secretDigest = digest(secret)

    await this.transactWithRetry((state) => {
      assertWorkspace(state, workspaceRoot)
      if (state.approvalTokens.some((record) => record.tokenId === tokenId)) {
        throw new Error('approval token id collision')
      }
      return {
        ...state,
        approvalTokens: [...state.approvalTokens, {
          tokenId, kind: input.kind, workspaceRoot, secretDigest, actionDigest,
          expiresAt: expiresAt.toISOString(), usedAt: null,
        }],
      }
    })
    return `${TOKEN_PREFIX}.${tokenId}.${Buffer.from(secret).toString('base64url')}`
  }

  async consume(token: string, input: ApprovalTokenUse): Promise<boolean> {
    const parsed = parseToken(token)
    if (parsed === null) return false
    const actionResult = PolicyActionSchema.safeParse(input.action)
    const kindResult = ApprovalKindSchema.safeParse(input.kind)
    const contextResult = PolicyContextSchema.safeParse(input.context)
    if (!actionResult.success || !kindResult.success || !contextResult.success) return false
    if (actionResult.data.kind === 'command') throw new Error('command approval tokens require execution evidence')
    try {
      const workspaceRoot = await canonicalWorkspaceRoot(input.workspaceRoot)
      if (workspaceRoot !== await canonicalWorkspaceRoot(contextResult.data.workspace.root)) return false
      return this.consumePrepared(parsed, { ...input, kind: kindResult.data, action: actionResult.data }, await canonicalActionDigest(actionResult.data, workspaceRoot))
    } catch (error: unknown) {
      if (error instanceof UnsafeTargetPathError) return false
      throw error
    }
  }

  /**
   * Runs the only trusted callback while the verified executable handle remains
   * open. The callback must immediately spawn canonicalExecutable with
   * shell:false; evidence is not a delayed execution grant. After the final
   * path/content check, a same-UID mutation before Node's path-based spawn is
   * the accepted macOS/Node OS boundary.
   */
  async executeApprovedCommand<T>(token: string, input: ApprovalTokenUse, operation: (evidence: CommandExecutionEvidence) => Promise<T>): Promise<T | null> {
    const parsed = parseToken(token)
    if (parsed === null) return null
    const actionResult = PolicyActionSchema.safeParse(input.action)
    const contextResult = PolicyContextSchema.safeParse(input.context)
    const kindResult = ApprovalKindSchema.safeParse(input.kind)
    if (!actionResult.success || actionResult.data.kind !== 'command' || !contextResult.success || !kindResult.success) return null
    const policyDecision = await this.policyEngine.authorize(actionResult.data, contextResult.data)
    if (policyDecision.effect !== 'ask' || policyDecision.approvalKind !== kindResult.data) return null
    const workspaceRoot = await canonicalWorkspaceRoot(input.workspaceRoot)
    if (workspaceRoot !== await canonicalWorkspaceRoot(contextResult.data.workspace.root)) return null
    const grant = await openCommandExecutable(actionResult.data, workspaceRoot)
    let callbackStarted = false
    let primary: unknown
    try {
      await approvalTokenTestHooks.afterCommandOpen?.(grant.handle)
      const finalStat = await grant.handle.stat()
      const finalPath = await realpath(grant.evidence.canonicalExecutable)
      const finalCurrent = await stat(finalPath)
      if (!finalStat.isFile() || finalStat.nlink !== 1 || finalPath !== grant.evidence.canonicalExecutable || finalStat.dev !== finalCurrent.dev || finalStat.ino !== finalCurrent.ino) return null
      if (await sha256Handle(grant.handle) !== grant.evidence.executableContentDigest) return null
      const consumed = await this.consumePrepared(parsed, { ...input, action: actionResult.data }, sha256Canonical({ ...actionResult.data, executable: grant.evidence.canonicalExecutable, cwd: grant.evidence.canonicalCwd, executableContentDigest: grant.evidence.executableContentDigest }))
      if (!consumed) return null
      callbackStarted = true
      return await operation(grant.evidence)
    } catch (error: unknown) {
      primary = error
      throw error
    } finally {
      try { await closeWithRetry(grant.handle) } catch (closeError: unknown) {
        const cleanup = closeError instanceof AggregateError ? [...closeError.errors] : [closeError]
        if (callbackStarted || primary !== undefined) throw new AggregateError(primary === undefined ? cleanup : [primary, ...cleanup], 'command operation and executable handle close failed')
        throw closeError
      }
    }
  }

  private async consumePrepared(parsed: { tokenId: string; secret: Buffer }, input: ApprovalTokenUse, actionDigest: string): Promise<boolean> {
    let workspaceRoot: string
    try {
      workspaceRoot = await canonicalWorkspaceRoot(input.workspaceRoot)
    } catch (error: unknown) {
      if (error instanceof UnsafeTargetPathError) return false
      throw error
    }
    const secretDigest = digest(parsed.secret)
    const consumedAt = this.now().toISOString()
    const beforeConsume = await this.stateStore.load()
    if (beforeConsume === null) throw new Error('approval token state has not been created')
    if (beforeConsume.workspaceRoot !== workspaceRoot) return false
    let consumed = false
    try {
      await this.transactWithRetry((state) => {
        assertWorkspace(state, workspaceRoot)
        const record = state.approvalTokens.find((candidate) => candidate.tokenId === parsed.tokenId)
        const digestMatches = constantTimeDigestMatch(record?.secretDigest, secretDigest)
        if (!record || !digestMatches || record.kind !== input.kind || record.workspaceRoot !== workspaceRoot || record.actionDigest !== actionDigest || new Date(record.expiresAt) <= this.now() || record.usedAt !== null) {
          throw new TokenNotConsumableError()
        }
        consumed = true
        return { ...state, approvalTokens: state.approvalTokens.map((candidate) => candidate.tokenId === record.tokenId ? { ...candidate, usedAt: consumedAt } : candidate) }
      })
    } catch (error: unknown) {
      if (error instanceof TokenNotConsumableError) return false
      throw error
    }
    return consumed
  }

  private async transactWithRetry(change: (state: BackendTeamState) => BackendTeamState): Promise<void> {
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
      const current = await this.stateStore.load()
      if (current === null) throw new Error('approval token state has not been created')
      try {
        await this.stateStore.transact(current.revision, change)
        return
      } catch (error: unknown) {
        if (!isRetryableConflict(error) || attempt === RETRY_LIMIT - 1) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
    }
  }
}

export async function canonicalActionDigest(action: PolicyAction, workspaceRoot: string): Promise<string> {
  const normalized = await normalizedAction(action, workspaceRoot)
  return sha256Canonical(normalized)
}

async function normalizedAction(action: PolicyAction, workspaceRoot: string): Promise<unknown> {
  switch (action.kind) {
    case 'read': case 'write': case 'delete': case 'migration': case 'shared-config':
      return { ...action, targetPath: await canonicalizeTargetPath(workspaceRoot, action.targetPath) }
    case 'command': {
      const evidence = await commandExecutionEvidence(action, workspaceRoot)
      return { ...action, executable: evidence.canonicalExecutable, cwd: evidence.canonicalCwd, executableContentDigest: evidence.executableContentDigest }
    }
    default: return action
  }
}

async function commandExecutionEvidence(action: Extract<PolicyAction, { kind: 'command' }>, workspaceRoot: string): Promise<CommandExecutionEvidence> {
  const grant = await openCommandExecutable(action, workspaceRoot)
  try { return grant.evidence } finally { await closeWithRetry(grant.handle) }
}

async function openCommandExecutable(action: Extract<PolicyAction, { kind: 'command' }>, workspaceRoot: string): Promise<{ evidence: CommandExecutionEvidence; handle: FileHandle }> {
  if (!isAbsolute(action.executable)) throw new UnsafeTargetPathError('command executable must be absolute')
  const canonicalExecutable = await realpath(action.executable)
  const canonicalCwd = await realpath(action.cwd)
  if (await canonicalizeTargetPath(workspaceRoot, canonicalCwd) !== canonicalCwd) throw new UnsafeTargetPathError('command cwd escapes workspace')
  const handle = await open(canonicalExecutable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    const current = await stat(canonicalExecutable)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) throw new UnsafeTargetPathError('command executable is not a verified regular file')
    const executableContentDigest = await sha256Handle(handle)
    const evidence = Object.freeze({ canonicalExecutable, executableContentDigest, canonicalCwd, args: Object.freeze([...action.args]), env: Object.freeze({ ...action.env }), executionFingerprint: action.executionFingerprint })
    return { evidence, handle }
  } catch (error: unknown) { await closeWithRetry(handle); throw error }
}

async function sha256Handle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

async function closeWithRetry(handle: FileHandle): Promise<void> {
  let first: unknown
  try { await handle.close(); return } catch (error: unknown) { first = error }
  try { await handle.close() } catch (second: unknown) { throw new AggregateError([first, second], 'executable handle close failed after retry') }
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  return realpath(workspaceRoot)
}

function parseToken(value: string): { tokenId: string; secret: Buffer } | null {
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || parts[1] === undefined || !isSafeTokenId(parts[1]) || parts[2] === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(parts[2])) return null
  const secret = Buffer.from(parts[2], 'base64url')
  return secret.byteLength === 32 && secret.toString('base64url') === parts[2] ? { tokenId: parts[1], secret } : null
}

function digest(secret: Uint8Array): string {
  return createHash('sha256').update(secret).digest('hex')
}

function constantTimeDigestMatch(persisted: string | undefined, candidate: string): boolean {
  const expected = Buffer.from(persisted ?? '0'.repeat(64), 'hex')
  return expected.byteLength === 32 && timingSafeEqual(expected, Buffer.from(candidate, 'hex'))
}

function assertWorkspace(state: BackendTeamState, workspaceRoot: string): void {
  if (state.workspaceRoot !== workspaceRoot) throw new Error('approval token workspace does not match state')
}

function isRetryableConflict(error: unknown): boolean {
  return error instanceof StateRevisionConflictError || (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST')
}

function isSafeTokenId(tokenId: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/u.test(tokenId)
}

function isCanonicalTimestamp(value: string): boolean {
  const date = new Date(value)
  return Number.isFinite(date.valueOf()) && date.toISOString() === value
}
