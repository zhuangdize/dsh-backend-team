import { realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BackendTeamEventSchema, type BackendTeamEvent } from '@dsh-backend-team/contracts'
import type { PersistedEventStore } from './persisted-event-port.js'

/** Workspace-local append-only event log used by production orchestration. */
export class FilePersistedEventStore implements PersistedEventStore {
  readonly workspaceRoot: string
  private readonly eventDirectory: string
  private readonly eventPath: string
  private readonly lockPath: string
  private appendTail: Promise<void> = Promise.resolve()

  constructor(workspaceRoot: string, private readonly taskId?: string) {
    if (taskId !== undefined && !/^[a-z0-9-]{1,80}$/u.test(taskId)) throw new Error('invalid task id')
    this.workspaceRoot = realpathSync.native(workspaceRoot)
    this.eventDirectory = join(this.workspaceRoot, '.backend-team', taskId === undefined ? 'events' : `events-${taskId}`)
    this.eventPath = join(this.eventDirectory, 'events.jsonl')
    this.lockPath = join(this.eventDirectory, 'events.lock')
  }

  append(workspaceId: string, eventInput: BackendTeamEvent): Promise<void> {
    const operation = this.appendTail.then(() => this.withLock(async () => this.appendOne(workspaceId, eventInput)))
    this.appendTail = operation.catch(() => undefined)
    return operation
  }

  async read(workspaceId: string): Promise<readonly BackendTeamEvent[]> {
    this.assertWorkspace(workspaceId)
    if (!await this.hasVerifiedEventDirectory()) return Object.freeze([])
    await this.assertRegularEventFile()
    return Object.freeze(await this.readEvents())
  }

  private async appendOne(workspaceId: string, eventInput: BackendTeamEvent): Promise<void> {
    this.assertWorkspace(workspaceId)
    const event = BackendTeamEventSchema.parse(eventInput)
    await this.ensureEventDirectory()
    await this.assertRegularEventFile()
    const existing = await this.readEvents()
    const duplicate = existing.find((candidate) => candidate.id === event.id)
    if (duplicate !== undefined) {
      if (JSON.stringify(duplicate) !== JSON.stringify(event)) throw new Error('conflicting duplicate event id')
      return
    }
    if (existing.some((candidate) => candidate.sequence === event.sequence)) throw new Error('conflicting event sequence')

    const file = await open(this.eventPath, 'a', 0o600)
    try {
      await file.writeFile(`${JSON.stringify(event)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await chmod(this.eventPath, 0o600)
  }

  private async readEvents(): Promise<BackendTeamEvent[]> {
    let content: string
    try {
      content = await readFile(this.eventPath, 'utf8')
    } catch (error: unknown) {
      if (isMissingFile(error)) return []
      throw error
    }
    if (content.length === 0) return []
    const lines = content.split('\n')
    if (lines.at(-1) === '') lines.pop()
    if (lines.some((line) => line.trim().length === 0)) throw new Error('event log contains a blank line')
    const events = lines.map((line) => BackendTeamEventSchema.parse(JSON.parse(line)))
    const ids = new Map<string, BackendTeamEvent>()
    const sequences = new Map<number, string>()
    for (const event of events) {
      const duplicate = ids.get(event.id)
      if (duplicate !== undefined && JSON.stringify(duplicate) !== JSON.stringify(event)) throw new Error('conflicting duplicate event id in durable storage')
      const owner = sequences.get(event.sequence)
      if (owner !== undefined && owner !== event.id) throw new Error('conflicting event sequence in durable storage')
      ids.set(event.id, event)
      sequences.set(event.sequence, event.id)
    }
    return events.sort((left, right) => left.sequence - right.sequence)
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureEventDirectory()
    const lock = await openWithRetry(this.lockPath)
    const identity = await lock.stat()
    try {
      return await operation()
    } finally {
      await lock.close()
      await removeOwnedLock(this.lockPath, identity)
    }
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceRoot) throw new Error('event workspace mismatch')
  }

  private async ensureEventDirectory(): Promise<void> {
    const backend = await this.inspectDirectory(this.workspaceRoot, '.backend-team', true)
    if (backend === null) throw new Error('unable to create backend-team directory')
    await this.inspectDirectory(backend, this.taskId === undefined ? 'events' : `events-${this.taskId}`, true)
  }

  private async hasVerifiedEventDirectory(): Promise<boolean> {
    const backend = await this.inspectDirectory(this.workspaceRoot, '.backend-team', false)
    if (backend === null) return false
    return (await this.inspectDirectory(backend, this.taskId === undefined ? 'events' : `events-${this.taskId}`, false)) !== null
  }

  private async inspectDirectory(parent: string, name: string, create: boolean): Promise<string | null> {
    const directory = join(parent, name)
    let details
    try {
      details = await lstat(directory)
    } catch (error: unknown) {
      if (!isMissingFile(error) || !create) {
        if (isMissingFile(error)) return null
        throw error
      }
      try {
        await mkdir(directory, { mode: 0o700 })
      } catch (mkdirError: unknown) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError
      }
      details = await lstat(directory)
    }
    if (details.isSymbolicLink()) throw new Error(`event directory component is a symlink: ${directory}`)
    if (!details.isDirectory()) throw new Error(`event directory component is not a directory: ${directory}`)
    if (await realpath(directory) !== directory) throw new Error(`event directory component is not canonical: ${directory}`)
    await chmod(directory, 0o700)
    return directory
  }

  private async assertRegularEventFile(): Promise<void> {
    try {
      const details = await lstat(this.eventPath)
      if (details.isSymbolicLink()) throw new Error(`event file is a symlink: ${this.eventPath}`)
      if (!details.isFile()) throw new Error(`event file is not a regular file: ${this.eventPath}`)
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error
    }
  }
}

async function openWithRetry(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  let lastError: unknown
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await open(path, 'wx', 0o600)
    } catch (error: unknown) {
      lastError = error
      if (!isAlreadyExists(error)) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

async function removeOwnedLock(path: string, identity: { readonly dev: number; readonly ino: number }): Promise<void> {
  try {
    const current = await lstat(path)
    if (current.dev === identity.dev && current.ino === identity.ino) await rm(path, { force: true })
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
