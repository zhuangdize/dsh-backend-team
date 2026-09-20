import { describe, expect, it } from 'vitest'
import type { BackendTeamEvent } from '@dsh-backend-team/contracts'
import { AuthenticatedLocalSessionSchema } from '../src/remote-contract.js'
import { createBackendTeamControlSurface } from '../src/control-surface.js'

describe('Backend Team control surface', () => {
  it('replays persisted events and projects new events for subscribers', async () => {
    const feed = new EventFeed([phaseEvent(1, 'PLAN')])
    const surface = await createBackendTeamControlSurface({
      events: feed,
      workspaceName: 'demo',
      coordinator: { dispatch: async (_action, context) => ({ accepted: true, stateRevision: context.expectedRevision }) },
      authenticator: { authenticate: (input) => AuthenticatedLocalSessionSchema.parse(input) },
    })

    expect(surface.projector.snapshot()).toMatchObject({ phase: 'PLAN', lastSequence: 1 })
    const states: string[] = []
    const remove = surface.subscriptions.subscribe('browser-1', (state) => { states.push(state.phase) }, surface.projector.snapshot())
    feed.emit(phaseEvent(2, 'BUILD'))
    expect(surface.projector.snapshot()).toMatchObject({ phase: 'BUILD', lastSequence: 2 })
    await Promise.resolve()
    expect(states).toEqual(['PLAN', 'BUILD'])

    remove()
    surface.subscriptions.subscribe('browser-2', () => undefined, surface.projector.snapshot())
    await surface.dispose()
    await surface.dispose()
    expect(feed.listenerCount()).toBe(0)
    expect(surface.subscriptions.size()).toBe(0)
  })

  it('buffers events emitted while the initial replay is reading', async () => {
    const feed = new EventFeed([])
    let releaseRead!: () => void
    const readFinished = new Promise<void>((resolve) => { releaseRead = resolve })
    feed.read = async () => { await readFinished; return [phaseEvent(1, 'PLAN')] }
    const creating = createBackendTeamControlSurface({
      events: feed,
      workspaceName: 'demo',
      coordinator: { dispatch: async (_action, context) => ({ accepted: true, stateRevision: context.expectedRevision }) },
      authenticator: { authenticate: (input) => AuthenticatedLocalSessionSchema.parse(input) },
    })
    feed.emit(phaseEvent(2, 'BUILD'))
    releaseRead()
    const surface = await creating

    expect(surface.projector.snapshot()).toMatchObject({ phase: 'BUILD', lastSequence: 2 })
    await surface.dispose()
  })
})

class EventFeed {
  private readonly listeners = new Set<(event: BackendTeamEvent) => void>()
  constructor(private readonly events: readonly BackendTeamEvent[]) {}
  read = async (): Promise<readonly BackendTeamEvent[]> => this.events
  subscribe(listener: (event: BackendTeamEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendTeamEvent): void { for (const listener of this.listeners) listener(event) }
  listenerCount(): number { return this.listeners.size }
}

function phaseEvent(sequence: number, phase: BackendTeamEvent extends { type: 'phase-changed' } ? never : 'PLAN' | 'BUILD'): BackendTeamEvent {
  return { id: `phase-${sequence}`, sequence, occurredAt: `2026-01-01T00:00:0${sequence}.000Z`, type: 'phase-changed', revision: sequence, phase } as BackendTeamEvent
}

it('publishes live database status and removes its listener on disposal', async () => {
  let runtime: 'stopped' | 'ready' = 'stopped'; let listener: (() => void) | undefined
  const surface = await createBackendTeamControlSurface({ workspaceName: 'database', events: new EventFeed([]), coordinator: { dispatch: async () => ({ accepted: true, stateRevision: 0 }) }, authenticator: { authenticate: input => AuthenticatedLocalSessionSchema.parse(input) }, databaseFeed: {
    snapshot: () => ({ runtime, engine: 'PostgreSQL 18.6', guiAvailable: false, controlsAvailable: true }),
    subscribe: (callback: () => void) => { listener = callback; return () => { listener = undefined } },
  } })
  const observed: string[] = []
  surface.subscriptions.subscribe('db-browser', state => { observed.push(state.database.runtime) }, surface.projector.snapshot())
  runtime = 'ready'; listener!(); await Promise.resolve()
  expect(observed).toEqual(['stopped', 'ready'])
  await surface.dispose(); expect(listener).toBeUndefined()
})
