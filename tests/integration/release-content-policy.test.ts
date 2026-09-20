import { describe, expect, it } from 'vitest'
import { containsSensitiveOrUnresolvedContent } from '../../scripts/release-content-policy.mjs'

describe('release content security scanner', () => {
  it('allows types and dynamic authenticated handoff without allowing hardcoded secrets', () => {
    expect(containsSensitiveOrUnresolvedContent('interface Login { password: string }', 'x.d.ts')).toBe(false)
    expect(containsSensitiveOrUnresolvedContent('const value = { password: login.password }', 'x.js')).toBe(false)
    expect(containsSensitiveOrUnresolvedContent('const password = "actual-private-value"', 'x.js')).toBe(true)
    expect(containsSensitiveOrUnresolvedContent('const value = { "password": "actual-private-value" }', 'x.js')).toBe(true)
    expect(containsSensitiveOrUnresolvedContent('{"api_key":"actual-private-value"}', 'x.json')).toBe(true)
    expect(containsSensitiveOrUnresolvedContent('interface Login { password: "actual-private-value" }', 'x.d.ts')).toBe(true)
    expect(containsSensitiveOrUnresolvedContent('account.secret = "actual-private-value"', 'x.js')).toBe(true)
  })
  it('continues rejecting private keys, sourcemaps and unresolved private packages', () => {
    for (const content of ['-----BEGIN PRIVATE KEY-----', '//# sourceMappingURL=x.map', 'import type { X } from "@dsh-backend-team/core"']) expect(containsSensitiveOrUnresolvedContent(content, 'x.js')).toBe(true)
    expect(containsSensitiveOrUnresolvedContent('import type { X } from "@dsh-backend-team/core"', 'x.d.ts')).toBe(false)
  })
})
