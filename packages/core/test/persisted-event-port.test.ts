import { describe, expect, it } from 'vitest'
import { PersistedEventPort, type PersistedEventStore } from '../src/index.js'
import type { BackendTeamEvent } from '@dsh-backend-team/contracts'

const phaseEvent = (id: string, sequence: number, phase: 'SPECIFY' | 'DESIGN'): BackendTeamEvent => ({ id, sequence, occurredAt: '2026-08-28T00:00:00.000Z', type: 'phase-changed', revision: sequence, phase })

describe('PersistedEventPort recovery', () => {
  it('allocates sequences inside the serialized append operation', async () => {
    const events = new PersistedEventPort('/workspace', new DelayedStore())

    const [first, second] = await Promise.all([
      events.emitNext({ id: 'event-next-1', occurredAt: '2026-08-28T00:00:00.000Z', type: 'phase-changed', revision: 1, phase: 'SPECIFY' }),
      events.emitNext({ id: 'event-next-2', occurredAt: '2026-08-28T00:00:01.000Z', type: 'phase-changed', revision: 2, phase: 'DESIGN' }),
    ])

    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(await events.read()).toEqual([first, second])
  })

  it('rejects conflicting event IDs already present in durable storage', async () => {
    const store = new FixtureStore([phaseEvent('same-id', 1, 'SPECIFY'), phaseEvent('same-id', 2, 'DESIGN')])
    const events = new PersistedEventPort('/workspace', store)
    await expect(events.nextSequence()).rejects.toThrow(/duplicate event id/i)
  })

  it('rejects conflicting event sequences already present in durable storage', async () => {
    const store = new FixtureStore([phaseEvent('event-1', 1, 'SPECIFY'), phaseEvent('event-2', 1, 'DESIGN')])
    const events = new PersistedEventPort('/workspace', store)
    await expect(events.nextSequence()).rejects.toThrow(/event sequence/i)
  })

  it('serializes concurrent durable appends and subscriber delivery', async () => {
    const store = new DelayedStore()
    const events = new PersistedEventPort('/workspace', store)
    const delivered: string[] = []
    events.subscribe((event) => { delivered.push(event.id) })

    await Promise.all([
      events.emit(phaseEvent('event-1', 1, 'SPECIFY')),
      events.emit(phaseEvent('event-2', 2, 'DESIGN')),
    ])

    expect(store.maxConcurrent).toBe(1)
    expect(delivered).toEqual(['event-1', 'event-2'])
  })
})

class FixtureStore implements PersistedEventStore {
  private readonly events: BackendTeamEvent[]
  constructor(initial: readonly BackendTeamEvent[]) { this.events = [...initial] }
  async append(workspaceId: string, event: BackendTeamEvent): Promise<void> { void workspaceId; this.events.push(event) }
  async read(workspaceId: string): Promise<readonly BackendTeamEvent[]> { void workspaceId; return this.events }
}

class DelayedStore implements PersistedEventStore {
  private readonly events: BackendTeamEvent[] = []
  private concurrent = 0
  maxConcurrent = 0
  async append(workspaceId: string, event: BackendTeamEvent): Promise<void> {
    void workspaceId
    this.concurrent += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent)
    await new Promise((resolve) => setTimeout(resolve, 5))
    this.events.push(event)
    this.concurrent -= 1
  }
  async read(workspaceId: string): Promise<readonly BackendTeamEvent[]> { void workspaceId; return this.events }
}
