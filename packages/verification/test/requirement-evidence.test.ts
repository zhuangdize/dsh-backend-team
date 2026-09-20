import { describe, expect, it } from 'vitest'
import { VerificationEngine } from '../src/verification-engine.js'

const trace = { requirements: { 'AC-004': { sliceIds: ['S-004'], taskIds: ['T-004'], evidenceIds: ['integration'] } } }
const command = { id: 'integration', argv: ['npm', 'run', 'integration'], cwd: '/workspace', purpose: 'integration' as const, evidenceIds: ['integration'], sliceId: 'S-004' }

describe('requirement evidence', () => {
  it('does not infer evidence identity from a broad command purpose', async () => {
    const engine = new VerificationEngine({ runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }) } })
    const report = await engine.verifyAll([{ ...command, id: 'reviewed-check', evidenceIds: ['reviewed-check'] }], trace)
    expect(report.requirements['AC-004']?.status).toBe('not-run')
    expect(report.requirements['AC-004']?.missingEvidenceIds).toEqual(['integration'])
  })
  it('requires every evidence item, not just one matching successful command', async () => {
    const engine = new VerificationEngine({ runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }) } })
    const required = { requirements: { 'AC-004': { ...trace.requirements['AC-004'], evidenceIds: ['integration', 'startup'] } } }
    const partial = await engine.verifyAll([command], required)
    expect(partial.requirements['AC-004']?.status).toBe('not-run')
    expect(partial.requirements['AC-004']?.missingEvidenceIds).toEqual(['startup'])
    expect(partial.status).not.toBe('passed')
    const complete = await engine.verifyAll([command, { ...command, id: 'startup', evidenceIds: ['startup'] }], required)
    expect(complete.requirements['AC-004']?.status).toBe('passed')
    expect(complete.requirements['AC-004']?.missingEvidenceIds).toEqual([])
  })
  it('records blocked instead of pass when a command cannot run', async () => {
    const engine = new VerificationEngine({ runner: { run: async () => { throw new Error('database tool unavailable') } } })
    const report = await engine.verifyAll([command], trace)
    expect(report.requirements['AC-004']?.status).toBe('blocked')
    expect(report.status).toBe('blocked')
  })

  it('requires a baseline failure to remain historical rather than new', async () => {
    let exitCode = 1
    const engine = new VerificationEngine({ runner: { run: async () => ({ exitCode, stdout: 'same failure', stderr: 'failed', durationMs: 1 }) } })
    await engine.captureBaseline([{ ...command, purpose: 'unit', id: 'unit', evidenceIds: ['unit'] }])
    const report = await engine.verifyAll([{ ...command, purpose: 'unit', id: 'unit', evidenceIds: ['unit'] }], { requirements: { 'AC-001': { sliceIds: ['S-001'], taskIds: ['T-001'], evidenceIds: ['unit'] } } })
    expect(report.newFailures).toEqual([])
    expect(report.requirements['AC-001']?.baseline).toBe('historical-failure')
    exitCode = 0
    const passed = await engine.verifyAll([{ ...command, purpose: 'unit', id: 'unit', evidenceIds: ['unit'] }], { requirements: { 'AC-001': { sliceIds: ['S-001'], taskIds: ['T-001'], evidenceIds: ['unit'] } } })
    expect(passed.requirements['AC-001']?.status).toBe('passed')
  })
})
