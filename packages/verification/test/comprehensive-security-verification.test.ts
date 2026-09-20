import { describe, expect, it } from 'vitest'
import { ComprehensiveSecurityReview } from '../src/comprehensive-security-verification.js'

describe('comprehensive security review', () => {
  it('blocks when a required database or contract check is missing', async () => {
    const report = await new ComprehensiveSecurityReview().run({ files: [], checks: [{ id: 'db', kind: 'database', required: true, run: async () => ({ status: 'not-run', message: 'database is not configured' }) }] })
    expect(report.status).toBe('blocked')
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'REQUIRED_SECURITY_CHECK_NOT_RUN', checkId: 'db' }))
  })

  it('keeps optional checks visible without blocking a clean local review', async () => {
    const report = await new ComprehensiveSecurityReview().run({ files: [{ content: 'export const ok = true', owned: true }], checks: [{ id: 'openapi', kind: 'openapi', required: false, run: async () => ({ status: 'not-run', message: 'not applicable' }) }] })
    expect(report.status).toBe('passed')
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'OPTIONAL_SECURITY_CHECK_NOT_RUN', checkId: 'openapi' }))
  })
})
