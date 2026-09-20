import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PolicyOwnedArtifactAdapter } from '../src/policy-owned-artifact-adapter.js'
import { nodeRuntimeManifestSchema } from '../src/node-runtime-manifest.js'

describe('PolicyOwnedArtifactAdapter', () => {
  it('verifies and extracts a Node archive without an installer callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-adapter-'))
    const version = '1.2.3'; const architecture = 'darwin-arm64'; const prefix = `node-v${version}-${architecture}/`
    const archive = gzipSync(tar([
      entry(`${prefix}`, Buffer.alloc(0), 0o755, '5'),
      entry(`${prefix}bin/`, Buffer.alloc(0), 0o755, '5'),
      entry(`${prefix}bin/node`, Buffer.from('node-binary'), 0o755),
      entry(`${prefix}bin/npm`, Buffer.from('npm-binary'), 0o755),
      entry(`${prefix}bin/npx`, Buffer.from('npx-binary'), 0o755),
      entry(`${prefix}lib/node_modules/npm/index.js`, Buffer.from('npm-library'), 0o644),
    ]))
    const manifest = nodeRuntimeManifestSchema.parse({ exactVersion: version, architecture, url: 'https://nodejs.org/dist/v1.2.3/node-v1.2.3-darwin-arm64.tar.gz', sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.byteLength, license: 'MIT', source: 'nodejs.org', status: 'supported' })
    let fetchCount = 0
    const adapter = new PolicyOwnedArtifactAdapter({ workspaceRoot: root, capability: { executeApprovedArtifact: async (_scope, _signal, operation) => operation() }, fetch: async () => { fetchCount += 1; return new Response(archive) } })
    const result = await adapter.provisionNodeRuntime(manifest, join(root, '.backend-team/runtime/nvm'), { token: 'approved' })
    expect(await realpath(result.node)).toContain(`/versions/node/v${version}/bin/node`)
    expect(await readFile(result.node, 'utf8')).toBe('node-binary')
    expect((await stat(result.node)).mode & 0o111).toBeGreaterThan(0)
    expect(result.archiveSha256).toBe(manifest.sha256)
    expect(result.runtimeTreeSha256).toMatch(/^[a-f0-9]{64}$/u)
    const reused = await adapter.provisionNodeRuntime(manifest, join(root, '.backend-team/runtime/nvm'), { token: 'approved' })
    expect(reused).toEqual(result)
    expect(fetchCount).toBe(1)
    const receiptPath = join(root, '.backend-team/runtime/nvm/versions/node/v1.2.3/.backend-team-runtime-receipt.json')
    const legacy = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
    delete legacy.runtimeTreeSha256
    await writeFile(receiptPath, `${JSON.stringify(legacy)}\n`)
    const migrated = await adapter.provisionNodeRuntime(manifest, join(root, '.backend-team/runtime/nvm'), { token: 'approved' })
    expect(migrated).toEqual(result)
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toHaveProperty('runtimeTreeSha256', result.runtimeTreeSha256)
    await writeFile(join(root, '.backend-team/runtime/nvm/versions/node/v1.2.3/lib/node_modules/npm/index.js'), 'tampered npm library')
    await expect(adapter.provisionNodeRuntime(manifest, join(root, '.backend-team/runtime/nvm'), { token: 'approved' })).rejects.toThrow(/runtime contents|approved archive/i)
    await writeFile(join(root, '.backend-team/runtime/nvm/versions/node/v1.2.3/lib/node_modules/npm/index.js'), 'npm-library')
    await writeFile(result.node, 'tampered')
    await expect(adapter.provisionNodeRuntime(manifest, join(root, '.backend-team/runtime/nvm'), { token: 'approved' })).rejects.toThrow(/runtime contents|approved archive/i)
  })
})

function entry(name: string, data: Buffer, mode: number, type = '0'): Buffer { const header = Buffer.alloc(512); header.write(name, 0, 100, 'utf8'); header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii'); header.write(`${data.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii'); header.write(type, 156, 1, 'ascii'); header.write('ustar\0', 257, 6, 'ascii'); header.fill(0x20, 148, 156); let sum = 0; for (const byte of header) sum += byte; header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii'); return Buffer.concat([header, data, Buffer.alloc((512 - (data.byteLength % 512)) % 512)]) }
function tar(entries: readonly Buffer[]): Buffer { return Buffer.concat([...entries, Buffer.alloc(1024)]) }
