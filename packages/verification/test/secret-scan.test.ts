import { describe, expect, it } from 'vitest'
import { SecurityReview } from '../src/security-review.js'
import { scanSecrets } from '../src/secret-scan.js'

describe('security scanning', () => {
  it.each([
    'postgres://user:password@prod.example.com/app',
    'AKIA' + 'IOSFODNN7EXAMPLE',
    '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
  ])('blocks likely real secret or production target: %s', async (value) => {
    expect((await new SecurityReview().scanText(value)).some((finding) => finding.severity === 'block')).toBe(true)
  })

  it('does not expose secret values in findings', () => {
    const findings = scanSecrets('password="super-secret-value"', 'config.ts')
    expect(findings[0]?.redactedExcerpt).not.toContain('super-secret-value')
    expect(findings[0]?.path).toBe('config.ts')
  })
})
