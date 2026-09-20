import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendTeamState, StateStore } from '@dsh-backend-team/contracts'
import { expect, it } from 'vitest'
import { SpecificationRecovery } from '../../packages/core/src/specification-recovery.js'

it('recovers an interrupted phase without rerunning completed work or crossing the workspace boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-specification-recovery-integration-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-specification-recovery-outside-'))
  try {
    const canonicalRoot = await realpath(root)
    await mkdir(join(root, '.backend-team', 'locks'), { recursive: true })
    await writeFile(join(root, '.backend-team', 'locks', 'runtime.lock'), JSON.stringify({ pid: 2147483647, nonce: 'integration-dead-lock', workspaceRoot: canonicalRoot }), { mode: 0o600 })
    await writeFile(join(outside, 'sentinel'), 'unchanged')
    let state: BackendTeamState = { schemaVersion: 1, revision: 0, workspaceRoot: canonicalRoot, phase: 'AWAIT_DESIGN_APPROVAL', runs: [{ id: 'design-1', status: 'running', startedAt: '2026-08-27T00:00:00.000Z', completedAt: null, summary: 'design' }], approvals: [], approvalTokens: [] }
    const store: StateStore = { load: async () => state, create: async (initial) => { state = initial }, transact: async (revision, change) => { state = { ...change(state), revision: revision + 1 }; return state } }
    const recovery = new SpecificationRecovery({ stateStore: store, workspaceRoot: canonicalRoot, artifactRegistry: { snapshot: async () => ({ 'spec.md': 'a'.repeat(64) }) } })

    const audit = await recovery.audit()
    expect(audit.status).toBe('blocked')
    expect(audit.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(['FEATURE_DIRECTORY_MISSING', 'RUNTIME_PROVENANCE_MISSING']))
    expect(audit.interruptedRunIds).toEqual(['design-1'])
    expect(audit.cleanedLocks).toEqual(['.backend-team/locks/runtime.lock'])
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('unchanged')
    expect(state.phase).toBe('AWAIT_DESIGN_APPROVAL')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
