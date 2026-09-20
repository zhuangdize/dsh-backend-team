import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendTeamState } from '@dsh-backend-team/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStateStore } from '../src/index.js'

describe('FileStateStore filesystem boundaries', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
  })

  it('rejects a symlinked state directory without writing to its outside target', async () => {
    const workspaceRoot = await temporaryRoot('workspace')
    const outsideRoot = await temporaryRoot('outside')
    const store = new FileStateStore(workspaceRoot)
    await mkdir(join(workspaceRoot, '.backend-team'))
    await symlink(outsideRoot, join(workspaceRoot, '.backend-team', 'state'))

    await expect(store.create(initialState(store.workspaceRoot))).rejects.toThrow(/symlink/)

    await expect(access(join(outsideRoot, 'current.json'))).rejects.toThrow()
  })

  it('rejects a symlinked .backend-team directory without creating its state tree outside', async () => {
    const workspaceRoot = await temporaryRoot('workspace')
    const outsideRoot = await temporaryRoot('outside')
    const store = new FileStateStore(workspaceRoot)
    await symlink(outsideRoot, join(workspaceRoot, '.backend-team'))

    await expect(store.create(initialState(store.workspaceRoot))).rejects.toThrow(/symlink/)

    await expect(access(join(outsideRoot, 'state', 'current.json'))).rejects.toThrow()
  })

  it('rejects a symlinked state file rather than loading or replacing its target', async () => {
    const workspaceRoot = await temporaryRoot('workspace')
    const outsideRoot = await temporaryRoot('outside')
    const store = new FileStateStore(workspaceRoot)
    const initial = initialState(store.workspaceRoot)
    await store.create(initial)
    const outsideStatePath = join(outsideRoot, 'outside-current.json')
    await writeFile(outsideStatePath, JSON.stringify(initial), 'utf8')
    const statePath = join(workspaceRoot, '.backend-team', 'state', 'current.json')
    await rm(statePath)
    await symlink(outsideStatePath, statePath)

    await expect(store.load()).rejects.toThrow(/symlink/)
    expect(await readFile(outsideStatePath, 'utf8')).toBe(JSON.stringify(initial))
  })

  it('does not persist an in-place revision mutation from the callback', async () => {
    const workspaceRoot = await temporaryRoot('workspace')
    const store = new FileStateStore(workspaceRoot)
    await store.create(initialState(store.workspaceRoot))

    await expect(store.transact(0, (state) => {
      state.revision = 99
      return state
    })).rejects.toThrow(/must not modify revision/)

    expect(await store.load()).toMatchObject({ revision: 0, phase: 'DISCOVER' })
  })

  async function temporaryRoot(label: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `dsh-backend-team-${label}-`))
    roots.push(root)
    return root
  }
})

function initialState(workspaceRoot: string): BackendTeamState {
  return {
    schemaVersion: 1,
    revision: 0,
    workspaceRoot,
    phase: 'DISCOVER',
    runs: [],
    approvals: [],
    approvalTokens: [],
  }
}
