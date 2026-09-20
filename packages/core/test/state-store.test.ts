import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendTeamState } from '@dsh-backend-team/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileStateStore, StateRevisionConflictError } from '../src/index.js'

describe('FileStateStore', () => {
  let workspaceRoot: string
  let store: FileStateStore

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-backend-team-state-'))
    store = new FileStateStore(workspaceRoot)
  })

  afterEach(async () => {
    await rm(workspaceRoot, { force: true, recursive: true })
  })

  it('writes validated state to the workspace-root state path with restrictive permissions', async () => {
    const initial = initialState(store.workspaceRoot)

    await store.create(initial)

    const statePath = join(workspaceRoot, '.backend-team', 'state', 'current.json')
    expect(await store.load()).toEqual(initial)
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(initial)
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
  })

  it('keeps task revisions isolated from the original workspace record across reloads', async () => {
    await store.create(initialState(store.workspaceRoot))
    const task = new FileStateStore(workspaceRoot, 'task-one')
    await task.create(initialState(store.workspaceRoot))
    await task.transact(0, state => ({ ...state, phase: 'SPECIFY' }))
    expect(await store.load()).toMatchObject({ phase: 'DISCOVER', revision: 0 })
    expect(await new FileStateStore(workspaceRoot, 'task-one').load()).toMatchObject({ phase: 'SPECIFY', revision: 1 })
    expect(await new FileStateStore(workspaceRoot, 'task-two').load()).toBeNull()
    expect(() => new FileStateStore(workspaceRoot, '../escape')).toThrow('invalid task id')
  })

  it('increments revision once and rejects a stale writer without changing the file', async () => {
    await store.create(initialState(store.workspaceRoot))

    const updated = await store.transact(0, (state) => ({
      ...state,
      phase: 'SPECIFY',
    }))

    expect(updated.revision).toBe(1)
    await expect(store.transact(0, (state) => state)).rejects.toBeInstanceOf(
      StateRevisionConflictError,
    )
    expect(await store.load()).toMatchObject({ revision: 1, phase: 'SPECIFY' })
  })

  it('validates a mutation result before persisting it', async () => {
    await store.create(initialState(store.workspaceRoot))

    await expect(store.transact(0, (state) => ({ ...state, phase: 'NOT_A_PHASE' }))).rejects.toThrow()

    expect(await store.load()).toMatchObject({ revision: 0, phase: 'DISCOVER' })
  })

  it('leaves a pre-existing lock in place rather than deleting it as stale', async () => {
    await store.create(initialState(store.workspaceRoot))
    const lockPath = join(workspaceRoot, '.backend-team', 'state', 'current.lock')
    const staleLock = '{"pid":1,"nonce":"stale","createdAt":"2026-08-25T00:00:00.000Z","workspaceRoot":"/old"}'
    await mkdir(join(workspaceRoot, '.backend-team', 'state'), { recursive: true })
    await writeFile(lockPath, staleLock, { mode: 0o600 })

    await expect(store.transact(0, (state) => state)).rejects.toThrow()

    expect(await readFile(lockPath, 'utf8')).toBe(staleLock)
  })
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
