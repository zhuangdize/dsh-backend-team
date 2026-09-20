import { describe, expect, it } from 'vitest'
import { NodeRuntimeManifestResolver } from '../src/node-runtime-manifest-resolver.js'

describe('NodeRuntimeManifestResolver', () => {
  it('resolves exact selection and architecture', () => {
    const resolver = new NodeRuntimeManifestResolver()
    expect(resolver.resolve({ exactVersion: '24.19.0', source: 'new-project-default' }, 'darwin-arm64').architecture).toBe('darwin-arm64')
  })
  it('rejects unreviewed versions', () => {
    expect(() => new NodeRuntimeManifestResolver().resolve({ exactVersion: '22.99.0', source: '.nvmrc' }, 'darwin-arm64')).toThrow(/reviewed runtime manifest/i)
  })
})
