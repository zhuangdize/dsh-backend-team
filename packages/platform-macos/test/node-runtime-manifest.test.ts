import { describe, expect, it } from 'vitest'
import { nodeRuntimeManifestSchema } from '../src/node-runtime-manifest.js'

describe('node runtime manifests', () => {
  it('accepts complete reviewed provenance', () => {
    const result = nodeRuntimeManifestSchema.safeParse({
      exactVersion: '24.19.0', architecture: 'darwin-arm64',
      url: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz',
      sha256: 'a'.repeat(64), bytes: 52234372, license: 'MIT',
      source: 'nodejs.org', status: 'supported',
    })
    expect(result.success).toBe(true)
  })
  it('rejects incomplete provenance and invalid architecture', () => {
    expect(nodeRuntimeManifestSchema.safeParse({ exactVersion: '24.19.0', architecture: 'linux-x64' }).success).toBe(false)
  })
})
