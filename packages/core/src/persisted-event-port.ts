import { BackendTeamEventSchema } from '@dsh-backend-team/contracts'
import type { BackendTeamEvent } from '@dsh-backend-team/contracts'

export interface PersistedEventStore { append(workspaceId: string, event: BackendTeamEvent): Promise<void>; read(workspaceId: string): Promise<readonly BackendTeamEvent[]> }
export interface PersistedEventSubscriber { (event: BackendTeamEvent): void | Promise<void> }
type WithoutSequence<T> = T extends { sequence: number } ? Omit<T, 'sequence'> : never
export type PersistedEventDraft = WithoutSequence<BackendTeamEvent>
export class MemoryPersistedEventStore implements PersistedEventStore {
  private readonly events = new Map<string, BackendTeamEvent[]>()
  async append(workspaceId: string, event: BackendTeamEvent): Promise<void> { const list = this.events.get(workspaceId) ?? []; list.push(event); this.events.set(workspaceId, list) }
  async read(workspaceId: string): Promise<readonly BackendTeamEvent[]> { return Object.freeze([...(this.events.get(workspaceId) ?? [])]) }
}
/** Application-owned append-only event boundary. Events are durable before subscribers are notified. */
export class PersistedEventPort {
  private readonly byId = new Map<string, BackendTeamEvent>()
  private readonly bySequence = new Map<number, string>()
  private readonly subscribers = new Set<PersistedEventSubscriber>()
  private initialized = false
  private sequence = 1
  private emitTail: Promise<void> = Promise.resolve()
  constructor(private readonly workspaceId: string, private readonly store: PersistedEventStore) {}
  emit(eventInput: BackendTeamEvent): Promise<void> {
    const current = this.emitTail.then(() => this.emitOne(eventInput))
    this.emitTail = current.catch(() => undefined)
    return current
  }
  /** Allocate the sequence and append the event in one serialized operation. */
  emitNext(eventInput: PersistedEventDraft): Promise<BackendTeamEvent> {
    const current = this.emitTail.then(async () => {
      await this.initialize()
      const event = BackendTeamEventSchema.parse({ ...eventInput, sequence: this.sequence })
      await this.emitOne(event)
      return event
    })
    this.emitTail = current.then(() => undefined, () => undefined)
    return current
  }
  private async emitOne(eventInput: BackendTeamEvent): Promise<void> {
    await this.initialize()
    const event = BackendTeamEventSchema.parse(eventInput); const existing = this.byId.get(event.id)
    if (existing !== undefined) { if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('conflicting duplicate event id'); return }
    const owner = this.bySequence.get(event.sequence); if (owner !== undefined && owner !== event.id) throw new Error('conflicting event sequence')
    await this.store.append(this.workspaceId, event); this.byId.set(event.id, event); this.bySequence.set(event.sequence, event.id)
    this.sequence = Math.max(this.sequence, event.sequence + 1)
    for (const subscriber of this.subscribers) await subscriber(event)
  }
  async read(): Promise<readonly BackendTeamEvent[]> { const events = await this.store.read(this.workspaceId); return Object.freeze([...events].sort((left, right) => left.sequence - right.sequence)) }
  async nextSequence(): Promise<number> { await this.initialize(); return this.sequence++ }
  subscribe(subscriber: PersistedEventSubscriber): () => void { this.subscribers.add(subscriber); return () => { this.subscribers.delete(subscriber) } }
  private async initialize(): Promise<void> {
    if (this.initialized) return
    const persisted = await this.store.read(this.workspaceId)
    for (const stored of persisted) {
      const event = BackendTeamEventSchema.parse(stored)
      const existing = this.byId.get(event.id)
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('conflicting duplicate event id in durable storage')
        continue
      }
      const owner = this.bySequence.get(event.sequence)
      if (owner !== undefined && owner !== event.id) throw new Error('conflicting event sequence in durable storage')
      this.byId.set(event.id, event)
      this.bySequence.set(event.sequence, event.id)
      this.sequence = Math.max(this.sequence, event.sequence + 1)
    }
    this.initialized = true
  }
}
