import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NewProjectBootstrapper } from '../src/new-project-bootstrapper.js'

const strategy = { kind: 'new-project', nodeRuntime: { exactVersion: '24.19.0', source: 'new-project-default' } }
describe('NewProjectBootstrapper', () => {
  it('previews the approved Node/PostgreSQL baseline', async () => {
    const b = new NewProjectBootstrapper({ workspaceRoot: await mkdtemp(join(tmpdir(), 'np-')), commandRunner: { run: async () => ({}) } })
    const p = await b.preview(strategy)
    expect(p.dependencies).toMatchObject({ '@nestjs/core': '11.2.2', 'drizzle-orm': '0.45.2', pg: '8.23.0' })
    expect(p.nodeRuntime).toEqual(strategy.nodeRuntime)
    expect(p.files.length).toBeGreaterThan(5)
  })
  it('refuses existing projects before any write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'np-')); const b = new NewProjectBootstrapper({ workspaceRoot: root, commandRunner: { run: async () => ({}) } })
    await expect(b.preview({ kind: 'modify-in-place', nodeRuntime: strategy.nodeRuntime })).rejects.toThrow('new-project bootstrap is not applicable')
    await rm(root, { recursive: true, force: true })
  })
  it('requires design and dependency/install approvals and an empty root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'np-')); const b = new NewProjectBootstrapper({ workspaceRoot: root, commandRunner: { run: async () => ({}) } })
    await expect(b.apply(strategy, {})).rejects.toThrow(/design approval/i)
    await rm(root, { recursive: true, force: true })
  })
  it('applies the baseline with an approved registry install and lifecycle scripts disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'np-')); let request: Record<string, unknown> | undefined
    const b = new NewProjectBootstrapper({
      workspaceRoot: root,
      runtime: { resolve: async () => ({ nodeRealPath: '/workspace/.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node', npmRealPath: '/workspace/.backend-team/runtime/nvm/versions/node/v24.19.0/bin/npm', npxRealPath: '/workspace/.backend-team/runtime/nvm/versions/node/v24.19.0/bin/npx' }) },
      commandRunner: { run: async (value) => { request = { ...value }; return { exitCode: 0 } } },
    })
    const result = await b.apply(strategy, { design: true, dependency: true, install: true, installToken: 'install-approved' })
    expect(result.conflicts).toEqual([])
    expect(request).toMatchObject({ args: ['install', '--ignore-scripts'], cwd: await realpath(root), networkPolicy: 'allow', approvalToken: 'install-approved' })
    await rm(root, { recursive: true, force: true })
  })
})
