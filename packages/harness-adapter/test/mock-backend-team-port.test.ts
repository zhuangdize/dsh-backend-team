import { describe, expect, it, vi } from 'vitest'
import type { BackendTeamEvent } from '@dsh-backend-team/contracts'
import {
  MockBackendTeamAgentCancelledError,
  MockBackendTeamOrchestrationPort,
  MockBackendTeamScriptExhaustedError,
} from '../src/index.js'

const event: BackendTeamEvent = {
  id: 'event-1', sequence: 1, occurredAt: '2026-08-26T00:00:00.000Z', type: 'phase-changed', revision: 1, phase: 'DISCOVER',
}

describe('application-layer backend team orchestration mock', () => {
  it('uses approval and agent scripts in FIFO order and fails on exhaustion', async () => {
    const mock = new MockBackendTeamOrchestrationPort({
      approvals: [
        { effect: 'reject', reason: 'first' },
        { effect: 'approve', reason: 'second' },
      ],
      agents: [{ result: 'one' }, { result: 'two' }],
    })
    expect(await mock.requestApproval({ kind: 'requirements', summary: 'a', artifactHashes: {} })).toEqual({ effect: 'reject', reason: 'first' })
    expect(await mock.requestApproval({ kind: 'design', summary: 'b', artifactHashes: {} })).toEqual({ effect: 'approve', reason: 'second' })
    await expect(mock.requestApproval({ kind: 'install', summary: 'c', artifactHashes: {} })).rejects.toBeInstanceOf(MockBackendTeamScriptExhaustedError)
    expect(mock.snapshot().approvalRequests.map((request) => request.summary)).toEqual(['a', 'b', 'c'])
    const first = await mock.spawnAgent({ task: 'one', role: 'worker', context: {} })
    const second = await mock.spawnAgent({ task: 'two', role: 'worker', context: {} })
    expect(await first.result()).toBe('one')
    expect(await second.result()).toBe('two')
    expect(mock.snapshot().spawnRequests.map((request) => request.task)).toEqual(['one', 'two'])
    await expect(mock.spawnAgent({ task: 'three', role: 'worker', context: {} })).rejects.toBeInstanceOf(MockBackendTeamScriptExhaustedError)
  })

  it('gives mock agent handles deterministic cancellation semantics', async () => {
    const mock = new MockBackendTeamOrchestrationPort({ agents: [{ result: { ok: true } }] })
    const handle = await mock.spawnAgent({ task: 'cancel', role: 'worker', context: {} })
    expect(handle.id).toBe('mock-agent-1')
    await handle.cancel()
    await expect(handle.result()).rejects.toBeInstanceOf(MockBackendTeamAgentCancelledError)
    await expect(handle.cancel()).resolves.toBeUndefined()
  })

  it('rejects an already-aborted result and cancellation during a pending result', async () => {
    const controller = new AbortController()
    controller.abort()
    const mock = new MockBackendTeamOrchestrationPort({ agents: [{ result: { ok: true }, pendingMs: 30 }] })
    const handle = await mock.spawnAgent({ task: 'abort', role: 'worker', context: {} })
    await expect(handle.result(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const pending = handle.result()
    await handle.cancel()
    await expect(pending).rejects.toBeInstanceOf(MockBackendTeamAgentCancelledError)
    await expect(handle.cancel()).resolves.toBeUndefined()
  })

  it('immediately wakes every pending result waiter when cancelled', async () => {
    vi.useFakeTimers()
    try {
      const mock = new MockBackendTeamOrchestrationPort({ agents: [{ result: { ok: true }, pendingMs: 1000 }] })
      const handle = await mock.spawnAgent({ task: 'many', role: 'worker', context: {} })
      let settled = false
      const waiters = Promise.allSettled([handle.result(), handle.result()]).then(() => { settled = true })
      await handle.cancel()
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(true)
      await expect(waiters).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans the pending timer when AbortSignal fires during result wait', async () => {
    vi.useFakeTimers()
    try {
      const mock = new MockBackendTeamOrchestrationPort({ agents: [{ result: { ok: true }, pendingMs: 1000 }] })
      const handle = await mock.spawnAgent({ task: 'signal-race', role: 'worker', context: {} })
      const controller = new AbortController()
      const pending = handle.result(controller.signal)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(vi.getTimerCount()).toBe(0)
      await handle.cancel()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a pending spawn when its AbortSignal fires and clears the timer', async () => {
    vi.useFakeTimers()
    try {
      const mock = new MockBackendTeamOrchestrationPort({ agents: [{ result: { ok: true }, spawnPendingMs: 1000 }] })
      const controller = new AbortController()
      const pending = mock.spawnAgent({ task: 'spawn-signal', role: 'worker', context: {} }, controller.signal)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('defensively clones event and request history', async () => {
    const mutableEvent = structuredClone(event)
    const mock = new MockBackendTeamOrchestrationPort({ approvals: [{ effect: 'approve', reason: 'ok' }] })
    await mock.emit(mutableEvent)
    await mock.requestApproval({ kind: 'requirements', summary: 'request', artifactHashes: {} })
    const snapshot = mock.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.events)).toBe(true)
    expect(() => (snapshot.events as BackendTeamEvent[]).push(event)).toThrow()
    mutableEvent.phase = 'BUILD'
    expect(mock.snapshot().events[0]).toEqual(event)
    expect(mock.snapshot().approvalRequests[0]?.summary).toBe('request')
  })

  it('rejects exotic agent context values and retains only lossless JSON', async () => {
    const mock = new MockBackendTeamOrchestrationPort({ agents: [{ result: 'ok' }, { result: 'ok' }] })
    await expect(mock.spawnAgent({ task: 'map', role: 'worker', context: new Map() as never })).rejects.toThrow(/JSON|context/i)
    await expect(mock.spawnAgent({ task: 'date', role: 'worker', context: new Date() as never })).rejects.toThrow(/JSON|context/i)
    const context = { nested: { enabled: true } }
    await mock.spawnAgent({ task: 'safe', role: 'worker', context })
    context.nested.enabled = false
    expect(mock.snapshot().spawnRequests).toHaveLength(1)
    expect(mock.snapshot().spawnRequests[0]?.context).toEqual({ nested: { enabled: true } })
  })
})
