import type { ApprovalDecision, ApprovalRequest } from '@dsh-backend-team/contracts'
export interface PendingApproval { readonly id: string; readonly workspaceId: string; readonly request: ApprovalRequest; readonly artifactHash: string; readonly stateRevision: number }
export interface ApprovalContext { readonly workspaceId: string; readonly stateRevision: number; readonly approvalId?: string }
/** Settlement seam for callers that must wait for the consumer's state transaction. */
export interface ApprovalSettlementPort {
  waitForSettlement(request: ApprovalRequest, stateRevision: number): Promise<void>
  completeSettlement(request: ApprovalRequest): void
  failSettlement(request: ApprovalRequest, error: unknown): void
}
export class ApprovalPortClosedError extends Error {
  constructor() { super('approval port is closed'); this.name = 'ApprovalPortClosedError' }
}
export class ControlMediatedApprovalPort {
  private readonly listeners = new Set<() => void>()
  private notificationQueued = false
  private counter = 0
  private readonly pending = new Map<string, ApprovalEntry>()
  private readonly decided = new Map<string, ApprovalEntry>()
  private closed = false
  private drainPromise: Promise<void> | undefined
  constructor(private readonly workspaceId: string) {}
  requestApproval(request: ApprovalRequest, context: ApprovalContext = { workspaceId: this.workspaceId, stateRevision: 0 }): Promise<ApprovalDecision> {
    if (context.workspaceId !== this.workspaceId) throw new Error('approval workspace mismatch')
    if (this.closed) return Promise.reject(new ApprovalPortClosedError())
    const hash = Object.values(request.artifactHashes)[0]; if (hash === undefined) throw new Error('approval requires an artifact hash')
    const id = context.approvalId ?? `approval-${++this.counter}`
    if (this.pending.has(id) || this.decided.has(id)) throw new Error('approval id is already pending or settling')
    const record = { id, workspaceId: this.workspaceId, request, artifactHash: hash, stateRevision: context.stateRevision }
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        record,
        resolve,
        reject,
        settlement: deferred<void>(),
        settlementAttached: false,
      })
      this.notify()
    })
  }
  subscribe(listener: () => void): () => void {
    if (this.closed) throw new ApprovalPortClosedError()
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private notify(): void {
    if (this.notificationQueued) return
    this.notificationQueued = true
    queueMicrotask(() => {
      this.notificationQueued = false
      for (const listener of this.listeners) {
        // Observation cannot prevent an approval transaction or its cleanup.
        try { listener() } catch { /* the subscriber owns its error handling */ }
      }
    })
  }
  listPending(): readonly PendingApproval[] { return Object.freeze([...this.pending.values()].map((entry) => entry.record)) }
  decide(id: string, decision: ApprovalDecision, artifactHash: string, stateRevision: number): void {
    const pending = this.pending.get(id); if (pending === undefined) throw new Error('approval request is unknown or already decided')
    if (pending.record.artifactHash !== artifactHash) throw new Error('approval artifact hash mismatch'); if (pending.record.stateRevision !== stateRevision) throw new Error('approval revision is stale')
    this.pending.delete(id); this.decided.set(id, pending); pending.resolve(decision); this.notify()
    if (!pending.settlementAttached) this.completeEntry(pending)
  }
  /** Decide and wait until the consumer has persisted the resulting state. */
  async decideAndWait(id: string, decision: ApprovalDecision, artifactHash: string, stateRevision: number): Promise<void> {
    const pending = this.pending.get(id)
    if (pending === undefined) throw new Error('approval request is unknown or already decided')
    this.decide(id, decision, artifactHash, stateRevision)
    await pending.settlement.promise
  }
  waitForSettlement(request: ApprovalRequest, stateRevision: number): Promise<void> {
    const entry = this.findByRequest(request, stateRevision)
    if (entry === undefined) throw new Error('approval settlement request is unknown')
    entry.settlementAttached = true
    return entry.settlement.promise
  }
  completeSettlement(request: ApprovalRequest): void {
    const entry = this.findByRequest(request)
    if (entry !== undefined) this.completeEntry(entry)
  }
  failSettlement(request: ApprovalRequest, error: unknown): void {
    const entry = this.findByRequest(request)
    if (entry !== undefined) this.failEntry(entry, error)
  }
  /** Close new requests, reject undecided requests, and drain decided transactions. */
  closeAndDrain(): Promise<void> {
    if (this.drainPromise !== undefined) return this.drainPromise
    if (this.closed) return Promise.resolve()
    this.closed = true
    const error = new ApprovalPortClosedError()
    for (const entry of this.pending.values()) {
      entry.reject(error)
      this.failEntry(entry, error)
    }
    this.pending.clear()
    const settlements = [...this.decided.values()].map((entry) => entry.settlement.promise)
    this.drainPromise = Promise.allSettled(settlements).then(() => {
      this.decided.clear()
    })
    return this.drainPromise
  }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    const error = new ApprovalPortClosedError()
    for (const entry of this.pending.values()) {
      entry.reject(error)
      this.failEntry(entry, error)
    }
    for (const entry of this.decided.values()) this.failEntry(entry, error)
    this.pending.clear()
    this.decided.clear()
  }

  private findByRequest(request: ApprovalRequest, stateRevision?: number): ApprovalEntry | undefined {
    for (const entry of [...this.pending.values(), ...this.decided.values()]) {
      if (entry.record.request === request && (stateRevision === undefined || entry.record.stateRevision === stateRevision)) return entry
    }
    return undefined
  }

  private completeEntry(entry: ApprovalEntry): void {
    this.decided.delete(entry.record.id)
    this.pending.delete(entry.record.id)
    entry.settlement.resolve()
    this.notify()
  }

  private failEntry(entry: ApprovalEntry, error: unknown): void {
    this.decided.delete(entry.record.id)
    this.pending.delete(entry.record.id)
    entry.settlement.reject(error)
    this.notify()
  }
}

interface ApprovalEntry {
  readonly record: PendingApproval
  readonly resolve: (decision: ApprovalDecision) => void
  readonly reject: (error: unknown) => void
  readonly settlement: Deferred<void>
  settlementAttached: boolean
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  // A settlement is optional for legacy callers. Keep an unhandled rejection
  // from an unobserved settlement while preserving the original promise for
  // callers that explicitly await it.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
