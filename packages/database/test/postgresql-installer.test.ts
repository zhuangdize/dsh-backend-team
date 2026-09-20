import { describe, expect, it } from 'vitest'
import { PostgresqlInstaller } from '../src/index.js'

describe('PostgresqlInstaller', () => {
  it('requires native artifact attestation and install approval', async () => {
    const installer = new PostgresqlInstaller({ workspaceRoot: '/workspace', architecture: 'darwin-arm64', manifest: { schemaVersion: 1, component: 'postgresql', version: '18.6', status: 'pending-native-build', sourceManifest: 'postgresql-source-18.6.json', artifacts: [] }, adapter: { install: async () => '/workspace/.backend-team/runtime/postgresql/18.6/darwin-arm64' } })
    await expect(installer.ensureInstalled({ approved: true, token: 'approved' })).rejects.toThrow(/native build attestation/i)
  })
})
