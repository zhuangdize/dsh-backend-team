import { createHash, randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export type ContextMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ContextMessage {
  readonly id: string
  readonly role: ContextMessageRole
  readonly content: string
  readonly toolCallId?: string
  readonly toolName?: string
}

export interface ContextSummary {
  readonly objective: string
  readonly constraints: readonly string[]
  readonly decisions: readonly string[]
  readonly approvedArtifacts: readonly string[]
  readonly pendingApprovals: readonly string[]
  readonly blockers: readonly string[]
  readonly verification: readonly string[]
  readonly nextAction: string
}

export interface ContextSummarizerInput {
  readonly threadId: string
  readonly messages: readonly ContextMessage[]
}

export type ContextSummarizer = (input: ContextSummarizerInput) => Promise<ContextSummary>

export interface NativeCompactionResult {
  readonly opaque: string
  readonly summary?: ContextSummary
}

export interface NativeCompactionProvider {
  readonly id: string
  supports(): Promise<boolean>
  compact(input: ContextSummarizerInput): Promise<NativeCompactionResult>
}

export interface ContextCompactionArtifact {
  readonly schemaVersion: 1
  readonly id: string
  readonly strategy: 'native' | 'agentic' | 'deterministic'
  readonly createdAt: string
  readonly sourceMessageIds: readonly string[]
  readonly canonicalPrefixHash: string
  readonly summary: ContextSummary
  readonly opaque?: string
}

export interface ContextToolCallState {
  readonly idempotencyKey: string
  readonly status: 'completed' | 'failed'
  readonly updatedAt: string
}

export interface ContextCheckpoint {
  readonly schemaVersion: 1
  readonly threadId: string
  readonly revision: number
  readonly transcript: readonly ContextMessage[]
  readonly compactions: readonly ContextCompactionArtifact[]
  readonly toolCalls: readonly ContextToolCallState[]
}

export interface ContextCheckpointStore {
  load(threadId: string): Promise<ContextCheckpoint | null>
  save(checkpoint: ContextCheckpoint): Promise<void>
}

/** Narrow SQL boundary; the host owns the authenticated PostgreSQL client. */
export interface PostgresCheckpointQueryPort {
  query<T extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<readonly T[]>
}

export interface ContextManagerOptions {
  readonly contextWindowTokens: number
  readonly outputLimitTokens: number
  readonly toolBufferTokens: number
  readonly safetyMarginTokens: number
  readonly retainRecentMessages?: number
  readonly maxSummaryTokens?: number
  readonly summarizer?: ContextSummarizer
  readonly nativeCompaction?: NativeCompactionProvider
}

export interface ContextBudgetWindowOptions {
  /** Cumulative task ceiling across all context windows, including compaction. */
  readonly taskMaxTokens: number
  /** Maximum model tokens charged to one window before the caller must rotate it. */
  readonly windowMaxTokens: number
  /** Separate cumulative allowance for compaction calls. */
  readonly compactionMaxTokens: number
}

export interface ContextBudgetWindowSnapshot {
  readonly windowIndex: number
  readonly taskMaxTokens: number
  readonly taskConsumedTokens: number
  readonly windowMaxTokens: number
  readonly windowConsumedTokens: number
  readonly compactionMaxTokens: number
  readonly compactionConsumedTokens: number
}

export class ContextBudgetError extends Error {
  readonly code: 'task-exhausted' | 'window-exhausted' | 'compaction-exhausted'

  constructor(code: ContextBudgetError['code'], message: string) {
    super(message)
    this.name = 'ContextBudgetError'
    this.code = code
  }
}

/**
 * Splits a long task into independently bounded model windows while keeping a
 * hard cumulative task ceiling. Compaction is charged to both its own pool and
 * the cumulative task pool, so compression cannot bypass the task budget.
 */
export class ContextBudgetWindow {
  private readonly taskMaxTokens: number
  private readonly windowMaxTokens: number
  private readonly compactionMaxTokens: number
  private taskConsumedTokens = 0
  private windowConsumedTokens = 0
  private compactionConsumedTokens = 0
  private windowIndex = 0

  constructor(options: ContextBudgetWindowOptions) {
    this.taskMaxTokens = positiveLimit(options.taskMaxTokens, 'task token budget')
    this.windowMaxTokens = positiveLimit(options.windowMaxTokens, 'window token budget')
    this.compactionMaxTokens = positiveLimit(options.compactionMaxTokens, 'compaction token budget')
    if (this.compactionMaxTokens > this.taskMaxTokens) throw new Error('compaction token budget cannot exceed task token budget')
  }

  consumeModel(tokens: number): void {
    const amount = positiveLimit(tokens, 'model token usage')
    this.assertTaskCapacity(amount)
    if (amount > this.windowMaxTokens - this.windowConsumedTokens) throw new ContextBudgetError('window-exhausted', 'model window budget exhausted; open the next context window')
    this.taskConsumedTokens += amount
    this.windowConsumedTokens += amount
  }

  consumeCompaction(tokens: number): void {
    const amount = positiveLimit(tokens, 'compaction token usage')
    this.assertTaskCapacity(amount)
    if (amount > this.compactionMaxTokens - this.compactionConsumedTokens) throw new ContextBudgetError('compaction-exhausted', 'compaction budget exhausted; continue without another compaction')
    this.taskConsumedTokens += amount
    this.compactionConsumedTokens += amount
  }

  openNextWindow(): void {
    if (this.taskConsumedTokens >= this.taskMaxTokens) throw new ContextBudgetError('task-exhausted', 'task token budget exhausted')
    this.windowIndex += 1
    this.windowConsumedTokens = 0
  }

  snapshot(): ContextBudgetWindowSnapshot {
    return {
      windowIndex: this.windowIndex,
      taskMaxTokens: this.taskMaxTokens,
      taskConsumedTokens: this.taskConsumedTokens,
      windowMaxTokens: this.windowMaxTokens,
      windowConsumedTokens: this.windowConsumedTokens,
      compactionMaxTokens: this.compactionMaxTokens,
      compactionConsumedTokens: this.compactionConsumedTokens,
    }
  }

  private assertTaskCapacity(amount: number): void {
    if (amount > this.taskMaxTokens - this.taskConsumedTokens) throw new ContextBudgetError('task-exhausted', 'task token budget exhausted')
  }
}

export interface ContextProjection {
  readonly threadId: string
  readonly messages: readonly ContextMessage[]
  readonly estimatedTokens: number
  readonly safeLimitTokens: number
  readonly contextHash: string
  readonly actions: readonly ('tool-output-pruned' | 'compacted' | 'fallback' | 'native' | 'agentic')[]
  readonly compactionId?: string
}

export class ContextCompactionError extends Error {
  readonly rolledBack = true

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ContextCompactionError'
  }
}

/**
 * Local, provider-neutral context projection used by the T25 isolation spike.
 * The transcript is append-only; compaction artifacts are separate projections.
 */
export class ContextManager {
  private readonly safeLimitTokens: number
  private readonly retainRecentMessages: number
  private readonly maxSummaryTokens: number
  private readonly transcript: ContextMessage[]
  private readonly compactions: ContextCompactionArtifact[]
  private readonly toolCalls = new Map<string, ContextToolCallState>()
  private revision: number

  private constructor(
    readonly threadId: string,
    private readonly store: ContextCheckpointStore,
    private readonly options: ContextManagerOptions,
    checkpoint?: ContextCheckpoint,
  ) {
    assertIdentifier(threadId, 'thread id')
    this.safeLimitTokens = positiveLimit(options.contextWindowTokens - options.outputLimitTokens - options.toolBufferTokens - options.safetyMarginTokens, 'context safe limit')
    this.retainRecentMessages = positiveInteger(options.retainRecentMessages ?? 8, 'retain recent messages')
    this.maxSummaryTokens = positiveLimit(options.maxSummaryTokens ?? 1024, 'summary limit')
    if (checkpoint !== undefined && checkpoint.threadId !== threadId) throw new Error('context checkpoint thread mismatch')
    this.transcript = [...(checkpoint?.transcript ?? [])].map(validateMessage)
    this.compactions = [...(checkpoint?.compactions ?? [])].map(validateCompaction)
    for (const call of checkpoint?.toolCalls ?? []) {
      const valid = validateToolCall(call)
      this.toolCalls.set(valid.idempotencyKey, valid)
    }
    this.revision = checkpoint?.revision ?? 0
  }

  static async open(threadId: string, store: ContextCheckpointStore, options: ContextManagerOptions): Promise<ContextManager> {
    assertIdentifier(threadId, 'thread id')
    const checkpoint = await store.load(threadId)
    return new ContextManager(threadId, store, options, checkpoint ?? undefined)
  }

  append(messages: readonly ContextMessage[]): void {
    const existing = new Set(this.transcript.map(message => message.id))
    for (const input of messages) {
      const message = validateMessage(input)
      if (existing.has(message.id)) throw new Error(`duplicate context message id: ${message.id}`)
      existing.add(message.id)
      this.transcript.push(message)
    }
    if (messages.length > 0) this.revision += 1
  }

  /** A completed idempotency key is never executed again after resume; failed keys remain retryable. */
  recordToolCall(idempotencyKey: string, status: ContextToolCallState['status']): void {
    assertIdentifier(idempotencyKey, 'tool idempotency key')
    if (status === 'failed' && this.toolCalls.get(idempotencyKey)?.status === 'completed') return
    this.toolCalls.set(idempotencyKey, { idempotencyKey, status, updatedAt: new Date().toISOString() })
    this.revision += 1
  }

  shouldExecuteTool(idempotencyKey: string): boolean {
    return this.toolCalls.get(idempotencyKey)?.status !== 'completed'
  }

  snapshot(): ContextCheckpoint {
    return {
      schemaVersion: 1,
      threadId: this.threadId,
      revision: this.revision,
      transcript: this.transcript.map(cloneMessage),
      compactions: this.compactions.map(cloneCompaction),
      toolCalls: [...this.toolCalls.values()].map(validateToolCall),
    }
  }

  async saveCheckpoint(): Promise<void> {
    await this.store.save(this.snapshot())
  }

  async prepare(): Promise<ContextProjection> {
    let messages = this.buildProjectedMessages()
    const actions: ContextProjection['actions'][number][] = []
    if (estimateTokens(messages) <= this.safeLimitTokens) return this.projection(messages, actions)

    const cleaned = cleanOldToolResults(messages, this.retainRecentMessages)
    messages = cleaned.messages
    if (cleaned.changed) actions.push('tool-output-pruned')
    if (estimateTokens(messages) <= this.safeLimitTokens) return this.projection(messages, actions)

    const before = this.snapshot()
    await this.store.save(before)
    try {
      const boundary = this.findCompactionBoundary()
      if (boundary <= 0) throw new Error('no complete context group can be compacted')
      const source = this.transcript.slice(0, boundary)
      const artifact = await this.createCompaction(source)
      this.compactions.push(artifact)
      this.revision += 1
      const fittedArtifact = this.fitLatestArtifact(artifact)
      this.compactions[this.compactions.length - 1] = fittedArtifact
      messages = this.buildProjectedMessages()
      const afterCleanup = cleanOldToolResults(messages, this.retainRecentMessages)
      messages = afterCleanup.messages
      if (afterCleanup.changed && !actions.includes('tool-output-pruned')) actions.push('tool-output-pruned')
      if (estimateTokens(messages) > this.safeLimitTokens) throw new Error('compacted context still exceeds safe limit')
      actions.push('compacted')
      if (artifact.strategy === 'native') actions.push('native')
      if (artifact.strategy === 'agentic') actions.push('agentic')
      if (artifact.strategy === 'deterministic' && this.options.summarizer !== undefined) actions.push('fallback')
      await this.saveCheckpoint()
      return this.projection(messages, actions, artifact.id)
    } catch (error: unknown) {
      this.restore(before)
      throw new ContextCompactionError('context compaction rolled back', { cause: error })
    }
  }

  private projection(messages: readonly ContextMessage[], actions: readonly ContextProjection['actions'][number][], compactionId?: string): ContextProjection {
    return {
      threadId: this.threadId,
      messages: Object.freeze(messages.map(cloneMessage)),
      estimatedTokens: estimateTokens(messages),
      safeLimitTokens: this.safeLimitTokens,
      contextHash: hashMessages(messages),
      actions: Object.freeze([...actions]),
      ...(compactionId === undefined ? {} : { compactionId }),
    }
  }

  private restore(checkpoint: ContextCheckpoint): void {
    this.transcript.splice(0, this.transcript.length, ...checkpoint.transcript.map(cloneMessage))
    this.compactions.splice(0, this.compactions.length, ...checkpoint.compactions.map(cloneCompaction))
    this.toolCalls.clear()
    for (const call of checkpoint.toolCalls) this.toolCalls.set(call.idempotencyKey, validateToolCall(call))
    this.revision = checkpoint.revision
  }

  private findCompactionBoundary(): number {
    let boundary = Math.max(0, this.transcript.length - this.retainRecentMessages)
    while (boundary > 0 && crossesToolPair(this.transcript, boundary)) boundary -= 1
    if (boundary > 0 && this.transcript.slice(0, boundary).every(message => message.role === 'system')) return 0
    return boundary
  }

  private async createCompaction(source: readonly ContextMessage[]): Promise<ContextCompactionArtifact> {
    let strategy: ContextCompactionArtifact['strategy'] = 'deterministic'
    let summary = deterministicSummary(source)
    let opaque: string | undefined

    const native = this.options.nativeCompaction
    if (native !== undefined) {
      let supported = false
      try { supported = await native.supports() } catch { supported = false }
      if (supported) {
        try {
          const result = await native.compact({ threadId: this.threadId, messages: source })
          if (result.opaque.trim().length === 0) throw new Error('native compaction returned an empty opaque item')
          strategy = 'native'
          opaque = result.opaque
          if (result.summary !== undefined) summary = normalizeSummary(result.summary, source)
        } catch {
          strategy = 'deterministic'
        }
      }
    }

    if (strategy === 'deterministic' && this.options.summarizer !== undefined) {
      try {
        summary = normalizeSummary(await this.options.summarizer({ threadId: this.threadId, messages: source }), source)
        strategy = 'agentic'
      } catch {
        strategy = 'deterministic'
      }
    }

    return {
      schemaVersion: 1,
      id: randomUUID(),
      strategy,
      createdAt: new Date().toISOString(),
      sourceMessageIds: Object.freeze(source.map(message => message.id)),
      canonicalPrefixHash: hashMessages(source),
      summary: limitSummary(summary, this.maxSummaryTokens),
      ...(opaque === undefined ? {} : { opaque }),
    }
  }

  private fitLatestArtifact(artifact: ContextCompactionArtifact): ContextCompactionArtifact {
    const marker = `compaction:${artifact.id}`
    const base = this.buildProjectedMessages().filter(message => message.id !== marker)
    const available = this.safeLimitTokens - estimateTokens(base)
    for (let tokenLimit = Math.min(this.maxSummaryTokens, available); tokenLimit >= 1; tokenLimit -= 1) {
      const candidate = { ...artifact, summary: limitSummary(artifact.summary, tokenLimit) }
      if (estimateTokens([...base, { id: marker, role: 'system' as const, content: renderSummary(candidate) }]) <= this.safeLimitTokens) return candidate
    }
    throw new Error('compaction summary cannot fit the context safe limit')
  }

  private buildProjectedMessages(): ContextMessage[] {
    const artifact = this.latestValidCompaction()
    if (artifact === undefined) return this.transcript.map(cloneMessage)
    const count = artifact.sourceMessageIds.length
    const prefix = this.transcript.slice(0, count)
    const suffix = this.transcript.slice(count)
    const summaryMessage: ContextMessage = {
      id: `compaction:${artifact.id}`,
      role: 'system',
      content: renderSummary(artifact),
    }
    return [...prefix.filter(message => message.role === 'system'), summaryMessage, ...suffix].map(cloneMessage)
  }

  private latestValidCompaction(): ContextCompactionArtifact | undefined {
    for (let index = this.compactions.length - 1; index >= 0; index -= 1) {
      const artifact = this.compactions[index]
      if (artifact === undefined) continue
      const prefix = this.transcript.slice(0, artifact.sourceMessageIds.length)
      if (prefix.length !== artifact.sourceMessageIds.length) continue
      if (prefix.some((message, position) => message.id !== artifact.sourceMessageIds[position])) continue
      if (hashMessages(prefix) !== artifact.canonicalPrefixHash) continue
      return artifact
    }
    return undefined
  }
}

export class MemoryContextCheckpointStore implements ContextCheckpointStore {
  private readonly checkpoints = new Map<string, ContextCheckpoint>()

  async load(threadId: string): Promise<ContextCheckpoint | null> {
    assertIdentifier(threadId, 'thread id')
    const checkpoint = this.checkpoints.get(threadId)
    return checkpoint === undefined ? null : cloneCheckpoint(checkpoint)
  }

  async save(checkpoint: ContextCheckpoint): Promise<void> {
    const valid = validateCheckpoint(checkpoint)
    this.checkpoints.set(valid.threadId, cloneCheckpoint(valid))
  }
}

/** PostgreSQL persistence seam for the LangGraph integration spike. */
export class PostgresContextCheckpointStore implements ContextCheckpointStore {
  private schemaReady: Promise<void> | undefined

  constructor(private readonly database: PostgresCheckpointQueryPort) {}

  async load(threadId: string): Promise<ContextCheckpoint | null> {
    assertIdentifier(threadId, 'thread id')
    await this.ensureSchema()
    const rows = await this.database.query<{ payload: unknown }>(
      'SELECT payload FROM backend_team_context_checkpoints WHERE thread_id = $1',
      [threadId],
    )
    const row = rows[0]
    if (row === undefined) return null
    return validateCheckpoint(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload)
  }

  async save(checkpoint: ContextCheckpoint): Promise<void> {
    const valid = validateCheckpoint(checkpoint)
    await this.ensureSchema()
    await this.database.query(
      `INSERT INTO backend_team_context_checkpoints (thread_id, revision, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (thread_id) DO UPDATE
       SET revision = EXCLUDED.revision, payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP
       WHERE backend_team_context_checkpoints.revision <= EXCLUDED.revision`,
      [valid.threadId, valid.revision, JSON.stringify(valid)],
    )
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady === undefined) {
      const operation = this.database.query(
        `CREATE TABLE IF NOT EXISTS backend_team_context_checkpoints (
           thread_id TEXT PRIMARY KEY,
           revision BIGINT NOT NULL CHECK (revision >= 0),
           payload JSONB NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`,
        [],
      ).then(() => undefined)
      this.schemaReady = operation.catch(error => { this.schemaReady = undefined; throw error })
    }
    await this.schemaReady
  }
}

/** Workspace-local atomic checkpoint store used by the isolation spike and later adapter work. */
export class FileContextCheckpointStore implements ContextCheckpointStore {
  private readonly root: string

  constructor(workspaceRoot: string) {
    this.root = realpathSync.native(workspaceRoot)
  }

  async load(threadId: string): Promise<ContextCheckpoint | null> {
    const path = await this.pathFor(threadId, false)
    if (path === null) return null
    let handle
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error: unknown) { if (isMissing(error)) return null; throw error }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > 32 * 1024 * 1024) throw new Error('unsafe context checkpoint file')
      return validateCheckpoint(JSON.parse(await handle.readFile('utf8')))
    } finally { await handle.close() }
  }

  async save(checkpoint: ContextCheckpoint): Promise<void> {
    const valid = validateCheckpoint(checkpoint)
    const path = await this.pathFor(valid.threadId, true)
    if (path === null) throw new Error('unable to create context checkpoint directory')
    const directory = join(this.root, '.backend-team', 'context')
    const temporary = join(directory, `${randomUUID()}.tmp`)
    const content = JSON.stringify(valid)
    let handle
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await chmod(temporary, 0o600)
      await rename(temporary, path)
    } finally {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error })
    }
  }

  private async pathFor(threadId: string, create: boolean): Promise<string | null> {
    assertIdentifier(threadId, 'thread id')
    const backend = join(this.root, '.backend-team')
    const directory = join(backend, 'context')
    for (const path of [backend, directory]) {
      let info
      try { info = await lstat(path) }
      catch (error: unknown) {
        if (!isMissing(error)) throw error
        if (!create) return null
        await mkdir(path, { mode: 0o700 })
        info = await lstat(path)
      }
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error(`unsafe context checkpoint directory: ${path}`)
      if (create) await chmod(path, 0o700)
    }
    const path = join(directory, `${threadId}.json`)
    if (!create) {
      try { const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('unsafe context checkpoint file') }
      catch (error: unknown) { if (isMissing(error)) return null; throw error }
    }
    return path
  }
}

function validateCheckpoint(input: unknown): ContextCheckpoint {
  if (!isRecord(input) || input.schemaVersion !== 1 || typeof input.threadId !== 'string' || typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Array.isArray(input.transcript) || !Array.isArray(input.compactions) || !Array.isArray(input.toolCalls)) throw new Error('context checkpoint is invalid')
  assertIdentifier(input.threadId, 'thread id')
  const transcript = input.transcript.map(validateMessage)
  const ids = new Set<string>()
  for (const message of transcript) { if (ids.has(message.id)) throw new Error('context checkpoint contains duplicate message ids'); ids.add(message.id) }
  return {
    schemaVersion: 1,
    threadId: input.threadId,
    revision: input.revision,
    transcript,
    compactions: input.compactions.map(validateCompaction),
    toolCalls: input.toolCalls.map(validateToolCall),
  }
}

function validateMessage(input: unknown): ContextMessage {
  if (!isRecord(input) || typeof input.id !== 'string' || typeof input.content !== 'string' || !['system', 'user', 'assistant', 'tool'].includes(input.role as string)) throw new Error('context message is invalid')
  assertIdentifier(input.id, 'context message id')
  if (input.content.length > 4 * 1024 * 1024) throw new Error('context message is oversized')
  const message: ContextMessage = { id: input.id, role: input.role as ContextMessageRole, content: input.content }
  if (input.toolCallId !== undefined) { if (typeof input.toolCallId !== 'string') throw new Error('context tool call id is invalid'); assertIdentifier(input.toolCallId, 'context tool call id'); return { ...message, toolCallId: input.toolCallId, ...(input.toolName === undefined ? {} : { toolName: String(input.toolName) }) } }
  return input.toolName === undefined ? message : { ...message, toolName: String(input.toolName) }
}

function validateCompaction(input: unknown): ContextCompactionArtifact {
  if (!isRecord(input) || input.schemaVersion !== 1 || typeof input.id !== 'string' || !['native', 'agentic', 'deterministic'].includes(input.strategy as string) || typeof input.createdAt !== 'string' || !Array.isArray(input.sourceMessageIds) || typeof input.canonicalPrefixHash !== 'string' || !isRecord(input.summary)) throw new Error('context compaction artifact is invalid')
  assertIdentifier(input.id, 'compaction id')
  if (!/^[a-f0-9]{64}$/u.test(input.canonicalPrefixHash)) throw new Error('context compaction hash is invalid')
  const result: ContextCompactionArtifact = { schemaVersion: 1, id: input.id, strategy: input.strategy as ContextCompactionArtifact['strategy'], createdAt: input.createdAt, sourceMessageIds: input.sourceMessageIds.map(value => { if (typeof value !== 'string') throw new Error('compaction source id is invalid'); assertIdentifier(value, 'compaction source id'); return value }), canonicalPrefixHash: input.canonicalPrefixHash, summary: normalizeSummary(input.summary, []) }
  return input.opaque === undefined ? result : { ...result, opaque: String(input.opaque) }
}

function validateToolCall(input: unknown): ContextToolCallState {
  if (!isRecord(input) || typeof input.idempotencyKey !== 'string' || !['completed', 'failed'].includes(input.status as string) || typeof input.updatedAt !== 'string') throw new Error('context tool call state is invalid')
  assertIdentifier(input.idempotencyKey, 'tool idempotency key')
  return { idempotencyKey: input.idempotencyKey, status: input.status as ContextToolCallState['status'], updatedAt: input.updatedAt }
}

function normalizeSummary(input: unknown, source: readonly ContextMessage[]): ContextSummary {
  const record = isRecord(input) ? input : {}
  const firstUser = source.find(message => message.role === 'user')?.content.trim() ?? ''
  return {
    objective: typeof record.objective === 'string' && record.objective.trim().length > 0 ? record.objective.trim() : firstUser || 'Continue the current task.',
    constraints: stringArray(record.constraints),
    decisions: stringArray(record.decisions),
    approvedArtifacts: stringArray(record.approvedArtifacts),
    pendingApprovals: stringArray(record.pendingApprovals),
    blockers: stringArray(record.blockers),
    verification: stringArray(record.verification),
    nextAction: typeof record.nextAction === 'string' && record.nextAction.trim().length > 0 ? record.nextAction.trim() : 'Resume from the latest checkpoint.',
  }
}

function deterministicSummary(messages: readonly ContextMessage[]): ContextSummary {
  const tagged = (tag: string): string[] => messages.flatMap(message => message.content.split('\n')).map(line => line.trim()).filter(line => line.toLowerCase().startsWith(`${tag.toLowerCase()}:`)).map(line => line.slice(tag.length + 1).trim()).filter(Boolean).slice(0, 32)
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant')?.content.trim() ?? ''
  return {
    objective: messages.find(message => message.role === 'user')?.content.trim().slice(0, 1200) || 'Continue the current task.',
    constraints: tagged('CONSTRAINT'),
    decisions: tagged('DECISION'),
    approvedArtifacts: tagged('APPROVED'),
    pendingApprovals: tagged('PENDING'),
    blockers: tagged('BLOCKER'),
    verification: tagged('VERIFY'),
    nextAction: tagged('NEXT')[0] ?? (lastAssistant.slice(0, 600) || 'Resume from the latest checkpoint.'),
  }
}

function limitSummary(summary: ContextSummary, maxTokens: number): ContextSummary {
  const maxChars = maxTokens * 4
  const clip = (value: string, limit: number): string => value.slice(0, Math.max(1, limit))
  const list = (values: readonly string[], limit: number): readonly string[] => values.map(value => clip(value, limit)).slice(0, 32)
  const limited: ContextSummary = { objective: clip(summary.objective, 1200), constraints: list(summary.constraints, 500), decisions: list(summary.decisions, 500), approvedArtifacts: list(summary.approvedArtifacts, 500), pendingApprovals: list(summary.pendingApprovals, 500), blockers: list(summary.blockers, 500), verification: list(summary.verification, 500), nextAction: clip(summary.nextAction, 600) }
  const candidate: { -readonly [K in keyof ContextSummary]: ContextSummary[K] extends readonly string[] ? string[] : string } = { objective: limited.objective, constraints: [...limited.constraints], decisions: [...limited.decisions], approvedArtifacts: [...limited.approvedArtifacts], pendingApprovals: [...limited.pendingApprovals], blockers: [...limited.blockers], verification: [...limited.verification], nextAction: limited.nextAction }
  const fields = ['constraints', 'decisions', 'approvedArtifacts', 'pendingApprovals', 'blockers', 'verification'] as const
  while (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > Math.max(96, maxChars)) {
    const field = fields.find(name => candidate[name].length > 0)
    if (field !== undefined) { candidate[field].pop(); continue }
    if (candidate.objective.length > 1) { candidate.objective = candidate.objective.slice(0, Math.max(1, Math.floor(candidate.objective.length * 0.75))); continue }
    if (candidate.nextAction.length > 1) { candidate.nextAction = candidate.nextAction.slice(0, Math.max(1, Math.floor(candidate.nextAction.length * 0.75))); continue }
    break
  }
  return candidate
}

function renderSummary(artifact: ContextCompactionArtifact): string {
  const summary = artifact.summary
  const lines = [`[Context compaction ${artifact.id}; strategy=${artifact.strategy}; source=${artifact.sourceMessageIds.length}; prefix=${artifact.canonicalPrefixHash}]`, `Objective: ${summary.objective}`, `Constraints: ${summary.constraints.join(' | ') || 'none'}`, `Decisions: ${summary.decisions.join(' | ') || 'none'}`, `Approved artifacts: ${summary.approvedArtifacts.join(' | ') || 'none'}`, `Pending approvals: ${summary.pendingApprovals.join(' | ') || 'none'}`, `Blockers: ${summary.blockers.join(' | ') || 'none'}`, `Verification: ${summary.verification.join(' | ') || 'none'}`, `Next action: ${summary.nextAction}`]
  if (artifact.opaque !== undefined) lines.push(`Provider compaction item: ${artifact.opaque}`)
  return lines.join('\n')
}

function cleanOldToolResults(messages: readonly ContextMessage[], retainRecent: number): { readonly messages: ContextMessage[]; readonly changed: boolean } {
  const protectedIds = new Set(messages.slice(-retainRecent).map(message => message.id))
  let changed = false
  const cleaned = messages.map(message => {
    if (message.role !== 'tool' || protectedIds.has(message.id) || message.content.length < 80) return cloneMessage(message)
    changed = true
    return { ...message, content: `[tool result archived; message=${message.id}; retrieve from canonical transcript]` }
  })
  return { messages: cleaned, changed }
}

function crossesToolPair(messages: readonly ContextMessage[], boundary: number): boolean {
  const left = new Set(messages.slice(0, boundary).flatMap(message => message.toolCallId === undefined ? [] : [message.toolCallId]))
  return messages.slice(boundary).some(message => message.toolCallId !== undefined && left.has(message.toolCallId))
}

function estimateTokens(messages: readonly ContextMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(message), 'utf8') / 4)), 0)
}

function hashMessages(messages: readonly ContextMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages.map(message => ({ id: message.id, role: message.role, content: message.content, ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }), ...(message.toolName === undefined ? {} : { toolName: message.toolName }) }))), 'utf8').digest('hex')
}

function cloneMessage(message: ContextMessage): ContextMessage { return { id: message.id, role: message.role, content: message.content, ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }), ...(message.toolName === undefined ? {} : { toolName: message.toolName }) } }
function cloneCompaction(artifact: ContextCompactionArtifact): ContextCompactionArtifact { return { ...artifact, sourceMessageIds: [...artifact.sourceMessageIds], summary: { ...artifact.summary, constraints: [...artifact.summary.constraints], decisions: [...artifact.summary.decisions], approvedArtifacts: [...artifact.summary.approvedArtifacts], pendingApprovals: [...artifact.summary.pendingApprovals], blockers: [...artifact.summary.blockers], verification: [...artifact.summary.verification] } } }
function cloneCheckpoint(checkpoint: ContextCheckpoint): ContextCheckpoint { return { ...checkpoint, transcript: checkpoint.transcript.map(cloneMessage), compactions: checkpoint.compactions.map(cloneCompaction), toolCalls: checkpoint.toolCalls.map(validateToolCall) } }

function stringArray(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()).slice(0, 32) : [] }
function positiveLimit(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value }
function positiveInteger(value: number, name: string): number { return positiveLimit(value, name) }
function assertIdentifier(value: string, name: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error(`${name} is invalid`) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }
