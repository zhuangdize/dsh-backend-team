import { link, mkdtemp, mkdir, open, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { PolicyContext } from '@dsh-backend-team/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DefaultPolicyEngine } from '../src/index.js'

describe('owned write capabilities', () => {
  let workspaceRoot: string
  let outsideRoot: string
  let context: PolicyContext

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-policy-capability-'))
    outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-policy-capability-outside-'))
    await mkdir(join(workspaceRoot, 'src'))
    await writeFile(join(workspaceRoot, 'src', 'owned.ts'), 'inside')
    await writeFile(join(outsideRoot, 'outside.ts'), 'outside')
    context = { workspace: layout(workspaceRoot), phase: 'BUILD' }
  })

  afterEach(async () => { await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(outsideRoot, { recursive: true, force: true })]) })

  it('binds an existing owned regular file to a one-shot open handle', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    await expect(engine.enforce({ kind: 'write', targetPath: 'src/owned.ts' }, context)).rejects.toMatchObject({ decision: { effect: 'deny' } })
    await engine.executeApprovedWrite({ kind: 'write', targetPath: 'src/owned.ts' }, context, async (handle) => { await handle.writeFile('updated') })
    expect(await readFile(join(workspaceRoot, 'src', 'owned.ts'), 'utf8')).toBe('updated')
  })

  it('binds an approved read to an existing verified file handle', async () => {
    const engine = new DefaultPolicyEngine()
    await expect(engine.enforce({ kind: 'read', targetPath: 'src/owned.ts' }, context)).rejects.toMatchObject({ decision: { effect: 'deny' } })
    const value = await engine.executeApprovedRead({ kind: 'read', targetPath: 'src/owned.ts' }, context, async (handle) => handle.readFile('utf8'))
    expect(value).toBe('inside')
  })

  it('rejects a read hardlink to outside content before invoking the callback', async () => {
    await rm(join(workspaceRoot, 'src', 'owned.ts'))
    await link(join(outsideRoot, 'outside.ts'), join(workspaceRoot, 'src', 'owned.ts'))
    const callback = async () => { throw new Error('must not read') }
    await expect(new DefaultPolicyEngine().executeApprovedRead({ kind: 'read', targetPath: 'src/owned.ts' }, context, callback)).rejects.toMatchObject({ decision: { effect: 'deny' } })
    expect(await readFile(join(outsideRoot, 'outside.ts'), 'utf8')).toBe('outside')
  })

  it('rejects a write hardlink to outside content before invoking the callback', async () => {
    await rm(join(workspaceRoot, 'src', 'owned.ts'))
    await link(join(outsideRoot, 'outside.ts'), join(workspaceRoot, 'src', 'owned.ts'))
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    await expect(engine.executeApprovedWrite({ kind: 'write', targetPath: 'src/owned.ts' }, context, async () => { throw new Error('must not write') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    expect(await readFile(join(outsideRoot, 'outside.ts'), 'utf8')).toBe('outside')
  })

  it('closes a read handle after callback failure', async () => {
    const engine = new DefaultPolicyEngine()
    let captured: import('node:fs/promises').FileHandle | undefined
    await expect(engine.executeApprovedRead({ kind: 'read', targetPath: 'src/owned.ts' }, context, async (handle) => { captured = handle; throw new Error('read callback failed') })).rejects.toThrow('read callback failed')
    await expect(captured!.stat()).rejects.toThrow()
  })

  it('closes a write handle after callback failure', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    let captured: import('node:fs/promises').FileHandle | undefined
    await expect(engine.executeApprovedWrite({ kind: 'write', targetPath: 'src/owned.ts' }, context, async (handle) => { captured = handle; throw new Error('write callback failed') })).rejects.toThrow('write callback failed')
    await expect(captured!.stat()).rejects.toThrow()
  })

  it.each(['read', 'write'] as const)('retries a first injected close failure and preserves a callback failure: %s', async (kind) => {
    const engine = kind === 'write' ? new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } }) : new DefaultPolicyEngine()
    let captured: import('node:fs/promises').FileHandle | undefined
    const operation = async (handle: import('node:fs/promises').FileHandle) => {
      captured = handle
      const close = handle.close.bind(handle)
      let attempts = 0
      Object.assign(handle, { close: async () => { attempts += 1; if (attempts === 1) throw new Error('injected close failure'); return close() } })
      throw 'callback-primary'
    }
    const request = { kind, targetPath: 'src/owned.ts' } as const
    const execute = kind === 'read' ? engine.executeApprovedRead(request, context, operation) : engine.executeApprovedWrite(request, context, operation)
    await expect(execute).rejects.toBe('callback-primary')
    await expect(captured!.stat()).rejects.toThrow()
  })

  it('preserves a non-Error callback primary alongside repeated close cleanup failures', async () => {
    const engine = new DefaultPolicyEngine()
    let captured: import('node:fs/promises').FileHandle | undefined
    const outcome = engine.executeApprovedRead({ kind: 'read', targetPath: 'src/owned.ts' }, context, async (handle) => {
      captured = handle
      const close = handle.close.bind(handle)
      Object.assign(handle, { close: async () => { await close(); throw new Error('post-close cleanup failure') } })
      throw 'non-error-primary'
    })
    await expect(outcome).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.includes('non-error-primary'))
    await expect(captured!.stat()).rejects.toThrow()
  })

  it('rejects FIFO reads promptly without invoking the callback', async () => {
    const fifo = join(workspaceRoot, 'src', 'read.fifo')
    await createFifo(fifo)
    let called = false
    await expect(withTimeout(new DefaultPolicyEngine().executeApprovedRead({ kind: 'read', targetPath: 'src/read.fifo' }, context, async () => { called = true }), 500)).rejects.toMatchObject({ decision: { effect: 'deny' } })
    expect(called).toBe(false)
  })

  it('rejects FIFO writes promptly without invoking the callback', async () => {
    const fifo = join(workspaceRoot, 'src', 'write.fifo')
    await createFifo(fifo)
    let called = false
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    await expect(withTimeout(engine.executeApprovedWrite({ kind: 'write', targetPath: 'src/write.fifo' }, context, async () => { called = true }), 500)).rejects.toMatchObject({ decision: { effect: 'deny' } })
    expect(called).toBe(false)
  })

  it('denies a missing owned path until descriptor-relative creation exists', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    expect((await engine.authorize({ kind: 'write', targetPath: 'src/new.ts' }, context)).effect).toBe('deny')
  })

  it('rejects a swap before open instead of obtaining a handle to outside content', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => { await rename(join(workspaceRoot, 'src', 'owned.ts'), join(workspaceRoot, 'src', 'saved.ts')); await symlink(join(outsideRoot, 'outside.ts'), join(workspaceRoot, 'src', 'owned.ts')); return true } } })
    await expect(engine.executeApprovedWrite({ kind: 'write', targetPath: 'src/owned.ts' }, context, async () => undefined)).rejects.toMatchObject({ decision: { effect: 'deny' } })
    expect(await readFile(join(outsideRoot, 'outside.ts'), 'utf8')).toBe('outside')
  })

  it('writes only the already-open original file after a post-open path swap', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    await engine.executeApprovedWrite({ kind: 'write', targetPath: 'src/owned.ts' }, context, async (handle) => {
      await rename(join(workspaceRoot, 'src', 'owned.ts'), join(workspaceRoot, 'src', 'saved.ts'))
      await symlink(join(outsideRoot, 'outside.ts'), join(workspaceRoot, 'src', 'owned.ts'))
      await handle.writeFile('updated')
    })
    expect(await readFile(join(workspaceRoot, 'src', 'saved.ts'), 'utf8')).toBe('updated')
    expect(await readFile(join(outsideRoot, 'outside.ts'), 'utf8')).toBe('outside')
  })

  it('denies owned create preflight without a host grant', async () => {
    const engine = new DefaultPolicyEngine()
    await expect(engine.preflightOwnedWrite({ kind: 'write', targetPath: 'src/new.ts' }, context)).resolves.toMatchObject({ effect: 'deny' })
    await expect(engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/new.ts' }, context, async () => { throw new Error('must not create') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
  })

  it('requires a fresh host grant at create time after the preflight', async () => {
    let granted = true
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => granted } })
    await expect(engine.preflightOwnedWrite({ kind: 'write', targetPath: 'src/new.ts' }, context)).resolves.toMatchObject({ effect: 'allow' })
    granted = false
    await expect(engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/new.ts' }, context, async () => { throw new Error('must not create') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    await expect(readFile(join(workspaceRoot, 'src', 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the host phase at the fresh grant check', async () => {
    let hostPhase: PolicyContext['phase'] = 'BUILD'
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async ({ phase }) => phase === hostPhase } })
    await expect(engine.preflightOwnedWrite({ kind: 'write', targetPath: 'src/new.ts' }, context)).resolves.toMatchObject({ effect: 'allow' })
    hostPhase = 'PLAN'
    await expect(engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/new.ts' }, context, async () => { throw new Error('must not create') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
  })

  it('never overwrites an existing create target', async () => {
    const target = join(workspaceRoot, 'src', 'owned.ts')
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    await expect(engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/owned.ts' }, context, async () => { throw new Error('must not create') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    expect(await readFile(target, 'utf8')).toBe('inside')
  })

  it('rejects symlink, hardlink, and escaped create targets', async () => {
    const symlinkTarget = join(workspaceRoot, 'src', 'symlink.ts')
    await symlink(join(outsideRoot, 'outside.ts'), symlinkTarget)
    const hardlinkTarget = join(workspaceRoot, 'src', 'hardlink.ts')
    await link(join(outsideRoot, 'outside.ts'), hardlinkTarget)
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    for (const targetPath of ['src/symlink.ts', 'src/hardlink.ts', '../outside.ts'] as const) {
      await expect(engine.executeApprovedCreate({ kind: 'write', targetPath }, context, async () => { throw new Error('must not create') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    }
    expect(await readFile(join(outsideRoot, 'outside.ts'), 'utf8')).toBe('outside')
  })

  it('rejects a symlinked parent that resolves outside the workspace', async () => {
    await symlink(outsideRoot, join(workspaceRoot, 'src', 'outside-link'))
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    await expect(engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/outside-link/new.ts' }, context, async () => { throw new Error('must not create') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    await expect(readFile(join(outsideRoot, 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an in-workspace symlinked parent instead of changing its canonical target', async () => {
    await mkdir(join(workspaceRoot, 'real-src'))
    await symlink(join(workspaceRoot, 'real-src'), join(workspaceRoot, 'src', 'alias'))
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    await expect(engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/alias/new.ts' }, context, async () => { throw new Error('must not create') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    await expect(readFile(join(workspaceRoot, 'real-src', 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes only the newly created inode after callback failure', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    let captured: import('node:fs/promises').FileHandle | undefined
    await expect(engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/new.ts' }, context, async (handle) => { captured = handle; await handle.writeFile('partial'); throw new Error('create callback failed') })).rejects.toThrow('create callback failed')
    await expect(readFile(join(workspaceRoot, 'src', 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(captured!.stat()).rejects.toThrow()
  })

  it('reports refused cleanup when the callback moves the parent and replaces its path', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    const movedParent = join(outsideRoot, 'moved-src')
    const outcome = engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/new.ts' }, context, async (handle) => {
      await handle.writeFile('moved')
      await rename(join(workspaceRoot, 'src'), movedParent)
      await mkdir(join(workspaceRoot, 'src'))
      throw new Error('parent move callback failed')
    })
    await expect(outcome).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors.some((entry) => entry instanceof Error && entry.message === 'parent move callback failed') && error.errors.some((entry) => entry instanceof Error && /cleanup refused/iu.test(entry.message)))
    expect(await readFile(join(movedParent, 'new.ts'), 'utf8')).toBe('moved')
  })

  it('does not report cleanup failure when the callback already deletes its inode', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    const target = join(workspaceRoot, 'src', 'new.ts')
    const outcome = engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/new.ts' }, context, async (handle) => {
      await handle.writeFile('deleted')
      await unlink(target)
      throw new Error('delete callback failed')
    })
    await expect(outcome).rejects.toSatisfy((error: unknown) => error instanceof Error && !(error instanceof AggregateError) && error.message === 'delete callback failed')
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries a failed initial stat and cleans the created inode by descriptor identity', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    const probe = await open(join(workspaceRoot, 'src', 'owned.ts'))
    const prototype = Object.getPrototypeOf(probe) as import('node:fs/promises').FileHandle
    const originalStat = prototype.stat
    let injected = false
    const statSpy = vi.spyOn(prototype, 'stat').mockImplementation(function (this: import('node:fs/promises').FileHandle) {
      if (!injected && this.fd !== probe.fd) {
        injected = true
        return Promise.reject(new Error('injected initial stat failure'))
      }
      return originalStat.call(this)
    })
    try {
      await expect(engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/new.ts' }, context, async () => { throw new Error('must not create') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    } finally {
      statSpy.mockRestore()
      await probe.close()
    }
    expect(injected).toBe(true)
    await expect(readFile(join(workspaceRoot, 'src', 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates a new owned file and closes its handle on success', async () => {
    const engine = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    let captured: import('node:fs/promises').FileHandle | undefined
    await engine.executeApprovedCreate({ kind: 'write', targetPath: 'src/new.ts' }, context, async (handle) => { captured = handle; await handle.writeFile('created'); return 'done' })
    expect(await readFile(join(workspaceRoot, 'src', 'new.ts'), 'utf8')).toBe('created')
    await expect(captured!.stat()).rejects.toThrow()
  })
})

function layout(root: string): PolicyContext['workspace'] { return { root, teamDir: join(root, '.backend-team'), stateDir: join(root, '.backend-team/state'), runtimeDir: join(root, '.backend-team/runtime'), cacheDir: join(root, '.backend-team/cache'), logsDir: join(root, '.backend-team/logs'), locksDir: join(root, '.backend-team/locks'), handoffDir: join(root, '.backend-team/handoff') } }

const execFile = promisify(execFileCallback)
async function createFifo(path: string): Promise<void> {
  try { await execFile('mkfifo', [path]) } catch { throw new Error('macOS fixture setup failed: mkfifo is unavailable') }
}
async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('operation timed out')), milliseconds) })]) } finally { if (timer !== undefined) clearTimeout(timer) }
}
