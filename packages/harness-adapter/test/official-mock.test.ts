import { describe, expect, it } from 'vitest'
import { DuplicateHarnessToolError, MockHarnessAdapter } from '../src/index.js'
import type { HarnessToolDefinition, HarnessToolExecution } from '../src/index.js'

const tool = (name = 'backend_team_status'): HarnessToolDefinition => ({
  name,
  description: 'status',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'status' }] },
  async execute() { return { mode: 'read-only' } },
})

const schemaTool = (schema: Record<string, unknown>, name = 'schema-tool'): HarnessToolDefinition => ({
  ...tool(name),
  output: { schema, render: () => [{ type: 'text', text: 'ok' }] },
})

const execution = (): HarnessToolExecution => ({
  token: Symbol('mock-token'), callId: 'call-1', rootCallId: 'root-1', name: 'backend_team_status', arguments: { action: { kind: 'allow' } }, signal: new AbortController().signal,
})

describe('official tools mock', () => {
  it('registers official definitions, rejects duplicates, and disposes by lifecycle', () => {
    const mock = new MockHarnessAdapter()
    const dispose = mock.registerDiagnosticTool(tool())
    expect(mock.snapshot()).toMatchObject({ tools: ['backend_team_status'], guards: 0 })
    expect(() => mock.registerDiagnosticTool(tool())).toThrow(DuplicateHarnessToolError)
    dispose()
    expect(mock.snapshot()).toMatchObject({ tools: [], guards: 0 })
  })

  it('records monotonic guards, preserves execution identity, and disposes them', () => {
    const mock = new MockHarnessAdapter()
    let received: HarnessToolExecution | undefined
    const dispose = mock.guard((value: Readonly<HarnessToolExecution>) => { received = value; return value.name === 'backend_team_status' ? undefined : 'denied' })
    expect(mock.snapshot()).toMatchObject({ tools: [], guards: 1 })
    expect(mock.runGuards(execution())).toBeUndefined()
    expect(received).toBeDefined()
    expect(received?.callId).toBe('call-1')
    dispose()
    dispose()
    expect(mock.snapshot()).toMatchObject({ tools: [], guards: 0 })
  })

  it('rejects allow-shaped guard output and keeps snapshots defensive', () => {
    const mock = new MockHarnessAdapter()
    mock.registerMonotonicGuard(() => ({ effect: 'allow' } as unknown as string))
    expect(() => mock.runGuards(execution())).toThrow(/monotonic-guard-result/i)
    const snapshot = mock.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(() => (snapshot.tools as string[]).push('forged')).toThrow()
  })

  it('keeps guard order monotonic and rejects hostile official definitions', () => {
    const mock = new MockHarnessAdapter()
    mock.registerMonotonicGuard(() => undefined)
    mock.registerMonotonicGuard(() => 'denied by second guard')
    expect(mock.runGuards(execution())).toBe('denied by second guard')
    const hostile = new Proxy(tool(), { get() { throw new Error('definition trap') } })
    expect(() => mock.registerDiagnosticTool(hostile)).toThrow(/diagnostic-tool-contract/i)
  })

  it('treats an empty string as a valid monotonic denial reason', () => {
    const mock = new MockHarnessAdapter()
    mock.guard(() => '')
    expect(mock.runGuards(execution())).toBe('')
  })

  it('supports the exact official register contract with a disposer', () => {
    const mock = new MockHarnessAdapter()
    const dispose = mock.register({ ...tool('ordinary'), name: 'ordinary' })
    expect(mock.snapshot().tools).toEqual(['ordinary'])
    dispose()
    expect(mock.snapshot().tools).toEqual([])
  })

  it('rejects the reserved run_code registration name', () => {
    expect(() => new MockHarnessAdapter().register(schemaTool({}, 'run_code'))).toThrow(/reserved|run_code/i)
  })

  it('accepts the rc.6 enforced output schema subset', () => {
    const mock = new MockHarnessAdapter()
    const dispose = mock.register(schemaTool({
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['backend'], const: 'backend', description: 'tool name' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
      additionalProperties: false,
      title: 'Output',
      default: {},
      examples: [{ name: 'backend' }],
    }))
    expect(mock.snapshot().tools).toEqual(['schema-tool'])
    dispose()
  })

  it.each([
    ['unknown keyword', { type: 'string', minimum: 1 }],
    ['invalid type', { type: 'date' }],
    ['properties on scalar', { type: 'string', properties: {} }],
    ['required without object properties', { type: 'object', required: ['missing'] }],
    ['items on scalar', { type: 'string', items: { type: 'string' } }],
    ['additionalProperties on scalar', { type: 'string', additionalProperties: false }],
    ['oneOf with one branch', { oneOf: [{ type: 'string' }] }],
    ['oneOf with a non-schema branch', { oneOf: [{ type: 'string' }, 1] }],
    ['enum with object value', { type: 'object', enum: [{}] }],
    ['enum with non-finite value', { type: 'number', enum: [Number.NaN] }],
    ['const with array value', { type: 'array', const: [] }],
    ['non-lossless annotation', { type: 'string', default: new Date('2026-01-01T00:00:00.000Z') }],
    ['undefined annotation', { type: 'string', examples: undefined }],
  ])('rejects invalid rc.6 output schema: %s', (_label, schema) => {
    expect(() => new MockHarnessAdapter().register(schemaTool(schema))).toThrow(/output-schema|schema/i)
  })

  it('accepts optional presentationMeta only when it is a function and timeoutMs is positive finite', () => {
    const mock = new MockHarnessAdapter()
    const definition = {
      ...schemaTool({}, 'metadata-tool'),
      output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }], presentationMeta: () => ({}) },
      timeoutMs: 10,
    }
    const dispose = mock.register(definition)
    dispose()
    expect(() => mock.register({ ...definition, name: 'bad-meta', output: { ...definition.output, presentationMeta: 'nope' } })).toThrow(/output|presentationMeta/i)
    expect(() => mock.register({ ...definition, name: 'bad-timeout', timeoutMs: 0 })).toThrow(/timeout/i)
    expect(() => mock.register({ ...definition, name: 'bad-infinity', timeoutMs: Infinity })).toThrow(/timeout/i)
  })
})
