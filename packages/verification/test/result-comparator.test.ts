import { describe, expect, it } from 'vitest'
import { compareResults } from '../src/result-comparator.js'
import type { CommandCapture } from '../src/verification-command.js'

const capture = (id: string, status: CommandCapture['status'], stdoutSha256: string): CommandCapture => ({
  id, argv: ['npm', 'test'], cwd: '/workspace', purpose: 'unit', evidenceIds: [id], startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', durationMs: 1, exitCode: status === 'passed' ? 0 : 1, status, stdoutSha256, stderrSha256: 'b'.repeat(64), stdoutExcerpt: '', stderrExcerpt: '',
})

describe('compareResults', () => {
  it('does not count an unchanged historical failure as newly introduced', () => {
    const baseline = [capture('unit', 'failed', 'a'.repeat(64))]
    const final = [capture('unit', 'failed', 'a'.repeat(64))]
    const result = compareResults(baseline, final)
    expect(result.newFailures).toEqual([])
    expect(result.baselineFailures).toHaveLength(1)
    expect(result.unchangedFailures).toHaveLength(1)
  })

  it('classifies changed and resolved failures', () => {
    const baseline = [capture('unit', 'failed', 'a'.repeat(64)), capture('lint', 'failed', 'b'.repeat(64))]
    const final = [capture('unit', 'failed', 'c'.repeat(64)), capture('lint', 'passed', 'd'.repeat(64))]
    const result = compareResults(baseline, final)
    expect(result.newFailures.map((item) => item.id)).toEqual(['unit'])
    expect(result.resolvedFailures.map((item) => item.id)).toEqual(['unit', 'lint'])
  })
})
