import { describe, expect, it } from 'vitest'
import { CoordinatorControlAdapter, type CoordinatorCommandHandlers } from '../src/index.js'
import type { BackendTeamControlAction } from '../src/index.js'

const hash = 'a'.repeat(64)
const actions: readonly BackendTeamControlAction[] = [
  { type: 'submit-clarification', workspaceId: 'ws', expectedRevision: 4, text: 'clarify' },
  { type: 'decide-approval', workspaceId: 'ws', expectedRevision: 4, approvalId: 'approval-1', decision: 'approve', artifactHash: hash },
  { type: 'pause-run', workspaceId: 'ws', expectedRevision: 4 },
  { type: 'resume-run', workspaceId: 'ws', expectedRevision: 4 },
  { type: 'retry-failed-step', workspaceId: 'ws', expectedRevision: 4, stepId: 'step-1' },
  { type: 'open-artifact', workspaceId: 'ws', expectedRevision: 4, artifactId: 'artifact-1' },
  { type: 'start-database', workspaceId: 'ws', expectedRevision: 4 },
  { type: 'stop-database', workspaceId: 'ws', expectedRevision: 4 },
  { type: 'open-database-gui', workspaceId: 'ws', expectedRevision: 4 },
]

function handlersFor(calls: string[]): CoordinatorCommandHandlers {
  return Object.fromEntries(actions.map((action) => [action.type, async () => { calls.push(action.type); return { accepted: true as const, stateRevision: 5 } }])) as unknown as CoordinatorCommandHandlers
}

describe('CoordinatorControlAdapter', () => {
  it('rejects an incomplete handler table before any command can reach it', () => {
    expect(() => new CoordinatorControlAdapter({} as never)).toThrow(/handler.*submit-clarification|submit-clarification.*handler/i)
  })

  it('does not retain a mutable handler table supplied by the host', async () => {
    const calls: string[] = []
    const handlers = handlersFor(calls)
    const adapter = new CoordinatorControlAdapter(handlers)
    ;(handlers as Record<string, unknown>)['pause-run'] = undefined
    await expect(adapter.dispatch(actions[2]!, { workspaceId: 'ws', expectedRevision: 4, authenticatedSessionId: 'session-1234567890' })).resolves.toMatchObject({ accepted: true, stateRevision: 5 })
    expect(calls).toEqual(['pause-run'])
  })

  it('routes every allowed action to its matching coordinator handler', async () => {
    const calls: string[] = []
    const adapter = new CoordinatorControlAdapter(handlersFor(calls))
    for (const action of actions) await expect(adapter.dispatch(action, { workspaceId: 'ws', expectedRevision: 4, authenticatedSessionId: 'session-1234567890' })).resolves.toMatchObject({ accepted: true, stateRevision: 5 })
    expect(calls).toEqual(actions.map((action) => action.type))
  })

  it('rejects a command whose routing context does not match the action', async () => {
    const calls: string[] = []
    const adapter = new CoordinatorControlAdapter(handlersFor(calls))
    await expect(adapter.dispatch(actions[0]!, { workspaceId: 'other', expectedRevision: 4, authenticatedSessionId: 'session-1234567890' })).rejects.toThrow(/workspace mismatch/i)
    await expect(adapter.dispatch(actions[0]!, { workspaceId: 'ws', expectedRevision: 3, authenticatedSessionId: 'session-1234567890' })).rejects.toThrow(/revision mismatch/i)
    expect(calls).toEqual([])
  })

  it('rejects malformed actions before invoking a handler', async () => {
    const adapter = new CoordinatorControlAdapter(handlersFor([]))
    const malformed = { type: 'force-approve', workspaceId: 'ws', expectedRevision: 4 }
    await expect(adapter.dispatch(malformed as never, { workspaceId: 'ws', expectedRevision: 4, authenticatedSessionId: 'session-1234567890' })).rejects.toThrow()
  })
})
