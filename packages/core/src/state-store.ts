import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BackendTeamStateSchema,
  type BackendTeamState,
  type StateMutation,
  type StateStore,
} from '@dsh-backend-team/contracts'

interface LockOwner {
  pid: number
  nonce: string
  createdAt: string
  workspaceRoot: string
}

interface FileIdentity {
  dev: number
  ino: number
}

export class StateRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`state revision conflict: expected ${expectedRevision}, found ${actualRevision}`)
    this.name = 'StateRevisionConflictError'
  }
}

export class FileStateStore implements StateStore {
  readonly workspaceRoot: string
  private readonly stateDirectory: string
  private readonly statePath: string
  private readonly lockPath: string

  constructor(workspaceRoot: string, private readonly taskId?: string) {
    if (taskId !== undefined && !/^[a-z0-9-]{1,80}$/u.test(taskId)) throw new Error('invalid task id')
    this.workspaceRoot = realpathSync.native(workspaceRoot)
    this.stateDirectory = join(this.workspaceRoot, '.backend-team', taskId === undefined ? 'state' : `state-${taskId}`)
    this.statePath = join(this.stateDirectory, 'current.json')
    this.lockPath = join(this.stateDirectory, 'current.lock')
  }

  async load(): Promise<BackendTeamState | null> {
    if (!await this.hasVerifiedStateDirectory()) {
      return null
    }
    await this.assertRegularStateFile()

    let content: string
    try {
      content = await readFile(this.statePath, 'utf8')
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return null
      }
      throw error
    }

    return this.validateState(JSON.parse(content))
  }

  async create(initial: BackendTeamState): Promise<void> {
    const validated = this.validateState(initial)

    await this.withLock(async () => {
      if (await this.load() !== null) {
        throw new Error('state already exists')
      }
      await this.writeState(validated)
    })
  }

  async transact(
    expectedRevision: number,
    change: StateMutation,
  ): Promise<BackendTeamState> {
    return this.withLock(async () => {
      const current = await this.load()
      if (current === null) {
        throw new Error('state has not been created')
      }
      if (current.revision !== expectedRevision) {
        throw new StateRevisionConflictError(expectedRevision, current.revision)
      }

      const currentRevision = current.revision
      const changed = this.validateState(change(current))
      if (changed.revision !== currentRevision) {
        throw new Error('state mutation must not modify revision')
      }

      const next = this.validateState({
        ...changed,
        revision: currentRevision + 1,
      })
      await this.writeState(next)
      return next
    })
  }

  private validateState(value: unknown): BackendTeamState {
    const state = BackendTeamStateSchema.parse(value)
    if (state.workspaceRoot !== this.workspaceRoot) {
      throw new Error('state workspace root does not match this store')
    }
    return state
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureStateDirectory()
    const owner: LockOwner = {
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
    }
    const ownerContent = JSON.stringify(owner)
    const lock = await open(this.lockPath, 'wx', 0o600)
    let identity: FileIdentity | undefined
    let ownerPayloadPublished = false
    let result!: T
    const noFailure = Symbol('no failure')
    let primaryFailure: unknown = noFailure

    try {
      identity = await this.captureLockIdentity(lock)
      await lock.writeFile(ownerContent, 'utf8')
      ownerPayloadPublished = true
      await lock.sync()
      result = await operation()
    } catch (error: unknown) {
      primaryFailure = error
    }

    const cleanupErrors = await this.closeWithRetry(lock)
    if (identity !== undefined) {
      try {
        await this.removeOwnedLock(ownerContent, identity, ownerPayloadPublished)
      } catch (error: unknown) {
        cleanupErrors.push(error)
      }
    }

    if (primaryFailure !== noFailure) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primaryFailure, ...cleanupErrors],
          'state lock operation and cleanup failed',
        )
      }
      throw primaryFailure
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'state lock cleanup failed')
    }
    return result
  }

  private async ensureStateDirectory(): Promise<void> {
    const backendDirectory = await this.inspectDirectory(
      this.workspaceRoot,
      '.backend-team',
      true,
    )
    if (backendDirectory === null) {
      throw new Error('unable to create state directory')
    }
    await this.inspectDirectory(backendDirectory, this.taskId === undefined ? 'state' : `state-${this.taskId}`, true)
  }

  private async hasVerifiedStateDirectory(): Promise<boolean> {
    const backendDirectory = await this.inspectDirectory(
      this.workspaceRoot,
      '.backend-team',
      false,
    )
    if (backendDirectory === null) {
      return false
    }
    return (await this.inspectDirectory(backendDirectory, this.taskId === undefined ? 'state' : `state-${this.taskId}`, false)) !== null
  }

  private async inspectDirectory(
    parentDirectory: string,
    name: string,
    create: boolean,
  ): Promise<string | null> {
    const directory = join(parentDirectory, name)
    let details
    try {
      details = await lstat(directory)
    } catch (error: unknown) {
      if (!isMissingFile(error) || !create) {
        if (isMissingFile(error)) {
          return null
        }
        throw error
      }
      await mkdir(directory, { mode: 0o700 })
      details = await lstat(directory)
    }

    if (details.isSymbolicLink()) {
      throw new Error(`state directory component is a symlink: ${directory}`)
    }
    if (!details.isDirectory()) {
      throw new Error(`state directory component is not a directory: ${directory}`)
    }
    if (await realpath(directory) !== directory) {
      throw new Error(`state directory component is not canonical: ${directory}`)
    }

    await chmod(directory, 0o700)
    return directory
  }

  private async assertRegularStateFile(): Promise<void> {
    try {
      const details = await lstat(this.statePath)
      if (details.isSymbolicLink()) {
        throw new Error(`state file is a symlink: ${this.statePath}`)
      }
      if (!details.isFile()) {
        throw new Error(`state file is not a regular file: ${this.statePath}`)
      }
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw error
      }
    }
  }

  private async writeState(value: BackendTeamState): Promise<void> {
    await this.assertRegularStateFile()
    const temporaryPath = join(this.stateDirectory, `current.json.tmp-${randomUUID()}`)
    const temporary = await open(temporaryPath, 'wx', 0o600)
    let renamed = false
    const noFailure = Symbol('no failure')
    let primaryFailure: unknown = noFailure

    try {
      await temporary.writeFile(JSON.stringify(value), 'utf8')
      await temporary.sync()
    } catch (error: unknown) {
      primaryFailure = error
    }

    const cleanupErrors = await this.closeWithRetry(temporary)
    if (primaryFailure === noFailure && cleanupErrors.length === 0) {
      try {
        await this.assertRegularStateFile()
        await rename(temporaryPath, this.statePath)
        renamed = true
        await this.syncStateDirectory()
      } catch (error: unknown) {
        primaryFailure = error
      }
    }

    if (!renamed) {
      try {
        await rm(temporaryPath, { force: true })
      } catch (error: unknown) {
        cleanupErrors.push(error)
      }
    }

    if (primaryFailure !== noFailure) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primaryFailure, ...cleanupErrors],
          'state write and cleanup failed',
        )
      }
      throw primaryFailure
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'state file cleanup failed')
    }
  }

  private async syncStateDirectory(): Promise<void> {
    const directory = await open(this.stateDirectory, 'r')
    const noFailure = Symbol('no failure')
    let primaryFailure: unknown = noFailure

    try {
      await directory.sync()
    } catch (error: unknown) {
      primaryFailure = error
    }

    const cleanupErrors = await this.closeWithRetry(directory)
    if (primaryFailure !== noFailure) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primaryFailure, ...cleanupErrors],
          'state directory sync and cleanup failed',
        )
      }
      throw primaryFailure
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'state directory cleanup failed')
    }
  }

  // This is an advisory same-user lock. Identity and content checks narrow the
  // replacement window, but privileged/malicious concurrent replacement still
  // needs OS-level coordination outside this Node path-based protocol.
  private async captureLockIdentity(
    lock: { stat(): Promise<{ dev: number, ino: number }> },
  ): Promise<FileIdentity> {
    try {
      return toIdentity(await lock.stat())
    } catch (handleStatError: unknown) {
      try {
        const details = await lstat(this.lockPath)
        if (details.isSymbolicLink() || !details.isFile()) {
          throw new Error('newly created lock path is not a regular file')
        }
        return toIdentity(details)
      } catch (pathStatError: unknown) {
        throw new AggregateError(
          [handleStatError, pathStatError],
          'unable to establish identity for the newly created lock',
        )
      }
    }
  }

  private async closeWithRetry(lock: { close(): Promise<void> }): Promise<unknown[]> {
    const errors: unknown[] = []
    try {
      await lock.close()
      return errors
    } catch (error: unknown) {
      errors.push(error)
    }

    try {
      await lock.close()
    } catch (error: unknown) {
      errors.push(error)
    }
    return errors
  }

  private async removeOwnedLock(
    ownerContent: string,
    identity: FileIdentity,
    ownerPayloadPublished: boolean,
  ): Promise<void> {
    try {
      if (!await this.lockMatches(identity)) {
        return
      }
      if (ownerPayloadPublished && await readFile(this.lockPath, 'utf8') !== ownerContent) {
        return
      }
      if (!await this.lockMatches(identity)) {
        return
      }
      await rm(this.lockPath)
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw error
      }
    }
  }

  private async lockMatches(identity: FileIdentity): Promise<boolean> {
    const details = await lstat(this.lockPath)
    return details.isFile() && !details.isSymbolicLink()
      && details.dev === identity.dev && details.ino === identity.ino
  }
}

function toIdentity(details: { dev: number, ino: number }): FileIdentity {
  return { dev: details.dev, ino: details.ino }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
