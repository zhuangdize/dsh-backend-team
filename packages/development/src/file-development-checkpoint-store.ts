import { constants, realpathSync } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AgentHandoffSchema } from '@dsh-backend-team/contracts'
import type { DevelopmentCheckpoint } from './development-coordinator.js'
import type { DevelopmentCheckpointStore } from './development-run-controller.js'

const schema = z.object({
  planHash: z.string().regex(/^[a-f0-9]{64}$/u),
  slices: z.array(z.object({ sliceId: z.string().min(1), status: z.literal('passed'), attempts: z.number().int().nonnegative(),
    handoffs: z.array(AgentHandoffSchema.extend({ parentTaskId: z.string().min(1), acknowledgedBy: z.string().optional(), acknowledgedAt: z.string().datetime().optional() })),
  }).strict()),
}).strict()

/** Atomic recovery evidence; only passed slices may become skip candidates. */
export class FileDevelopmentCheckpointStore implements DevelopmentCheckpointStore {
  private readonly root: string
  private readonly directory: string
  private readonly path: string
  private readonly lockPath: string
  constructor(workspaceRoot: string, taskId?: string) {
    if (taskId !== undefined && !/^[a-z0-9-]{1,80}$/u.test(taskId)) throw new Error('invalid task id')
    this.root = realpathSync(workspaceRoot)
    this.directory = join(this.root, '.backend-team', taskId === undefined ? 'development' : `development-${taskId}`)
    this.path = join(this.directory, 'checkpoint.json')
    this.lockPath = join(this.directory, '.run.lock')
  }
  async acquireRun(): Promise<() => Promise<void>> {
    await this.ensureDirectory()
    const exlock = (constants as unknown as { O_EXLOCK?: number }).O_EXLOCK ?? (process.platform === 'darwin' ? 0x20 : undefined)
    if (exlock === undefined) return this.acquireMarkerLock()
    let handle
    try {
      handle = await open(this.lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | exlock, 0o600)
    } catch {
      throw new Error('development run lock is busy')
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error('unsafe development run lock')
      await handle.truncate(0)
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }))
      await handle.sync()
    } catch (error: unknown) {
      await handle.close().catch(() => undefined)
      throw error
    }
    let released = false
    return async () => {
      if (released) return
      released = true
      await handle.close()
    }
  }
  async load(): Promise<DevelopmentCheckpoint | null> {
    await this.ensureDirectory()
    let handle
    try { handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) throw new Error('unsafe development checkpoint file')
      const parsed = schema.parse(JSON.parse(await handle.readFile('utf8')))
      return { ...parsed, slices: parsed.slices.map(slice => ({ ...slice, handoffs: slice.handoffs.map(({ acknowledgedBy, acknowledgedAt, ...handoff }) => ({ ...handoff, ...(acknowledgedBy === undefined ? {} : { acknowledgedBy }), ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }) })) })) }
    } finally { await handle.close() }
  }
  async save(checkpoint: DevelopmentCheckpoint): Promise<void> {
    const value = schema.parse({ planHash: checkpoint.planHash, slices: checkpoint.slices.filter(slice => slice.status === 'passed') })
    const content = JSON.stringify(value)
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error('development checkpoint exceeds size limit')
    await this.ensureDirectory()
    const temporary = join(this.directory, randomUUID() + '.tmp')
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      await this.ensureDirectory()
      await rename(temporary, this.path)
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
    } finally { await unlink(temporary).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
  }
  /** Keep recovery evidence, but never reuse old-plan slices after requirements change. */
  async archiveForChange(changeId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/u.test(changeId)) throw new Error('invalid requirement change id')
    const release = await this.acquireRun()
    try {
      const checkpoint = await this.load()
      if (checkpoint === null) return
      const destination = join(this.directory, `checkpoint-before-${changeId}.json`)
      try { await lstat(destination); throw new Error('archived checkpoint already exists alongside an active checkpoint') }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await rename(this.path, destination)
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
    } finally { await release() }
  }
  private async acquireMarkerLock(): Promise<() => Promise<void>> {
    let handle
    try {
      handle = await open(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch {
      throw new Error('development run lock is busy')
    }
    let identity: { readonly dev: number; readonly ino: number }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error('unsafe development run lock')
      identity = { dev: info.dev, ino: info.ino }
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }))
      await handle.sync()
    } catch (error: unknown) {
      await handle.close().catch(() => undefined)
      throw error
    }
    let released = false
    return async () => {
      if (released) return
      released = true
      await handle.close()
      try {
        const current = await lstat(this.lockPath)
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.dev === identity.dev && current.ino === identity.ino) await unlink(this.lockPath)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  private async ensureDirectory(): Promise<void> {
    for (const path of [join(this.root, '.backend-team'), this.directory]) {
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error('unsafe development checkpoint directory')
    }
  }
}
