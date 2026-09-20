import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendTeamState } from '@dsh-backend-team/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({
  closeFailure: 'none' as 'directory' | 'lock' | 'none' | 'temporary',
  closeFailureValue: 'error' as 'error' | 'string',
  closedPaths: new Set<string>(),
  failedClosePaths: new Set<string>(),
  fallbackStatFailure: false,
  replaceLockOnRead: false,
  syncFailure: 'none' as 'directory' | 'lock' | 'none' | 'temporary',
  statFailure: 'none' as 'lock' | 'none',
  writeFailure: 'none' as 'lock' | 'none' | 'temporary',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      const shouldFailSync = (fault.syncFailure === 'lock' && path.endsWith('/current.lock'))
        || (fault.syncFailure === 'temporary' && path.includes('/current.json.tmp-'))
        || (fault.syncFailure === 'directory' && isStateDirectoryPath(path))
      const shouldFailStat = fault.statFailure === 'lock' && path.endsWith('/current.lock')
      const shouldFailWrite = (fault.writeFailure === 'lock' && path.endsWith('/current.lock'))
        || (fault.writeFailure === 'temporary' && path.includes('/current.json.tmp-'))
      const shouldFailClose = (fault.closeFailure === 'lock' && path.endsWith('/current.lock'))
        || (fault.closeFailure === 'temporary' && path.includes('/current.json.tmp-'))
        || (fault.closeFailure === 'directory' && isStateDirectoryPath(path))

      if (!shouldFailSync && !shouldFailStat && !shouldFailWrite && !shouldFailClose) {
        return handle
      }

      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat' && shouldFailStat) {
            return async () => {
              throw new Error('forced lock stat failure')
            }
          }
          if (property === 'writeFile' && shouldFailWrite) {
            return async () => {
              await target.writeFile('{', 'utf8')
              throw new Error(`forced partial ${fault.writeFailure} write failure`)
            }
          }
          if (property === 'sync' && shouldFailSync) {
            return async () => {
              throw new Error(`forced ${fault.syncFailure} sync failure`)
            }
          }
          if (property === 'close' && shouldFailClose) {
            return async () => {
              if (!fault.failedClosePaths.has(path)) {
                fault.failedClosePaths.add(path)
                if (fault.closeFailureValue === 'string') {
                  throw `forced ${fault.closeFailure} close string failure`
                }
                throw new Error(`forced ${fault.closeFailure} close failure`)
              }
              await target.close()
              fault.closedPaths.add(path)
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const content = await actual.readFile(...args)
      const path = String(args[0])
      if (fault.replaceLockOnRead && path.endsWith('/current.lock') && typeof content === 'string') {
        await actual.rm(path)
        await actual.writeFile(path, content, { mode: 0o600 })
      }
      return content
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0])
      if (fault.fallbackStatFailure && path.endsWith('/current.lock')) {
        throw new Error('forced lock fallback lstat failure')
      }
      return actual.lstat(...args)
    },
  }
})

import { FileStateStore } from '../src/index.js'

describe('FileStateStore cleanup under I/O failures', () => {
  const roots: string[] = []

  afterEach(async () => {
    fault.closeFailure = 'none'
    fault.closeFailureValue = 'error'
    fault.closedPaths.clear()
    fault.failedClosePaths.clear()
    fault.fallbackStatFailure = false
    fault.replaceLockOnRead = false
    fault.syncFailure = 'none'
    fault.statFailure = 'none'
    fault.writeFailure = 'none'
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
  })

  it('cleans the lock it created when lock sync fails', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.syncFailure = 'lock'

    await expect(store.create(initialState(store.workspaceRoot))).rejects.toThrow('forced lock sync failure')

    await expect(access(lockPath(workspaceRoot))).rejects.toThrow()
  })

  it('cleans the lock it created when handle stat fails', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.statFailure = 'lock'

    await expect(store.create(initialState(store.workspaceRoot))).resolves.toBeUndefined()

    await expect(access(lockPath(workspaceRoot))).rejects.toThrow()
  })

  it('cleans the exact lock it created after a partial lock write fails', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.writeFailure = 'lock'

    await expect(store.create(initialState(store.workspaceRoot))).rejects.toThrow('forced partial lock write failure')

    await expect(access(lockPath(workspaceRoot))).rejects.toThrow()
  })

  it('cleans the lock it created when lock close fails', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.closeFailure = 'lock'

    const failure = await store.create(initialState(store.workspaceRoot)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    if (failure instanceof AggregateError) {
      expect(failure.errors).toContainEqual(expect.objectContaining({
        message: 'forced lock close failure',
      }))
    }
    await expect(access(lockPath(workspaceRoot))).rejects.toThrow()
    expect(fault.closedPaths.has(lockPath(store.workspaceRoot))).toBe(true)
  })

  it('fails closed and preserves the created lock when both identity sources fail', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.statFailure = 'lock'
    fault.fallbackStatFailure = true

    await expect(store.create(initialState(store.workspaceRoot))).rejects.toThrow(
      'unable to establish identity for the newly created lock',
    )

    await expect(access(lockPath(workspaceRoot))).resolves.toBeUndefined()
  })

  it('aggregates a primary sync failure with a non-Error close cleanup failure', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.syncFailure = 'lock'
    fault.closeFailure = 'lock'
    fault.closeFailureValue = 'string'

    const failure = await store.create(initialState(store.workspaceRoot)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    if (failure instanceof AggregateError) {
      expect(failure.errors).toContain('forced lock close string failure')
      expect(failure.errors).toContainEqual(expect.objectContaining({
        message: 'forced lock sync failure',
      }))
    }
    await expect(access(lockPath(workspaceRoot))).rejects.toThrow()
    expect(fault.closedPaths.has(lockPath(store.workspaceRoot))).toBe(true)
  })

  it('cleans temporary state files when their sync fails before rename', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.syncFailure = 'temporary'

    await expect(store.create(initialState(store.workspaceRoot))).rejects.toThrow('forced temporary sync failure')

    const names = await readdir(stateDirectory(workspaceRoot))
    expect(names.filter((name) => name.startsWith('current.json.tmp-'))).toEqual([])
  })

  it('cleans temporary state files when their write fails before rename', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.writeFailure = 'temporary'

    await expect(store.create(initialState(store.workspaceRoot))).rejects.toThrow('forced partial temporary write failure')

    const names = await readdir(stateDirectory(workspaceRoot))
    expect(names.filter((name) => name.startsWith('current.json.tmp-'))).toEqual([])
  })

  it('cleans temporary state files when their close fails before rename', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.closeFailure = 'temporary'

    const failure = await store.create(initialState(store.workspaceRoot)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    if (failure instanceof AggregateError) {
      expect(failure.errors).toContainEqual(expect.objectContaining({
        message: 'forced temporary close failure',
      }))
    }
    const names = await readdir(stateDirectory(workspaceRoot))
    expect(names.filter((name) => name.startsWith('current.json.tmp-'))).toEqual([])
    await expect(access(statePath(workspaceRoot))).rejects.toThrow()
  })

  it('aggregates a temporary write failure with close cleanup failure and closes the handle', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.writeFailure = 'temporary'
    fault.closeFailure = 'temporary'

    const failure = await store.create(initialState(store.workspaceRoot)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    if (failure instanceof AggregateError) {
      expect(failure.errors).toContainEqual(expect.objectContaining({
        message: 'forced partial temporary write failure',
      }))
      expect(failure.errors).toContainEqual(expect.objectContaining({
        message: 'forced temporary close failure',
      }))
    }
    const names = await readdir(stateDirectory(workspaceRoot))
    expect(names.filter((name) => name.startsWith('current.json.tmp-'))).toEqual([])
    await expect(access(statePath(workspaceRoot))).rejects.toThrow()
    expect([...fault.closedPaths].some((path) => path.includes('/current.json.tmp-'))).toBe(true)
  })

  it('aggregates directory sync and close failures after atomically renaming state', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    fault.syncFailure = 'directory'
    fault.closeFailure = 'directory'

    const failure = await store.create(initialState(store.workspaceRoot)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    if (failure instanceof AggregateError) {
      expect(failure.errors).toContainEqual(expect.objectContaining({
        message: 'forced directory sync failure',
      }))
      expect(failure.errors).toContainEqual(expect.objectContaining({
        message: 'forced directory close failure',
      }))
    }
    await expect(access(statePath(workspaceRoot))).resolves.toBeUndefined()
    expect(fault.closedPaths.has(stateDirectory(store.workspaceRoot))).toBe(true)
  })

  it('keeps a same-content replacement lock created during its transaction', async () => {
    const workspaceRoot = await temporaryRoot()
    const store = new FileStateStore(workspaceRoot)
    await store.create(initialState(store.workspaceRoot))
    fault.replaceLockOnRead = true

    await store.transact(0, (state) => ({ ...state, phase: 'SPECIFY' }))

    fault.replaceLockOnRead = false
    expect(await readFile(lockPath(workspaceRoot), 'utf8')).toMatch(/"nonce":"/)
  })

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-backend-team-fault-'))
    roots.push(root)
    return root
  }
})

function stateDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, '.backend-team', 'state')
}

function lockPath(workspaceRoot: string): string {
  return join(stateDirectory(workspaceRoot), 'current.lock')
}

function statePath(workspaceRoot: string): string {
  return join(stateDirectory(workspaceRoot), 'current.json')
}

function isStateDirectoryPath(path: string): boolean {
  return path.endsWith('/.backend-team/state')
}

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
