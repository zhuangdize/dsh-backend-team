import { describe, expect, it } from 'vitest'
import { BackendTeamViewProjector, SubscriptionHub } from '../src/index.js'
describe('SubscriptionHub', () => { it('keeps at most one pending snapshot per subscriber', async () => { const initial = new BackendTeamViewProjector({ workspaceName: 'demo' }).snapshot(); const seen: number[] = []; const hub = new SubscriptionHub(); hub.subscribe('session', async (state) => { seen.push(state.lastSequence); await new Promise((resolve) => setTimeout(resolve, 1)) }, initial); hub.publish({ ...initial, lastSequence: 1, stateRevision: 1 }); hub.publish({ ...initial, lastSequence: 2, stateRevision: 2 }); await new Promise((resolve) => setTimeout(resolve, 10)); expect(seen).toContain(2); expect(hub.size()).toBe(1) }) })

it('ignores stale snapshots that arrive after a newer pending snapshot', async () => {
  const initial = new BackendTeamViewProjector({ workspaceName: 'demo' }).snapshot()
  const seen: number[] = []
  let release: (() => void) | undefined
  const firstDelivery = new Promise<void>((resolve) => { release = resolve })
  const hub = new SubscriptionHub()
  hub.subscribe('session', async (state) => { seen.push(state.lastSequence); await firstDelivery }, initial)
  hub.publish({ ...initial, lastSequence: 2, stateRevision: 2 })
  hub.publish({ ...initial, lastSequence: 1, stateRevision: 1 })
  release?.()
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(seen).toContain(2)
  expect(seen).not.toContain(1)
})

it('removes a subscriber after delivery fails instead of retaining a broken stream', async () => {
  const initial = new BackendTeamViewProjector({ workspaceName: 'demo' }).snapshot()
  const hub = new SubscriptionHub()
  hub.subscribe('broken', () => { throw new Error('closed stream') }, initial)
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(hub.size()).toBe(0)
})

it('does not close a subscriber while its current snapshot is still delivering', async () => {
  const initial = new BackendTeamViewProjector({ workspaceName: 'demo' }).snapshot()
  let release: (() => void) | undefined
  const delivery = new Promise<void>((resolve) => { release = resolve })
  const hub = new SubscriptionHub()
  hub.subscribe('slow', async () => delivery, initial)
  hub.closeIdle(1)
  expect(hub.size()).toBe(1)
  release?.()
  await new Promise((resolve) => setTimeout(resolve, 5))
})
