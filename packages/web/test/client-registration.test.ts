import { describe, expect, it } from 'vitest'
import { apply, backendTeamConversationDefinition, inject } from '../src/client.js'

describe('DeepSeek Harness client entry', () => {
  it('registers one keyed conversation node and owns its slot disposer', () => {
    const registrations: unknown[] = []
    const context = {
      conversationEvents: {
        register: (definition: unknown) => {
          registrations.push(definition)
          return () => undefined
        },
      },
      slots: {
        inject: (name: string, factory: () => unknown) => {
          registrations.push(name, factory())
          return () => undefined
        },
        register: (definition: { name: string; key: string }) => {
          registrations.push(definition)
          return () => undefined
        },
      },
    }

    apply(context)

    expect(registrations[0]).toMatchObject({ kind: 'backend-team', target: 'chat' })
    expect(registrations).toContain('conversation.chat.node')
    expect(registrations).toContainEqual({ name: 'conversation.chat.node', key: 'backend-team' })
    expect(registrations).not.toContain('shell.overlay')
    expect(registrations).toContain('conversation.view')
    expect(registrations).toContainEqual({ name: 'conversation.view', id: 'backend-team-panel', order: 80, label: '团队进度' })
    expect(inject).toEqual(['slots', 'conversationEvents'])
  })

  it('uses the rc.6 ConversationNodeDefinition event and match contracts', () => {
    const startEvent = { seq: 7, time: 1, type: 'backend-team/start', data: { teamId: 'team-1', title: '订单 API' } }
    const updateEvent = { seq: 8, time: 2, type: 'backend-team/update', data: { teamId: 'team-1', phase: 'BUILD', status: 'completed' as const } }

    expect(backendTeamConversationDefinition.match(startEvent)).toEqual({ id: 'team-1', role: 'start' })
    expect(backendTeamConversationDefinition.match(updateEvent)).toEqual({ id: 'team-1', role: 'update' })
    expect(backendTeamConversationDefinition.match({ seq: 9, time: 3, type: 'backend-team/other', data: { teamId: 'team-1' } })).toBeNull()

    const location = { kind: 'session' as const }
    const startMatch = { event: startEvent, view: undefined, role: 'start' as const, location }
    const state = backendTeamConversationDefinition.start({ key: 'backend-team:team-1', kind: 'backend-team', id: 'team-1', start: startMatch, matches: [startMatch], state: undefined, current: new Map() }, startMatch, { previous: () => undefined })
    const updated = backendTeamConversationDefinition.update({ key: 'backend-team:team-1', kind: 'backend-team', id: 'team-1', start: startMatch, matches: [startMatch], state, current: new Map() }, { event: updateEvent, view: undefined, role: 'update', location })
    expect(updated).toMatchObject({ phase: 'BUILD', status: 'completed' })
    const node = backendTeamConversationDefinition.buildViewNode!({ key: 'backend-team:team-1', kind: 'backend-team', id: 'team-1', start: startMatch, matches: [startMatch], state: updated, current: new Map() })

    expect(node).toMatchObject({ anchorSeq: 7, location, data: { title: '订单 API', phase: 'BUILD', status: 'completed' } })
  })

  it('returns an idempotent disposer for the conversation and slot registrations', () => {
    const disposed: string[] = []
    const context = {
      conversationEvents: { register: () => () => { disposed.push('conversation') } },
      slots: {
        inject: (_name: string, factory: () => unknown) => { factory(); return () => { disposed.push('inject') } },
        register: () => { disposed.push('register'); return () => { disposed.push('slot') } },
      },
    }

    const dispose = apply(context)
    expect(typeof dispose).toBe('function')
    dispose()
    dispose()
    expect(disposed).toEqual(['register', 'register', 'slot', 'inject', 'slot', 'inject', 'conversation'])
  })

  it('does not register duplicate slots when the host invokes the factory more than once', () => {
    let factory: (() => unknown) | undefined
    let registerCalls = 0
    const context = {
      conversationEvents: { register: () => () => undefined },
      slots: {
        inject: (_name: string, candidate: () => unknown) => { factory = candidate; return () => undefined },
        register: () => { registerCalls += 1; return () => undefined },
      },
    }

    const dispose = apply(context)
    factory?.()
    factory?.()
    expect(registerCalls).toBe(1)
    dispose()
  })
})
