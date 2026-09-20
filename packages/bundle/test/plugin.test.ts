import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.js'

type TextBlock = { readonly type: 'text'; readonly text: string }
type ToolExecution = {
  readonly token: symbol
  readonly callId: string
  readonly rootCallId: string
  readonly name: string
  readonly arguments: unknown
  readonly signal: AbortSignal
}
type ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: { readonly schema: Record<string, unknown>; render(args: unknown, value: unknown): TextBlock[] }
  execute(args: unknown, execution: ToolExecution): Promise<unknown>
}
type OfficialContext = {
  readonly tools: {
    register(definition: ToolDefinition): () => void
    guard(guard: (execution: Readonly<ToolExecution>) => string | undefined): () => void
  }
}

function makeContext() {
  const registrations: ToolDefinition[] = []
  const disposals: number[] = []
  const guards: Array<(execution: Readonly<ToolExecution>) => string | undefined> = []
  let receiverWasTools = false
  const tools = {
    register(definition: ToolDefinition) {
      receiverWasTools = this === tools
      registrations.push(definition)
      return () => {
        const index = registrations.indexOf(definition)
        if (index >= 0) registrations.splice(index, 1)
        disposals.push(index)
      }
    },
    guard(guard: (execution: Readonly<ToolExecution>) => string | undefined) {
      guards.push(guard)
      return () => {
        const index = guards.indexOf(guard)
        if (index >= 0) guards.splice(index, 1)
      }
    },
  }
  const context: OfficialContext = { tools }
  Object.defineProperty(context, 'runtime', { get() { throw new Error('fictional runtime getter must not be read') } })
  return { context, tools, registrations, disposals, guards, get receiverWasTools() { return receiverWasTools } }
}

async function applyOfficial(context: OfficialContext): Promise<void> {
  await apply(context as never)
}

function execution(signal = new AbortController().signal): ToolExecution {
  return { token: Symbol('call'), callId: 'call-1', rootCallId: 'root-1', name: 'backend_team_status', arguments: {}, signal }
}

describe('diagnostic Bundle plugin', () => {
  it('exports only the official plugin identity and inject list', () => {
    expect(name).toBe('@dsh-backend-team/bundle')
    expect(inject).toEqual(['tools', 'llm'])
  })

  it('registers one complete read-only diagnostic definition per context', async () => {
    const first = makeContext()
    const second = makeContext()
    await applyOfficial(first.context)
    await applyOfficial(second.context)
    expect(first.registrations).toHaveLength(1)
    expect(second.registrations).toHaveLength(1)
    expect(first.guards).toHaveLength(0)
    expect(first.registrations[0]?.name).toBe('backend_team_status')
    expect(first.registrations[0]?.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    expect(first.registrations[0]?.output.schema).toEqual({
      type: 'object',
      properties: {
        version: { type: 'string' },
        mode: { type: 'string', const: 'read-only' },
        reasons: { type: 'array', items: { type: 'string' } },
        missing: { type: 'array', items: { type: 'string' } },
        evidenceStatus: { type: 'string' },
      },
      required: ['version', 'mode', 'reasons', 'missing', 'evidenceStatus'],
      additionalProperties: false,
    })
  })

  it('does not use a permanent cache and preserves the tools receiver/disposer', async () => {
    const fixture = makeContext()
    await applyOfficial(fixture.context)
    await applyOfficial(fixture.context)
    expect(fixture.registrations).toHaveLength(2)
    expect(fixture.receiverWasTools).toBe(true)
    const definition = fixture.registrations[0]!
    const disposer = fixture.tools.register(definition)
    disposer()
    expect(fixture.disposals.length).toBeGreaterThan(0)
  })

  it('does not read fictional context getters', async () => {
    const fixture = makeContext()
    await applyOfficial(fixture.context)
    expect(fixture.registrations).toHaveLength(1)
  })

  it('returns a deterministic deep-frozen safe report and renders a text block', async () => {
    const fixture = makeContext()
    await applyOfficial(fixture.context)
    const definition = fixture.registrations[0]!
    const first = await definition.execute({}, execution())
    const second = await definition.execute({}, execution())
    expect(first).toEqual(second)
    expect(first).toMatchObject({ version: 'unknown', mode: 'read-only', reasons: expect.any(Array), missing: expect.any(Array), evidenceStatus: expect.any(String) })
    expect(Object.isFrozen(first)).toBe(true)
    expect(JSON.stringify(first)).not.toMatch(/secret|token|password|private|\/Volumes\//iu)
    expect(() => { (first as { mode: string }).mode = 'supported' }).toThrow()
    const firstText = definition.output.render({}, first)
    const secondText = definition.output.render({}, {
      version: 'different-version',
      mode: 'read-only',
      reasons: ['different reason'],
      missing: ['different capability'],
      evidenceStatus: 'pending-real-smoke',
    })
    expect(firstText).toEqual([{ type: 'text', text: expect.any(String) }])
    expect(secondText).toEqual([{ type: 'text', text: expect.any(String) }])
    expect(firstText[0]?.text).not.toBe(secondText[0]?.text)
  })

  it('renders missing capabilities and reasons so read-only status is actionable', async () => {
    const fixture = makeContext()
    await applyOfficial(fixture.context)
    const definition = fixture.registrations[0]!
    const rendered = definition.output.render({}, {
      version: 'unknown',
      mode: 'read-only',
      reasons: ['official host authentication is not verified'],
      missing: ['session-auth', 'coordinator-handlers'],
      evidenceStatus: 'pending-real-smoke',
    })

    expect(rendered[0]?.text).toContain('session-auth, coordinator-handlers')
    expect(rendered[0]?.text).toContain('official host authentication is not verified')
  })

  it.each([
    ['non-empty object', { secret: 'do-not-return' }],
    ['array', []],
    ['null', null],
  ])('rejects %s diagnostic arguments', async (_label, args) => {
    const fixture = makeContext()
    await applyOfficial(fixture.context)
    await expect(fixture.registrations[0]!.execute(args, execution())).rejects.toThrow(/argument|parameter|empty/i)
  })

  it('rejects an aborted official execution signal with AbortError', async () => {
    const fixture = makeContext()
    await applyOfficial(fixture.context)
    const controller = new AbortController()
    controller.abort()
    await expect(fixture.registrations[0]!.execute({}, execution(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails explicitly when the official tools service is missing', async () => {
    await expect(applyOfficial({ tools: undefined } as unknown as OfficialContext)).rejects.toThrow(/register-tool|tools/i)
  })

  it('registers no guards or non-diagnostic tools in production', async () => {
    const fixture = makeContext()
    await applyOfficial(fixture.context)
    expect(fixture.registrations.map((definition) => definition.name)).toEqual(['backend_team_status'])
    expect(fixture.guards).toEqual([])
  })
})
