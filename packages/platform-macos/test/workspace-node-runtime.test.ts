import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeRuntimeManifestResolver } from '../src/node-runtime-manifest-resolver.js'
import { WorkspaceNodeRuntime } from '../src/workspace-node-runtime.js'

describe('WorkspaceNodeRuntime fail-closed gates', () => {
  it('rejects EOL Node 20 for new projects before bootstrap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-')); let called = false
    const runtime = new WorkspaceNodeRuntime({ workspaceRoot: root, resolver: new NodeRuntimeManifestResolver(), commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }) }, bootstrap: { ensure: async () => { called = true; throw new Error('network') }, ensureRuntime: async () => { throw new Error('unused') } } as never })
    await expect(runtime.resolve({ selection: { exactVersion: '20.20.0', source: '.nvmrc' }, projectKind: 'new-project', architecture: 'darwin-arm64', installApproval: { approved: true } })).rejects.toThrow(/existing-project-only/i)
    expect(called).toBe(false)
  })
  it('requires real target-local executables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-')); const bin = join(root, '.backend-team/runtime/nvm/versions/node/v24.19.0/bin'); await mkdir(bin, { recursive: true }); await writeFile(join(root, '.backend-team/runtime/nvm/nvm.sh'), 'loader'); for (const n of ['node', 'npm', 'npx']) await writeFile(join(bin, n), 'binary', { mode: 0o755 })
    for (const n of ['node', 'npm', 'npx']) await chmod(join(bin, n), 0o755)
    const runtime = new WorkspaceNodeRuntime({ workspaceRoot: root, resolver: new NodeRuntimeManifestResolver(), commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }) }, bootstrap: { ensure: async () => join(root, '.backend-team/runtime/nvm/nvm.sh'), ensureRuntime: async () => ({ node: join(bin, 'node'), npm: join(bin, 'npm'), npx: join(bin, 'npx'), exactVersion: '24.19.0', architecture: 'darwin-arm64', archiveSha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d', nodeSha256: '1'.repeat(64), npmSha256: '2'.repeat(64), npxSha256: '3'.repeat(64), runtimeTreeSha256: '4'.repeat(64) }) } as never })
    const result = await runtime.resolve({ selection: { exactVersion: '24.19.0', source: 'new-project-default' }, projectKind: 'new-project', architecture: 'darwin-arm64', installApproval: { approved: true, token: 'install-token' } })
    expect(result.nodeRealPath).toContain('/.backend-team/runtime/nvm/')
  })
})
