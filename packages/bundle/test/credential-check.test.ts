import { expect, it } from 'vitest'
import { checkCredentials } from '../src/credential-check.js'

it('reports credential kinds and locations without returning matching content', () => {
  const credentials = ['AKIA' + 'Q'.repeat(16), 'postgres://user:synthetic-password@localhost/db', '-----BEGIN PRIVATE KEY-----\nsynthetic-key\n-----END PRIVATE KEY-----']
  const result = checkCredentials(credentials.map((content, index) => ({ path: `src/file-${index}.ts`, content })))
  expect(result.status).toBe('blocked')
  expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining(['SECRET_CREDENTIAL', 'PRIVATE_KEY']))
  for (const value of credentials) expect(JSON.stringify(result)).not.toContain(value)
  expect(result.findings.every(item => item.path && item.line)).toBe(true)
})
it('accepts environment references and bounds the report without losing blocked status', () => {
  expect(checkCredentials([{ path: 'src/config.ts', content: 'const apiKey = process.env.MODEL_API_KEY;' }]).status).toBe('passed')
  const result = checkCredentials([{ path: 'src/config.ts', content: Array.from({ length: 105 }, () => 'const secret = "synthetic-test-value";').join('\n') }])
  expect(result.status).toBe('blocked')
  expect(result.findings).toHaveLength(100)
  expect(result.omittedFindings).toBe(5)
})
