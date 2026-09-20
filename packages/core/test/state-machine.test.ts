import type { BackendTeamPhase } from '@dsh-backend-team/contracts'
import { describe, expect, it } from 'vitest'
import { assertTransition } from '../src/index.js'

describe('assertTransition', () => {
  it.each<[BackendTeamPhase, BackendTeamPhase]>([
    ['DISCOVER', 'SPECIFY'],
    ['SPECIFY', 'AWAIT_REQUIREMENTS_APPROVAL'],
    ['AWAIT_REQUIREMENTS_APPROVAL', 'SPECIFY'],
    ['AWAIT_REQUIREMENTS_APPROVAL', 'DESIGN'],
    ['DESIGN', 'AWAIT_DESIGN_APPROVAL'],
    ['AWAIT_DESIGN_APPROVAL', 'DESIGN'],
    ['AWAIT_DESIGN_APPROVAL', 'PLAN'],
    ['PLAN', 'BUILD'],
    ['BUILD', 'VERIFY'],
    ['VERIFY', 'BUILD'],
    ['VERIFY', 'DELIVER'],
  ])('allows the explicit %s -> %s edge', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow()
  })

  it('forbids skipping both approval gates', () => {
    expect(() => assertTransition('SPECIFY', 'BUILD')).toThrow('illegal phase transition')
  })

  it('allows re-verification after stale delivery evidence, but not direct development', () => {
    expect(() => assertTransition('DELIVER', 'VERIFY')).not.toThrow()
    expect(() => assertTransition('DELIVER', 'BUILD')).toThrow('illegal phase transition')
  })
})
