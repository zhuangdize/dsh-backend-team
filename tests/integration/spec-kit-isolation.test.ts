import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SpecificationRecovery } from '../../packages/core/src/specification-recovery.js'
import type { BackendTeamState, StateStore } from '@dsh-backend-team/contracts'

it('proves blocked recovery cleanup stays inside the workspace and external snapshots remain unchanged', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-isolation-parent-'))
  const workspace = join(parent, 'workspace'); const external = join(parent, 'external')
  await mkdir(workspace, { recursive: true }); await mkdir(external, { recursive: true })
  try {
    const canonicalWorkspace = await realpath(workspace)
    const sentinel = join(external, 'sentinel.txt'); await writeFile(sentinel, 'do not touch')
    await mkdir(join(workspace, '.backend-team', 'locks'), { recursive: true })
    await writeFile(join(workspace, '.backend-team', 'locks', 'runtime.lock'), JSON.stringify({ pid: 2147483647, nonce: 'isolation-dead-lock', workspaceRoot: canonicalWorkspace }), { mode: 0o600 })
    const before = await readFile(sentinel, 'utf8')
    const state: BackendTeamState = { schemaVersion: 1, revision: 0, workspaceRoot: canonicalWorkspace, phase: 'SPECIFY', runs: [], approvals: [], approvalTokens: [] }
    const store: StateStore = { load: async () => state, create: async () => {}, transact: async (_revision, change) => change(state) }
    const recovery = new SpecificationRecovery({ stateStore: store, workspaceRoot: canonicalWorkspace, artifactRegistry: { snapshot: async () => ({ 'spec.md': 'a'.repeat(64) }) } })

    const audit = await recovery.audit()
    expect(audit.status).toBe('blocked')
    expect(audit.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(['FEATURE_DIRECTORY_MISSING', 'RUNTIME_PROVENANCE_MISSING']))
    expect(audit.cleanedLocks).toEqual(['.backend-team/locks/runtime.lock'])
    expect(await readFile(sentinel, 'utf8')).toBe(before)
    expect((await stat(external)).isDirectory()).toBe(true)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
