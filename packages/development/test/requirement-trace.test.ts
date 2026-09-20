import { describe, expect, it } from 'vitest'
import { buildRequirementTrace } from '../src/index.js'

describe('requirement trace', () => {
  it('maps requirements to slices and evidence', () => {
    const trace = buildRequirementTrace([
      { id: 'T-1', sliceId: 'S-1', requirementIds: ['AC-001'], evidence: ['test:one'] },
      { id: 'T-2', sliceId: 'S-2', requirementIds: ['AC-001', 'AC-002'], evidence: ['test:two'] },
    ], ['AC-001', 'AC-002'])
    expect(trace.requirements['AC-001']?.sliceIds).toEqual(['S-1', 'S-2'])
    expect(trace.requirements['AC-002']?.evidenceIds).toEqual(['test:two'])
  })
})
