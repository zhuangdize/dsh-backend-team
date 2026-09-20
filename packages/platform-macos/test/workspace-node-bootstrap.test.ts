import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceNodeBootstrap } from '../src/workspace-node-bootstrap.js'
describe('WorkspaceNodeBootstrap', () => {
  it('requires an approval token before adapter/network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nvm-')); let called = false
    const b = new WorkspaceNodeBootstrap({ workspaceRoot: root, adapter: { provisionNvm: async () => { called = true; return '' }, provisionNodeRuntime: async () => { throw new Error('unused') } } })
    await expect(b.ensure({ token: '' })).rejects.toThrow(/approval token/i); expect(called).toBe(false)
  })
  it('accepts only a real target-local nvm.sh from installer capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nvm-')); const loader = join(root, '.backend-team/runtime/nvm/nvm.sh'); await mkdir(join(root, '.backend-team/runtime/nvm'), { recursive: true }); await writeFile(loader, '# loader')
    const b = new WorkspaceNodeBootstrap({ workspaceRoot: root, adapter: { provisionNvm: async (_m, _d, a) => { expect(a.token).toBe('t'); return loader }, provisionNodeRuntime: async () => { throw new Error('unused') } } })
    expect(await b.ensure({ token: 't' })).toBe(await realpath(loader))
  })
})
