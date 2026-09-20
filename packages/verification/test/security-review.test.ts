import { describe, expect, it } from 'vitest'
import { SecurityReview } from '../src/security-review.js'

describe('SecurityReview', () => {
  it('requires negative authorization evidence for protected operations', async () => {
    const report = await new SecurityReview().run({
      files: [],
      protectedOperations: [{ operationId: 'GET /orders', requiresAuth: true, requiresRole: true, requiresTenantIsolation: true }],
      authorizationEvidence: [{ operationId: 'GET /orders', unauthenticatedDenied: false, wrongRoleDenied: false, crossTenantDenied: false, allowedRoleSucceeded: true }],
    })
    expect(report.status).toBe('blocked')
    expect(report.findings.map((finding) => finding.code)).toContain('MISSING_DENY_AUTH_TEST')
  })

  it('passes with complete authorization evidence and clean files', async () => {
    const report = await new SecurityReview().run({
      files: [{ path: 'orders.ts', content: 'export const health = true' }],
      protectedOperations: [{ operationId: 'GET /orders', requiresAuth: true }],
      authorizationEvidence: [{ operationId: 'GET /orders', unauthenticatedDenied: true, allowedRoleSucceeded: true }],
    })
    expect(report.status).toBe('passed')
  })

  it('blocks high-confidence injection and sensitive logging sinks', async () => {
    const report = await new SecurityReview().run({ files: [{ path: 'unsafe.ts', content: 'db.query(`select * from orders where id=${req.query.id}`); console.log(password)' }] })
    expect(report.status).toBe('blocked')
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['SQL_INJECTION_SINK', 'SENSITIVE_LOGGING']))
  })
})
