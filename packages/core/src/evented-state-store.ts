import { randomUUID } from 'node:crypto'
import type { BackendTeamEvent, BackendTeamState, StateMutation, StateStore } from '@dsh-backend-team/contracts'
import { PersistedEventPort, type PersistedEventDraft } from './persisted-event-port.js'

export interface EventedStateStoreEvents {
  emit(event: BackendTeamEvent): Promise<void>
  nextSequence(): Promise<number>
  emitNext?(event: PersistedEventDraft): Promise<BackendTeamEvent>
}

/**
 * Adds the application event feed to a revision-fenced state store.
 *
 * The wrapped store remains the source of truth. Events are emitted only after
 * the state transaction commits, so rejected revision writes never become
 * visible in the event feed. A later reconciliation can retry an event if the
 * event store itself is temporarily unavailable.
 */
export class EventedStateStore implements StateStore {
  private eventTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly stateStore: StateStore,
    private readonly events: EventedStateStoreEvents | PersistedEventPort,
  ) {}

  load(): Promise<BackendTeamState | null> {
    return this.stateStore.load()
  }

  create(initial: BackendTeamState): Promise<void> {
    return this.stateStore.create(initial)
  }

  async transact(expectedRevision: number, change: StateMutation): Promise<BackendTeamState> {
    const before = await this.stateStore.load()
    const next = await this.stateStore.transact(expectedRevision, change)
    if (before === null) return next
    await this.emitChanges(before, next)
    return next
  }

  private async emitChanges(before: BackendTeamState, next: BackendTeamState): Promise<void> {
    const occurredAt = new Date().toISOString()
    if (before.phase !== next.phase || before.workflowError !== next.workflowError || JSON.stringify(before.finalVerification) !== JSON.stringify(next.finalVerification)) {
      await this.append({
        id: randomUUID(),
        occurredAt,
        type: 'phase-changed',
        revision: next.revision,
        phase: next.phase,
      })
    }

    const previousApprovals = new Set(before.approvals.map(approvalIdentity))
    for (const approval of next.approvals) {
      if (previousApprovals.has(approvalIdentity(approval))) continue
      await this.append({
        id: randomUUID(),
        occurredAt,
        type: 'approval-recorded',
        revision: next.revision,
        approval,
      })
    }

    const previousRuns = new Map(before.runs.map((run) => [run.id, runIdentity(run)]))
    for (const run of next.runs) {
      if (previousRuns.get(run.id) === runIdentity(run)) continue
      await this.append({
        id: randomUUID(),
        occurredAt,
        type: 'run-recorded',
        revision: next.revision,
        run,
      })
    }
  }

  private async append(event: PersistedEventDraft): Promise<void> {
    const current = this.eventTail.then(async () => {
      if (this.events.emitNext !== undefined) {
        await this.events.emitNext(event)
        return
      }
      await this.events.emit({ ...event, sequence: await this.events.nextSequence() } as BackendTeamEvent)
    })
    this.eventTail = current.catch(() => undefined)
    await current
  }
}

function approvalIdentity(approval: BackendTeamState['approvals'][number]): string {
  return JSON.stringify(approval)
}

function runIdentity(run: BackendTeamState['runs'][number]): string {
  return JSON.stringify(run)
}
