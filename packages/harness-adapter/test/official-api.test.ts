import { describe, expect, it } from 'vitest'
import { DeepSeekHarnessAdapter, HarnessReadOnlyError } from '../src/index.js'
import type { HarnessStructuralContext } from '../src/index.js'

type ContentBlock = { type: 'text'; text: string }
type ToolExecution = { readonly token: symbol; readonly callId: string; readonly rootCallId: string; readonly name: string; readonly arguments: unknown; readonly signal: AbortSignal; readonly agent?: unknown; readonly parent?: symbol }
type ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: { readonly schema: Record<string, unknown>; render(args: unknown, value: unknown): ContentBlock[] }
  execute(args: unknown, execution: ToolExecution): Promise<unknown>
}
type OfficialTools = {
  register(definition: ToolDefinition): () => void
  guard(guard: (execution: Readonly<ToolExecution>) => string | undefined): () => void
}
type OfficialContext = { readonly tools: OfficialTools }

const tool = (): ToolDefinition => ({
  name: 'backend_team_status',
  description: 'Backend Team status',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'status' }] },
  async execute() { return { mode: 'read-only' } },
})

const context = (overrides: Partial<OfficialTools> = {}): { context: OfficialContext; registrations: ToolDefinition[]; guards: Array<(execution: Readonly<ToolExecution>) => string | undefined>; disposals: number[] } => {
  const registrations: ToolDefinition[] = []
  const guards: Array<(execution: Readonly<ToolExecution>) => string | undefined> = []
  const disposals: number[] = []
  const context: OfficialContext = {
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => { disposals.push(registrations.indexOf(definition)) }
      },
      guard(policy) {
        guards.push(policy)
        return () => { disposals.push(guards.indexOf(policy)) }
      },
      ...overrides,
    },
  }
  return { context, registrations, guards, disposals }
}

const asStructuralContext = (value: OfficialContext): HarnessStructuralContext => value as unknown as HarnessStructuralContext

describe('official DeepSeek Harness tools surface', () => {
  it('requires only the official tools service and ignores fictional services', async () => {
    const fixture = context()
    const adapter = await DeepSeekHarnessAdapter.create(asStructuralContext(fixture.context))
    expect(adapter.getCapabilityReport().missingCapabilities).toEqual([])
    expect(adapter.getCapabilityReport().mode).toBe('read-only')
    expect(() => adapter.registerDiagnosticTool(tool())).not.toThrow()
    expect(fixture.registrations.map((definition) => definition.name)).toEqual(['backend_team_status'])
  })

  it('validates the official ToolDefinition and preserves register receiver and disposer', async () => {
    let receiverIsContext = false
    const fixture = context({
      register(definition) {
        receiverIsContext = this === fixture.context.tools
        fixture.registrations.push(definition)
        return () => { fixture.disposals.push(7) }
      },
    })
    const adapter = await DeepSeekHarnessAdapter.create(asStructuralContext(fixture.context))
    const invalid = { name: 'invalid', description: 'missing output', execute: async () => null }
    expect(() => adapter.registerDiagnosticTool(invalid)).toThrow(/tool-contract/i)
    const registration = adapter.registerDiagnosticTool(tool())
    expect(receiverIsContext).toBe(true)
    expect(fixture.registrations).toHaveLength(1)
    registration()
    expect(fixture.disposals).toEqual([7])
  })

  it('keeps pending mode closed for ordinary tools and guards', async () => {
    const fixture = context()
    const adapter = await DeepSeekHarnessAdapter.create(asStructuralContext(fixture.context))
    expect(() => adapter.registerTool(tool())).toThrow(HarnessReadOnlyError)
    expect(() => adapter.registerMonotonicGuard(() => 'denied')).toThrow(HarnessReadOnlyError)
    expect(fixture.registrations).toHaveLength(0)
    expect(fixture.guards).toHaveLength(0)
  })

  it('does not expose legacy fictional Harness operations', async () => {
    const adapter = await DeepSeekHarnessAdapter.create(asStructuralContext(context().context))
    expect('registerPreExecuteGuard' in adapter).toBe(false)
    expect('requestApproval' in adapter).toBe(false)
    expect('spawnAgent' in adapter).toBe(false)
    expect('emit' in adapter).toBe(false)
  })

  it('fails closed for getter traps, non-function disposers, and hostile definitions', async () => {
    const getterTrap = context()
    Object.defineProperty(getterTrap.context.tools, 'register', { configurable: true, get() { throw new Error('register trap') } })
    const getterAdapter = await DeepSeekHarnessAdapter.create(asStructuralContext(getterTrap.context))
    expect(() => getterAdapter.registerDiagnosticTool(tool())).toThrow(/register-tool/i)

    const guardTrap = context()
    Object.defineProperty(guardTrap.context.tools, 'guard', { configurable: true, get() { throw new Error('guard trap') } })
    const guardAdapter = await DeepSeekHarnessAdapter.create(asStructuralContext(guardTrap.context))
    expect(guardAdapter.getCapabilityReport().missingCapabilities).toContain('monotonic-guard')

    const nonFunctionDisposer = context({ register() { return undefined as never } })
    const disposerAdapter = await DeepSeekHarnessAdapter.create(asStructuralContext(nonFunctionDisposer.context))
    expect(() => disposerAdapter.registerDiagnosticTool(tool())).toThrow(/disposer/i)

    const hostile = new Proxy(tool(), { get() { throw new Error('definition trap') } })
    expect(() => getterAdapter.registerDiagnosticTool(hostile)).toThrow(/tool-contract/i)
  })

  it('validates enforced output schemas and optional ToolDefinition fields before host registration', async () => {
    const fixture = context()
    const adapter = await DeepSeekHarnessAdapter.create(asStructuralContext(fixture.context))
    const invalidSchema = {
      ...tool(),
      output: { schema: { type: 'string', properties: {} }, render: () => [{ type: 'text', text: 'status' }] },
    }
    expect(() => adapter.registerDiagnosticTool(invalidSchema)).toThrow(/output-schema/i)
    const invalidOptionalFields = {
      ...tool(),
      output: { ...tool().output, presentationMeta: 'not-a-function' },
      timeoutMs: 0,
    }
    expect(() => adapter.registerDiagnosticTool(invalidOptionalFields)).toThrow(/presentationMeta|timeout/i)
    expect(fixture.registrations).toHaveLength(0)
  })
})
