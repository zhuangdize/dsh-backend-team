import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DeepSeekHarnessAdapter,
  HarnessReadOnlyError,
  assessHarnessCompatibility,
  inspectStructuralContext,
} from '../src/index.js'
import { parseCompatibilityMatrix } from '../src/compatibility.js'
import { trustedCompatibilityDocumentUrl } from '../src/compatibility-locator.js'
import type { HarnessStructuralContext, HarnessToolDefinition, HarnessToolRegistrationDefinition } from '../src/index.js'

const definition = (name = 'backend_team_status'): HarnessToolDefinition => ({
  name,
  description: 'diagnostic status',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'status' }] },
  async execute() { return { mode: 'read-only' } },
})

const makeContext = (): HarnessStructuralContext & { registrations: HarnessToolRegistrationDefinition[]; guards: Array<(...args: never[]) => unknown> } => {
  const registrations: HarnessToolRegistrationDefinition[] = []
  const guards: Array<(...args: never[]) => unknown> = []
  return {
    tools: {
      register(tool) { registrations.push(tool); return () => {} },
      guard(policy) { guards.push(policy); return () => {} },
    },
    registrations,
    guards,
  }
}

describe('harness compatibility', () => {
  it('parses the checked-in compatibility document with only official capabilities', async () => {
    const path = fileURLToPath(new URL('../../../docs/compatibility/deepseek-harness.json', import.meta.url))
    const parsed = parseCompatibilityMatrix(JSON.parse(await readFile(path, 'utf8')) as unknown)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]?.version).toBe('0.1.0-rc.6')
    expect(parsed.entries[0]?.status).toBe('verified')
    expect(parsed.entries[0]?.expectedCapabilities).toEqual(['register-tool', 'monotonic-guard'])
  })

  it.each([
    ['0.1.0-rc.6', 'read-only'],
    ['0.1.0-rc.5', 'read-only'],
    ['0.2.0', 'read-only'],
    ['not-semver', 'read-only'],
  ])('fails closed for %s', (version, expected) => {
    void version
    expect(assessHarnessCompatibility(makeContext()).mode).toBe(expected)
  })

  it('parses an exact verified entry without exposing a production promotion seam', () => {
    const verified = parseCompatibilityMatrix({
      schemaVersion: 1,
      entries: [{
        version: '0.1.0-rc.6', status: 'verified', expectedCapabilities: ['register-tool', 'monotonic-guard'], nodeRange: '>=24 <25',
        verificationPlan: { commands: ['install', 'boot', 'invoke-tool'] }, verifiedAt: '2026-08-26T00:00:00.000Z', evidence: { commands: ['install', 'boot', 'invoke-tool'], sha256: 'a'.repeat(64) },
      }],
    })
    expect(verified.entries[0]?.status).toBe('verified')
  })

  it('only uses the repository fallback for the direct source compatibility module', () => {
    expect(trustedCompatibilityDocumentUrl('file:///repo/packages/harness-adapter/src/compatibility-locator.ts').pathname).toBe('/repo/docs/compatibility/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/packages/harness-adapter/src/compatibility-locator.js').pathname).toBe('/repo/docs/compatibility/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/packages/harness-adapter/src/compatibility.ts').pathname).toBe('/repo/packages/harness-adapter/src/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/packages/harness-adapter/src/compatibility.js').pathname).toBe('/repo/packages/harness-adapter/src/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/packages/harness-adapter/src/nested/compatibility-locator.ts').pathname).toBe('/repo/packages/harness-adapter/src/nested/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/lib/packages/harness-adapter/src/compatibility-locator.ts').pathname).toBe('/repo/lib/docs/compatibility/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/dist/packages/harness-adapter/src/compatibility-locator.ts').pathname).toBe('/repo/dist/docs/compatibility/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/bundle/packages/harness-adapter/src/compatibility-locator.ts').pathname).toBe('/repo/bundle/docs/compatibility/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/packages/other/src/compatibility-locator.ts').pathname).toBe('/repo/packages/other/src/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/packages/harness-adapter/dist/src/compatibility.js').pathname).toBe('/repo/packages/harness-adapter/dist/src/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/packages/bundle/src/compatibility.js').pathname).toBe('/repo/packages/bundle/src/deepseek-harness.json')
    expect(trustedCompatibilityDocumentUrl('file:///repo/packages/harness-adapter/lib/compatibility.js').pathname).toBe('/repo/packages/harness-adapter/lib/deepseek-harness.json')
  })

  it('rejects duplicate versions, unknown fields, and incomplete evidence', () => {
    const base = {
      schemaVersion: 1,
      entries: [{
        version: '0.1.0-rc.6', status: 'pending-real-smoke',
        expectedCapabilities: ['register-tool', 'monotonic-guard'], nodeRange: '>=24 <25',
        verificationPlan: { commands: ['boot'] },
      }],
    }
    expect(() => parseCompatibilityMatrix({ ...base, unexpected: true })).toThrow()
    expect(() => parseCompatibilityMatrix({ ...base, entries: [base.entries[0], base.entries[0]] })).toThrow()
    expect(() => parseCompatibilityMatrix({ ...base, entries: [{ ...base.entries[0], evidence: { commands: ['boot'], sha256: 'a'.repeat(64) } }] })).toThrow()
    expect(() => parseCompatibilityMatrix({
      schemaVersion: 1,
      entries: [{ ...base.entries[0], status: 'verified', verifiedAt: '2026-08-26T00:00:00.000Z', evidence: { commands: ['not-plan'], sha256: 'a'.repeat(64) } }],
    })).toThrow(/evidence commands/i)
    expect(() => parseCompatibilityMatrix({ schemaVersion: 1, entries: [] })).toThrow()
  })

  it.each([
    ['status', { status: 'unknown' }],
    ['node range', { nodeRange: '>=24 <26' }],
    ['capabilities', { expectedCapabilities: ['register-tool'] }],
    ['evidence', { status: 'verified', verifiedAt: '2026-08-26T00:00:00.000Z', evidence: { commands: ['boot'], sha256: 'not-sha256' } }],
  ])('strictly rejects invalid %s in the compatibility matrix', (_label, override) => {
    const entry = {
      version: '0.1.0-rc.6', status: 'pending-real-smoke' as const,
      expectedCapabilities: ['register-tool', 'monotonic-guard'] as const, nodeRange: '>=24 <25',
      verificationPlan: { commands: ['boot'] },
    }
    expect(() => parseCompatibilityMatrix({ schemaVersion: 1, entries: [{ ...entry, ...override }] })).toThrow()
  })

  it('reports only official structural capabilities and ignores private fields', () => {
    const context = makeContext() as HarnessStructuralContext & { privateState?: object }
    context.privateState = { secret: true }
    const report = inspectStructuralContext(context)
    expect(report.availableCapabilities).toEqual(['register-tool', 'monotonic-guard'])
    expect(report.missingCapabilities).toEqual([])
    expect(assessHarnessCompatibility(context).mode).toBe('read-only')
  })

  it('fails closed for missing or throwing official tools methods', async () => {
    const missing = makeContext()
    ;(missing.tools as unknown as { guard: undefined }).guard = undefined
    expect(inspectStructuralContext(missing).missingCapabilities).toContain('monotonic-guard')
    const missingAdapter = await DeepSeekHarnessAdapter.create(missing)
    expect(() => missingAdapter.registerDiagnosticTool(definition())).not.toThrow()

    const throwing = makeContext()
    Object.defineProperty(throwing, 'tools', { get() { throw new Error('trap') } })
    const report = inspectStructuralContext(throwing)
    expect(report.missingCapabilities).toEqual(['register-tool', 'monotonic-guard'])
    expect((await DeepSeekHarnessAdapter.create(throwing)).getCapabilityReport().mode).toBe('read-only')
  })

  it('never reads fictional runtime or service properties', async () => {
    const context = makeContext() as HarnessStructuralContext & { runtime?: unknown; guards?: unknown; approvals?: unknown; agents?: unknown; events?: unknown }
    Object.defineProperties(context, {
      runtime: { get() { throw new Error('runtime must not be read') } },
      guards: { get() { throw new Error('guards must not be read') } },
      approvals: { get() { throw new Error('approvals must not be read') } },
      agents: { get() { throw new Error('agents must not be read') } },
      events: { get() { throw new Error('events must not be read') } },
    })
    const adapter = await DeepSeekHarnessAdapter.create(context)
    await expect(adapter.getRuntimeVersion()).resolves.toBe('unknown')
    expect(() => adapter.registerDiagnosticTool(definition())).not.toThrow()
  })

  it('cannot bypass construction or turn pending mode into writable mode', async () => {
    const Constructor = DeepSeekHarnessAdapter as unknown as new (...args: unknown[]) => unknown
    expect(() => new Constructor(makeContext())).toThrow(/create/i)
    const adapter = await DeepSeekHarnessAdapter.create(makeContext())
    expect(() => adapter.registerTool({ ...definition(), name: 'ordinary' })).toThrow(HarnessReadOnlyError)
    expect(() => adapter.registerMonotonicGuard(() => 'deny')).toThrow(HarnessReadOnlyError)
  })
})
