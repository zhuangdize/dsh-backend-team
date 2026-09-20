import { link, mkdtemp, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { BackendTeamState, PolicyAction, PolicyContext, StateStore } from '@dsh-backend-team/contracts'
import { FileStateStore, StateRevisionConflictError } from '@dsh-backend-team/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalTokenService, canonicalActionDigest } from '../src/index.js'
import { __setApprovalTokenTestHooksForTest } from '../src/approval-token.js'

describe('ApprovalTokenService', () => {
  let workspaceRoot: string
  let store: FileStateStore
  let now: Date
  let context: PolicyContext
  const action: PolicyAction = { kind: 'install', packages: ['zod'] }

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-approval-token-'))
    store = new FileStateStore(workspaceRoot)
    await store.create(initialState(store.workspaceRoot))
    workspaceRoot = store.workspaceRoot
    context = workspaceContext(workspaceRoot)
    now = new Date('2026-08-25T00:00:00.000Z')
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('issues an opaque token while persisting only its SHA-256 secret digest', async () => {
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })

    const token = await service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })
    const persisted = (await store.load())!.approvalTokens[0]!

    expect(token).toMatch(/^dsh-at1\.token-123456789012\.[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(persisted)).not.toContain(token.split('.').at(-1)!)
    expect(persisted).toMatchObject({ tokenId: 'token-123456789012', kind: 'install', workspaceRoot, usedAt: null })
  })

  it.each([
    { kind: 'install' as const, action: { kind: 'install', packages: ['--global', 'zod'] } as PolicyAction },
    { kind: 'install' as const, action: { kind: 'command', executable: process.execPath, args: ['rm', '-rf', 'src'], cwd: '/tmp', env: {}, executionFingerprint: 'a'.repeat(64) } as PolicyAction },
    { kind: 'migration' as const, action: { kind: 'database', connectionString: 'postgres://x@prod.example.com/db' } as PolicyAction },
  ])('refuses to issue a token unless the authoritative policy asks for its kind: %#', async ({ kind, action: candidate }) => {
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    await expect(service.issue({ kind, workspaceRoot, context, action: candidate, expiresAt: '2026-08-25T00:01:00.000Z' })).rejects.toThrow(/approval/)
    expect((await store.load())!.approvalTokens).toHaveLength(0)
  })

  it('consumes a matching token exactly once', async () => {
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    const token = await service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })

    await expect(service.consume(token, { kind: 'install', workspaceRoot, context, action })).resolves.toBe(true)
    await expect(service.consume(token, { kind: 'install', workspaceRoot, context, action })).resolves.toBe(false)
    expect((await store.load())!.approvalTokens[0]!.usedAt).toBe('2026-08-25T00:00:00.000Z')
  })

  it('rejects token reuse across action scope, workspace, kind, or expiry', async () => {
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    const token = await service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })

    await expect(service.consume(token, { kind: 'install', workspaceRoot, context, action: { kind: 'install', packages: ['other'] } })).resolves.toBe(false)
    await expect(service.consume(token, { kind: 'migration', workspaceRoot, context, action })).resolves.toBe(false)
    now = new Date('2026-08-25T00:02:00.000Z')
    await expect(service.consume(token, { kind: 'install', workspaceRoot, context, action })).resolves.toBe(false)
  })

  it('does not advance state when a token does not match its requested scope', async () => {
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    const token = await service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })
    const revision = (await store.load())!.revision

    await expect(service.consume(token, { kind: 'install', workspaceRoot, context, action: { kind: 'install', packages: ['different'] } })).resolves.toBe(false)
    expect((await store.load())!.revision).toBe(revision)
  })

  it('allows only one concurrent consume to mark the durable record used', async () => {
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    const token = await service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => service.consume(token, { kind: 'install', workspaceRoot, context, action })))
    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })

  it.each([
    'dsh-at1.token-123456789012.not-base64',
    'dsh-at1.bad.id.with.extra.parts',
    'dsh-at1.token-123456789012.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ])('rejects malformed opaque token without touching state: %s', async (token) => {
    const revision = (await store.load())!.revision
    const service = new ApprovalTokenService(store, { now: () => now })

    await expect(service.consume(token, { kind: 'install', workspaceRoot, context, action })).resolves.toBe(false)
    expect((await store.load())!.revision).toBe(revision)
  })

  it('parses malformed tokens before any workspace or state I/O', async () => {
    const noIoStore = { load: async () => { throw new Error('state accessed') }, create: async () => undefined, transact: async () => undefined }
    const service = new ApprovalTokenService(noIoStore as unknown as StateStore)
    const missingContext = workspaceContext('/does/not/exist')
    await expect(service.consume('not-a-token', { kind: 'install', workspaceRoot: '/does/not/exist', context: missingContext, action })).resolves.toBe(false)
    const command: PolicyAction = { kind: 'command', executable: '/does/not/exist', args: [], cwd: '/does/not/exist', env: {}, executionFingerprint: 'a'.repeat(64) }
    await expect(service.executeApprovedCommand('not-a-token', { kind: 'install', workspaceRoot: '/does/not/exist', context: missingContext, action: command }, async () => undefined)).resolves.toBeNull()
  })

  it('rejects a valid-format token with malformed use input before filesystem or state I/O', async () => {
    const noIoStore = { load: async () => { throw new Error('state accessed') }, create: async () => undefined, transact: async () => undefined }
    const service = new ApprovalTokenService(noIoStore as unknown as StateStore)
    const token = `dsh-at1.token-123456789012.${'A'.repeat(43)}`
    await expect(service.consume(token, { kind: 'install', workspaceRoot: '/does/not/exist', context: {} as PolicyContext, action: {} as PolicyAction })).resolves.toBe(false)
    const malformedCommand = { kind: 'command', executable: '/does/not/exist' } as PolicyAction
    await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot: '/does/not/exist', context: {} as PolicyContext, action: malformedCommand }, async () => undefined)).resolves.toBeNull()
  })

  it('rejects non-canonical token IDs and timestamps at issuance', async () => {
    const invalidId = new ApprovalTokenService(store, { now: () => now, tokenId: () => 'bad.id', randomBytes: () => Buffer.alloc(32, 7) })
    await expect(invalidId.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })).rejects.toThrow(/token id/)

    const service = new ApprovalTokenService(store, { now: () => now, tokenId: () => 'token-123456789012', randomBytes: () => Buffer.alloc(32, 7) })
    await expect(service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T08:01:00+08:00' })).rejects.toThrow(/timestamp/)
  })

  it('treats exact expiry as expired', async () => {
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    const future = new Date('2026-08-25T00:01:00.000Z')
    const token = await service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: future.toISOString() })
    now = future
    const revision = (await store.load())!.revision

    await expect(service.consume(token, { kind: 'install', workspaceRoot, context, action })).resolves.toBe(false)
    expect((await store.load())!.revision).toBe(revision)
  })

  it('persists concurrent issuances through CAS retry', async () => {
    let serial = 0
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => `token-${String(++serial).padStart(12, '0')}` })
    await Promise.all([service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' }), service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })])

    expect((await store.load())!.approvalTokens).toHaveLength(2)
  })

  it('waits through a burst of transient lock contention instead of denying issuance', async () => {
    let attempts = 0
    const transientStore = {
      load: async () => initialState(workspaceRoot),
      create: async () => undefined,
      transact: async () => {
        attempts += 1
        if (attempts <= 64) {
          const error = new Error('lock is busy') as NodeJS.ErrnoException
          error.code = 'EEXIST'
          throw error
        }
        return initialState(workspaceRoot)
      },
    }
    const service = new ApprovalTokenService(transientStore, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })

    await expect(service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })).resolves.toMatch(/^dsh-at1\./)
    expect(attempts).toBe(65)
  })

  it('propagates retry exhaustion instead of reporting an operational error as denial', async () => {
    const failingStore = {
      load: async () => initialState(workspaceRoot),
      create: async () => undefined,
      transact: async () => { throw new StateRevisionConflictError(0, 1) },
    }
    const service = new ApprovalTokenService(failingStore, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })

    await expect(service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })).rejects.toBeInstanceOf(StateRevisionConflictError)
  })

  it('treats another real workspace as a scope mismatch rather than an infrastructure failure', async () => {
    const otherWorkspace = await mkdtemp(join(tmpdir(), 'dsh-approval-token-other-'))
    try {
      const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
      const token = await service.issue({ kind: 'install', workspaceRoot, context, action, expiresAt: '2026-08-25T00:01:00.000Z' })
      await expect(service.consume(token, { kind: 'install', workspaceRoot: otherWorkspace, context: workspaceContext(otherWorkspace), action })).resolves.toBe(false)
    } finally { await rm(otherWorkspace, { recursive: true, force: true }) }
  })

  it('binds command token scope to resolved executable, canonical cwd, args, and complete env', async () => {
    const executable = join(workspaceRoot, 'npm')
    await writeFile(executable, 'reviewed npm')
    const command: PolicyAction = { kind: 'command', executable, args: ['install', 'zod'], cwd: workspaceRoot, env: { MODE: 'test' }, executionFingerprint: 'a'.repeat(64) }
    const changedEnv: PolicyAction = { ...command, env: { MODE: 'production' } }
    expect(await canonicalActionDigest(command, workspaceRoot)).not.toBe(await canonicalActionDigest(changedEnv, workspaceRoot))

    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    const token = await service.issue({ kind: 'install', workspaceRoot, context, action: command, expiresAt: '2026-08-25T00:01:00.000Z' })
    await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: changedEnv }, async () => undefined)).resolves.toBeNull()
  })

  it('requires command approvals to produce frozen execution evidence instead of a boolean consume', async () => {
    const executable = join(workspaceRoot, 'npm')
    await writeFile(executable, 'reviewed npm')
    const command: PolicyAction = { kind: 'command', executable, args: ['install', 'zod'], cwd: workspaceRoot, env: { MODE: 'test' }, executionFingerprint: 'a'.repeat(64) }
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    const token = await service.issue({ kind: 'install', workspaceRoot, context, action: command, expiresAt: '2026-08-25T00:01:00.000Z' })

    await expect(service.consume(token, { kind: 'install', workspaceRoot, context, action: command })).rejects.toThrow(/execution evidence/)
    const evidence = await service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, async (value) => value)
    expect(evidence).toMatchObject({ canonicalExecutable: executable, canonicalCwd: workspaceRoot, args: ['install', 'zod'], env: { MODE: 'test' }, executionFingerprint: 'a'.repeat(64) })
    expect(Object.isFrozen(evidence)).toBe(true)
    await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, async () => undefined)).resolves.toBeNull()
  })

  it('rejects a command token after the reviewed executable content changes', async () => {
    const executable = join(workspaceRoot, 'npm')
    await writeFile(executable, 'reviewed-v1')
    const command: PolicyAction = { kind: 'command', executable, args: ['install', 'zod'], cwd: workspaceRoot, env: {}, executionFingerprint: 'b'.repeat(64) }
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    const token = await service.issue({ kind: 'install', workspaceRoot, context, action: command, expiresAt: '2026-08-25T00:01:00.000Z' })
    await writeFile(executable, 'replaced-after-review')

    await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, async () => undefined)).resolves.toBeNull()
    expect((await store.load())!.approvalTokens[0]!.usedAt).toBeNull()
  })

  it('rejects a policy-recognized executable replaced by a FIFO without consuming its token', async () => {
    const { service, token, executable, command } = await issueNpmCommand()
    const revision = (await store.load())!.revision
    await rm(executable)
    await promisify(execFileCallback)('mkfifo', [executable])
    const callback = vi.fn()

    await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, callback)).rejects.toThrow(/regular file/)
    expect(callback).not.toHaveBeenCalled()
    expect((await store.load())!).toMatchObject({ revision, approvalTokens: [{ usedAt: null }] })
  })

  it('rejects a policy-recognized hard-linked executable without consuming its token', async () => {
    const { service, token, executable, command } = await issueNpmCommand()
    const revision = (await store.load())!.revision
    await link(executable, join(workspaceRoot, 'npm-copy'))
    const callback = vi.fn()

    await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, callback)).rejects.toThrow(/regular file/)
    expect(callback).not.toHaveBeenCalled()
    expect((await store.load())!).toMatchObject({ revision, approvalTokens: [{ usedAt: null }] })
  })

  it('rejects a symlink replacement as a changed command scope without consuming its token', async () => {
    const { service, token, executable, command } = await issueNpmCommand()
    const revision = (await store.load())!.revision
    const moved = join(workspaceRoot, 'npm-reviewed')
    await rename(executable, moved)
    await symlink(moved, executable)
    const callback = vi.fn()

    await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, callback)).resolves.toBeNull()
    expect(callback).not.toHaveBeenCalled()
    expect((await store.load())!).toMatchObject({ revision, approvalTokens: [{ usedAt: null }] })
  })

  it('detects a pathname swap after opening the executable and before consuming its token', async () => {
    const executable = join(workspaceRoot, 'npm')
    const moved = join(workspaceRoot, 'npm-opened')
    const restoreHooks = __setApprovalTokenTestHooksForTest({
      afterCommandOpen: async () => {
        await rename(executable, moved)
        await writeFile(executable, 'replacement npm')
      },
    })
    try {
      const { service, token, command } = await issueNpmCommand(executable)
      const revision = (await store.load())!.revision
      const callback = vi.fn()

      await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, callback)).resolves.toBeNull()
      expect(callback).not.toHaveBeenCalled()
      expect((await store.load())!).toMatchObject({ revision, approvalTokens: [{ usedAt: null }] })
    } finally {
      restoreHooks()
    }
  })

  it('detects an in-place content overwrite after opening the executable and before consuming its token', async () => {
    const executable = join(workspaceRoot, 'npm')
    const restoreHooks = __setApprovalTokenTestHooksForTest({ afterCommandOpen: async () => { await writeFile(executable, 'unreviewed replacement content') } })
    try {
      const { service, token, command } = await issueNpmCommand(executable)
      const revision = (await store.load())!.revision
      const callback = vi.fn()

      await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, callback)).resolves.toBeNull()
      expect(callback).not.toHaveBeenCalled()
      expect((await store.load())!).toMatchObject({ revision, approvalTokens: [{ usedAt: null }] })
    } finally {
      restoreHooks()
    }
  })

  it('closes the retained executable handle after the approved callback finishes', async () => {
    let retained: FileHandle | undefined
    const restoreHooks = __setApprovalTokenTestHooksForTest({ afterCommandOpen: async (handle) => { retained = handle } })
    try {
      const { service, token, command } = await issueNpmCommand()
      await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, async () => 'done')).resolves.toBe('done')
      await expect(retained!.stat()).rejects.toMatchObject({ code: 'EBADF' })
    } finally {
      restoreHooks()
    }
  })

  it('retries one executable-handle close failure and then succeeds', async () => {
    const first = new Error('first close failed')
    let closeCalls = 0
    const restoreHooks = __setApprovalTokenTestHooksForTest({
      afterCommandOpen: async (handle) => {
        const originalClose = handle.close.bind(handle)
        handle.close = vi.fn(async () => {
          closeCalls += 1
          if (closeCalls === 1) throw first
          await originalClose()
        })
      },
    })
    try {
      const { service, token, command } = await issueNpmCommand()
      await expect(service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, async () => 'done')).resolves.toBe('done')
      expect(closeCalls).toBe(2)
    } finally {
      restoreHooks()
    }
  })

  it('preserves both close failures after a successful command callback', async () => {
    const first = new Error('first close failed')
    const second = new Error('second close failed')
    let originalClose: (() => Promise<void>) | undefined
    let closeCalls = 0
    const restoreHooks = __setApprovalTokenTestHooksForTest({
      afterCommandOpen: async (handle) => {
        originalClose = handle.close.bind(handle)
        handle.close = vi.fn(async () => { closeCalls += 1; throw closeCalls === 1 ? first : second })
      },
    })
    try {
      const { service, token, command } = await issueNpmCommand()
      let caught: unknown
      try { await service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, async () => 'done') } catch (error: unknown) { caught = error }
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).errors).toEqual([first, second])
      expect(closeCalls).toBe(2)
    } finally {
      await originalClose?.()
      restoreHooks()
    }
  })

  it('preserves callback and both close failures together', async () => {
    const primary = new Error('callback failed')
    const first = new Error('first close failed')
    const second = new Error('second close failed')
    let originalClose: (() => Promise<void>) | undefined
    let closeCalls = 0
    const restoreHooks = __setApprovalTokenTestHooksForTest({
      afterCommandOpen: async (handle) => {
        originalClose = handle.close.bind(handle)
        handle.close = vi.fn(async () => { closeCalls += 1; throw closeCalls === 1 ? first : second })
      },
    })
    try {
      const { service, token, command } = await issueNpmCommand()
      let caught: unknown
      try { await service.executeApprovedCommand(token, { kind: 'install', workspaceRoot, context, action: command }, async () => { throw primary }) } catch (error: unknown) { caught = error }
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).errors).toEqual([primary, first, second])
      expect(closeCalls).toBe(2)
    } finally {
      await originalClose?.()
      restoreHooks()
    }
  })

  it('rejects command token issuance for a bare executable or cwd outside the workspace', async () => {
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    await expect(service.issue({ kind: 'install', workspaceRoot, context, action: { kind: 'command', executable: 'node', args: [], cwd: workspaceRoot, env: {}, executionFingerprint: 'a'.repeat(64) }, expiresAt: '2026-08-25T00:01:00.000Z' })).rejects.toThrow()
    await expect(service.issue({ kind: 'install', workspaceRoot, context, action: { kind: 'command', executable: process.execPath, args: [], cwd: '/tmp', env: {}, executionFingerprint: 'a'.repeat(64) }, expiresAt: '2026-08-25T00:01:00.000Z' })).rejects.toThrow()
  })

  async function issueNpmCommand(executable = join(workspaceRoot, 'npm')): Promise<{ service: ApprovalTokenService; token: string; executable: string; command: Extract<PolicyAction, { kind: 'command' }> }> {
    await writeFile(executable, 'reviewed npm')
    const command: Extract<PolicyAction, { kind: 'command' }> = { kind: 'command', executable, args: ['install', 'zod'], cwd: workspaceRoot, env: {}, executionFingerprint: 'd'.repeat(64) }
    const service = new ApprovalTokenService(store, { now: () => now, randomBytes: () => Buffer.alloc(32, 7), tokenId: () => 'token-123456789012' })
    const token = await service.issue({ kind: 'install', workspaceRoot, context, action: command, expiresAt: '2026-08-25T00:01:00.000Z' })
    return { service, token, executable, command }
  }
})

function initialState(workspaceRoot: string): BackendTeamState {
  return { schemaVersion: 1, revision: 0, workspaceRoot, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] }
}

function workspaceContext(root: string): PolicyContext {
  return { workspace: { root, teamDir: join(root, '.backend-team'), stateDir: join(root, '.backend-team/state'), runtimeDir: join(root, '.backend-team/runtime'), cacheDir: join(root, '.backend-team/cache'), logsDir: join(root, '.backend-team/logs'), locksDir: join(root, '.backend-team/locks'), handoffDir: join(root, '.backend-team/handoff') }, phase: 'BUILD' }
}
