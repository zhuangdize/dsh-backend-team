import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendTeamState, CommandRequest, PolicyContext, PolicyDecision } from '@dsh-backend-team/contracts'
import { FileStateStore } from '@dsh-backend-team/core'
import { ApprovalTokenService, DefaultPolicyEngine } from '@dsh-backend-team/policy-engine'
import { describe, expect, it, vi } from 'vitest'
import { NodeCommandRunner, type ApprovalCommandExecutor } from '../src/node-command-runner.js'
import { createWorkspaceLayout, initializeWorkspaceLayout } from '../src/workspace-layout.js'

const context: PolicyContext = { phase: 'BUILD', workspace: { root: process.cwd(), teamDir: `${process.cwd()}/.backend-team`, stateDir: `${process.cwd()}/.backend-team/state`, runtimeDir: `${process.cwd()}/.backend-team/runtime`, cacheDir: `${process.cwd()}/.backend-team/cache`, logsDir: `${process.cwd()}/.backend-team/logs`, locksDir: `${process.cwd()}/.backend-team/locks`, handoffDir: `${process.cwd()}/.backend-team/handoff` } }
const request: CommandRequest = { executable: process.execPath, args: ['-e', ''], cwd: process.cwd(), env: { NODE_ENV: 'test' }, purpose: 'install dependencies', risk: 'install', executionFingerprint: 'a'.repeat(64), approvalToken: 'token' }

describe('NodeCommandRunner', () => {
  it('rejects a policy denial before any token or process execution', async () => {
    const execute = vi.fn()
    const runner = new NodeCommandRunner({ context, policyEngine: { authorize: async () => ({ effect: 'deny', ruleId: 'deny', reason: 'blocked' }) }, approvalTokens: { executeApprovedCommand: execute } })
    await expect(runner.run(request)).rejects.toThrow(/policy deny/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an approval request without a token before execution', async () => {
    const execute = vi.fn()
    const ask: PolicyDecision = { effect: 'ask', ruleId: 'ask', reason: 'needs approval', approvalKind: 'install' }
    const runner = new NodeCommandRunner({ context, policyEngine: { authorize: async () => ask }, approvalTokens: { executeApprovedCommand: execute } })
    const { approvalToken: _ignored, ...withoutToken } = request
    void _ignored
    await expect(runner.run(withoutToken)).rejects.toThrow(/approval token/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('executes only inside the token callback with shell disabled and explicit process controls', async () => {
    let callbackReturned = false
    const policy = { authorize: vi.fn(async () => ({ effect: 'ask' as const, ruleId: 'ask', reason: 'needs approval', approvalKind: 'install' as const })) }
    const approvalTokens = { executeApprovedCommand: async <T>(_token: string, _input: unknown, callback: (evidence: { canonicalExecutable: string; executableContentDigest: string; args: readonly string[]; canonicalCwd: string; env: Readonly<Record<string, string>>; executionFingerprint: string }) => Promise<T>) => { const result = await callback({ canonicalExecutable: request.executable, executableContentDigest: 'a'.repeat(64), args: request.args, canonicalCwd: request.cwd, env: request.env, executionFingerprint: request.executionFingerprint }); callbackReturned = true; return result } } as unknown as ApprovalCommandExecutor
    const executor = vi.fn(async (_executable: string, _args: readonly string[], options: { shell: boolean; cwd: string; env: Readonly<Record<string, string>>; signal?: AbortSignal; maxBuffer: number; networkPolicy: 'allow' | 'deny' }) => { expect(callbackReturned).toBe(false); expect(options.shell).toBe(false); expect(options.cwd).toBe(request.cwd); expect(options.env).toEqual(request.env); expect(options.networkPolicy).toBe('allow'); expect(options).toHaveProperty('signal'); expect(options.maxBuffer).toBeGreaterThan(0); return { exitCode: 0, stdout: 'ok', stderr: '' } })
    const runner = new NodeCommandRunner({ context, policyEngine: policy, approvalTokens, executor })
    await expect(runner.run(request, new AbortController().signal)).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' })
    expect(policy.authorize).toHaveBeenCalledOnce()
    expect(executor).toHaveBeenCalledWith(request.executable, request.args, expect.objectContaining({ shell: false, cwd: request.cwd, env: request.env }))
  })

  it('returns an explicit output-limit result when the executor reports overflow', async () => {
    const ask: PolicyDecision = { effect: 'ask', ruleId: 'ask', reason: 'needs approval', approvalKind: 'install' }
    const runner = new NodeCommandRunner({ context, policyEngine: { authorize: async () => ask }, approvalTokens: { executeApprovedCommand: async (_token, _input, callback) => callback({ canonicalExecutable: request.executable, executableContentDigest: 'a'.repeat(64), args: request.args, canonicalCwd: request.cwd, env: request.env, executionFingerprint: request.executionFingerprint }) }, executor: async () => { const error = Object.assign(new Error('max'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'partial', stderr: '' }); throw error } })
    await expect(runner.run(request)).resolves.toMatchObject({ exitCode: -1, outputLimitExceeded: true, stdout: 'partial' })
  })

  it('runs an install command only through an active install-session capability', async () => {
    const executor = vi.fn(async (_executable: string, _args: readonly string[], options: { networkPolicy: 'allow' | 'deny' }) => { expect(options.networkPolicy).toBe('deny'); return { exitCode: 0, stdout: 'session', stderr: '' } })
    const session = {
      executeApprovedInstallCommand: async <T>(command: { executable: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; executionFingerprint: string; codeWillExecute: boolean }, callback: (evidence: { canonicalExecutable: string; executableContentDigest: string; canonicalCwd: string; args: readonly string[]; env: Readonly<Record<string, string>>; executionFingerprint: string }) => Promise<T>) => callback({ canonicalExecutable: command.executable, executableContentDigest: 'b'.repeat(64), canonicalCwd: command.cwd, args: command.args, env: command.env, executionFingerprint: command.executionFingerprint }),
    }
    const runner = new NodeCommandRunner({
      context,
      policyEngine: { authorize: async () => { throw new Error('policy must not be bypassed') } },
      approvalTokens: { executeApprovedCommand: async () => { throw new Error('token must not be bypassed') } },
      executor,
    })

    const { approvalToken: _approvalToken, ...untrustedRequest } = request
    void _approvalToken
    await expect(runner.runApprovedInstall(session, { ...untrustedRequest, codeWillExecute: true, networkPolicy: 'deny' })).resolves.toMatchObject({ exitCode: 0, stdout: 'session' })
    expect(executor).toHaveBeenCalledOnce()
  })

  it.runIf(process.platform === 'darwin')('enforces deny-network with the macOS process sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runner-network-sandbox-'))
    try {
      const executable = process.execPath
      const args = ['-e', "const net=require('node:net');const socket=net.connect({host:'127.0.0.1',port:1});socket.on('connect',()=>process.exit(41));socket.on('error',(error)=>{if(error.code==='EPERM'||error.code==='EACCES')process.exit(0);process.stderr.write(String(error.code));process.exit(42)})"]
      const session = {
        executeApprovedInstallCommand: async <T>(command: { executable: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; executionFingerprint: string }, callback: (evidence: { canonicalExecutable: string; executableContentDigest: string; canonicalCwd: string; args: readonly string[]; env: Readonly<Record<string, string>>; executionFingerprint: string }) => Promise<T>) => callback({ canonicalExecutable: command.executable, executableContentDigest: 'b'.repeat(64), canonicalCwd: command.cwd, args: command.args, env: command.env, executionFingerprint: command.executionFingerprint }),
      }
      const runner = new NodeCommandRunner({ context, policyEngine: { authorize: async () => { throw new Error('unused') } }, approvalTokens: { executeApprovedCommand: async () => { throw new Error('unused') } } })

      await expect(runner.runApprovedInstall(session, { executable, args, cwd: root, env: {}, purpose: 'prove process-level network denial', risk: 'install', executionFingerprint: '9'.repeat(64), codeWillExecute: true, networkPolicy: 'deny' })).resolves.toMatchObject({ exitCode: 0 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('snapshots an install-session request before a delayed capability reaches spawn', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executor = vi.fn(async (_executable: string, args: readonly string[], options: { env: Readonly<Record<string, string>> }) => ({ exitCode: 0, stdout: JSON.stringify({ args, env: options.env }), stderr: '' }))
    const session = { executeApprovedInstallCommand: async <T>(command: { executable: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; executionFingerprint: string; codeWillExecute: boolean }, callback: (evidence: { canonicalExecutable: string; executableContentDigest: string; canonicalCwd: string; args: readonly string[]; env: Readonly<Record<string, string>>; executionFingerprint: string }) => Promise<T>) => { await gate; return callback({ canonicalExecutable: command.executable, executableContentDigest: 'c'.repeat(64), canonicalCwd: command.cwd, args: command.args, env: command.env, executionFingerprint: command.executionFingerprint }) } }
    const runner = new NodeCommandRunner({ context, policyEngine: { authorize: async () => { throw new Error('unused') } }, approvalTokens: { executeApprovedCommand: async () => { throw new Error('unused') } }, executor })
    const { approvalToken: _approvalToken, ...base } = request; void _approvalToken
    const mutable = { ...base, args: ['tool', 'install'], env: { UV_NO_SYNC: '1' }, codeWillExecute: true as const }
    const run = runner.runApprovedInstall(session, { ...mutable, networkPolicy: 'deny' })
    mutable.args = ['tool', 'evil']; mutable.env = { UV_NO_SYNC: '0' }
    release!()
    await expect(run).resolves.toMatchObject({ stdout: JSON.stringify({ args: ['tool', 'install'], env: { UV_NO_SYNC: '1' } }) })
  })

  it('uses a real durable approval token for a recognized local npm command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runner-real-token-'))
    try {
      const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
      const store = new FileStateStore(root)
      const initial: BackendTeamState = { schemaVersion: 1, revision: 0, workspaceRoot: store.workspaceRoot, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] }
      await store.create(initial)
      const executable = join(root, 'npm')
      await writeFile(executable, '#!/bin/sh\nprintf npm-fixture\n')
      await chmod(executable, 0o700)
      const context: PolicyContext = { phase: 'BUILD', workspace: layout }
      const action = { kind: 'command' as const, executable, args: ['install', 'zod'], cwd: root, env: { ONLY_THIS: 'yes' }, executionFingerprint: 'c'.repeat(64) }
      const service = new ApprovalTokenService(store, { now: () => new Date('2026-08-25T00:00:00.000Z'), randomBytes: () => Buffer.alloc(32, 3), tokenId: () => 'token-real-123456' })
      const token = await service.issue({ kind: 'install', workspaceRoot: root, context, action, expiresAt: '2026-08-25T00:10:00.000Z' })
      const executor = vi.fn(async (_executable: string, _args: readonly string[], options: { env: Readonly<Record<string, string>>; extendEnv?: boolean }) => { expect(options.env).toEqual(action.env); expect(options.extendEnv).toBe(false); return { exitCode: 0, stdout: 'npm-fixture', stderr: '' } })
      const runner = new NodeCommandRunner({ context, policyEngine: new DefaultPolicyEngine(), approvalTokens: service, executor })
      await expect(runner.run({ ...action, purpose: 'test', risk: 'install', approvalToken: token })).resolves.toMatchObject({ exitCode: 0, stdout: 'npm-fixture' })
      expect(executor).toHaveBeenCalledOnce()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not leak ambient environment and preserves nonzero results with real execa', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runner-execa-'))
    try {
      const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
      const store = new FileStateStore(root)
      await store.create({ schemaVersion: 1, revision: 0, workspaceRoot: store.workspaceRoot, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] })
      const executable = join(root, 'npm')
      await writeFile(executable, '#!/bin/sh\nprintf "$ONLY_THIS:$HOME"\nprintf fail >&2\nexit 7\n')
      await chmod(executable, 0o700)
      const context: PolicyContext = { phase: 'BUILD', workspace: layout }
      const action = { kind: 'command' as const, executable, args: ['install', 'zod'], cwd: root, env: { ONLY_THIS: 'yes' }, executionFingerprint: 'd'.repeat(64) }
      const service = new ApprovalTokenService(store, { now: () => new Date('2026-08-25T00:00:00.000Z'), randomBytes: () => Buffer.alloc(32, 4), tokenId: () => 'token-real-123457' })
      const token = await service.issue({ kind: 'install', workspaceRoot: root, context, action, expiresAt: '2026-08-25T00:10:00.000Z' })
      const runner = new NodeCommandRunner({ context, policyEngine: new DefaultPolicyEngine(), approvalTokens: service, maxBuffer: 1024 })
      await expect(runner.run({ ...action, purpose: 'test', risk: 'install', approvalToken: token })).resolves.toMatchObject({ exitCode: 7, stdout: 'yes:', stderr: 'fail' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('returns a bounded overflow result and propagates real cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runner-overflow-'))
    try {
      const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
      const store = new FileStateStore(root)
      await store.create({ schemaVersion: 1, revision: 0, workspaceRoot: store.workspaceRoot, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] })
      const executable = join(root, 'npm')
      await writeFile(executable, '#!/bin/sh\nprintf 1234567890123456789012345678901234567890\n')
      await chmod(executable, 0o700)
      const context: PolicyContext = { phase: 'BUILD', workspace: layout }
      let tokenSerial = 0
      const service = new ApprovalTokenService(store, { now: () => new Date('2026-08-25T00:00:00.000Z'), randomBytes: () => Buffer.alloc(32, 5), tokenId: () => `token-real-12345${++tokenSerial}` })
      const action = { kind: 'command' as const, executable, args: ['install', 'zod'], cwd: root, env: {}, executionFingerprint: 'e'.repeat(64) }
      const token = await service.issue({ kind: 'install', workspaceRoot: root, context, action, expiresAt: '2026-08-25T00:10:00.000Z' })
      const runner = new NodeCommandRunner({ context, policyEngine: new DefaultPolicyEngine(), approvalTokens: service, maxBuffer: 16 })
      await expect(runner.run({ ...action, purpose: 'overflow', risk: 'install', approvalToken: token })).resolves.toMatchObject({ outputLimitExceeded: true, exitCode: -1 })
      const abortAction = { ...action, args: ['install', 'abort'], executionFingerprint: 'f'.repeat(64) }
      const abortToken = await service.issue({ kind: 'install', workspaceRoot: root, context, action: abortAction, expiresAt: '2026-08-25T00:10:00.000Z' })
      const abortController = new AbortController()
      abortController.abort()
      await expect(runner.run({ ...abortAction, purpose: 'abort', risk: 'install', approvalToken: abortToken }, abortController.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
