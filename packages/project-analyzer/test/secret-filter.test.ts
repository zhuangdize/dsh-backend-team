import { describe, expect, it } from 'vitest'
import { SecretFilter } from '../src/index.js'

describe('SecretFilter', () => {
  it('recognizes secret-bearing paths without relying on their contents', () => {
    for (const path of ['.env', '.env.local', '.envrc', '.env.development', 'ID_RSA', 'config/credentials.json', '.npmrc', 'secrets/token.txt', 'private/passwords.yml', 'src/.env/server.ts', 'services/credentials/api/package.json', 'services/token/api/package.json', 'services/private/api/package.json', 'services/secrets/api/package.json']) {
      expect(SecretFilter.isSensitivePath(path)).toBe(true)
    }

    expect(SecretFilter.isSensitivePath('src/application.ts')).toBe(false)
  })
})
