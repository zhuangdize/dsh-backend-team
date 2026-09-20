import { describe, expect, it } from 'vitest'
import type { AgentRole } from '@dsh-backend-team/contracts'
import { RolePolicy } from '../src/role-policy.js'

describe('RolePolicy', () => {
  it.each([
    ['requirements', false, false],
    ['project-analyzer', false, false],
    ['backend-architect', false, true],
    ['database-designer', false, true],
    ['planner', false, false],
    ['developer', true, true],
    ['tester', false, true],
    ['security-reviewer', false, false],
    ['fixer', true, true],
  ] as const)('%s businessWrite=%s canDelegate=%s', (role, businessCodeWrite, canDelegate) => {
    const capabilities = new RolePolicy({ designApproved: true }).maxCapabilities(role as AgentRole, 'BUILD')

    expect(capabilities.businessCodeWrite).toBe(businessCodeWrite)
    expect(capabilities.canDelegate).toBe(canDelegate)
    expect(capabilities.canChangePhase).toBe(false)
    expect(capabilities.canApprove).toBe(false)
    expect(capabilities.canContactUser).toBe(false)
    expect(capabilities.canAnnounceCompletion).toBe(false)
  })

  it('withholds developer and fixer writes before design approval or outside BUILD/VERIFY', () => {
    const pending = new RolePolicy({ designApproved: false }).maxCapabilities('developer', 'BUILD')
    const wrongPhase = new RolePolicy({ designApproved: true }).maxCapabilities('fixer', 'PLAN')

    expect(pending.writeOwnedFiles).toBe(false)
    expect(pending.businessCodeWrite).toBe(false)
    expect(wrongPhase.writeOwnedFiles).toBe(false)
    expect(wrongPhase.businessCodeWrite).toBe(false)
  })

  it('limits testers to test writes and verification artifacts', () => {
    const policy = new RolePolicy({ designApproved: true })
    const capabilities = policy.maxCapabilities('tester', 'VERIFY')

    expect(capabilities.businessCodeWrite).toBe(false)
    expect(capabilities.testCodeWrite).toBe(true)
    expect(policy.writePathPatterns('tester', 'VERIFY')).toEqual([
      '**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '.backend-team/runs/**/verification/**',
    ])
  })

  it('denies capabilities for non-expert roles', () => {
    const capabilities = new RolePolicy({ designApproved: true }).maxCapabilities('coordinator', 'BUILD')

    expect(capabilities.readProjectFiles).toBe(false)
    expect(capabilities.writeOwnedFiles).toBe(false)
    expect(capabilities.canDelegate).toBe(false)
  })
})
