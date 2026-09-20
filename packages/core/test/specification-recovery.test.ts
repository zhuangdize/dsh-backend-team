import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendTeamState, StateStore } from '@dsh-backend-team/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Canonical } from '../src/content-hash.js'
import { sha256WorkspaceTree } from '../src/workspace-tree.js'
import { SpecificationRecovery, type RecoveryArtifactRegistryPort } from '../src/specification-recovery.js'

describe('SpecificationRecovery', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('marks running work interrupted and resumes the last verified phase without repeating completed runtime work', async () => {
    const root = await fixtureRoot()
    const fixture = await createFixture(root, {
      phase: 'BUILD',
      runs: [{ id: 'build-1', status: 'running', startedAt: timestamp(0), completedAt: null, summary: 'implement API' }],
      approvals: [
        approval('requirements', 'spec.md', 'a'),
        approval('design', 'architecture.md', 'b'),
      ],
    })
    const recovery = new SpecificationRecovery({ stateStore: fixture.store, workspaceRoot: fixture.root, artifactRegistry: fixture.registry })

    const audit = await recovery.audit()
    expect(audit).toMatchObject({ status: 'ready', lastVerifiedPhase: 'BUILD', interruptedRunIds: ['build-1'] })
    expect((await fixture.store.load())!.runs[0]).toMatchObject({ status: 'interrupted', completedAt: expect.any(String) })

    const resumed = await recovery.resumeFromLastVerified()
    expect(resumed.phase).toBe('BUILD')
    expect((await fixture.store.load())!.revision).toBe(1)
    expect((await recovery.audit()).interruptedRunIds).toEqual([])
  })

  it('blocks resume when an approved artifact hash is stale', async () => {
    const root = await fixtureRoot()
    const fixture = await createFixture(root, {
      phase: 'DESIGN',
      approvals: [approval('requirements', 'spec.md', 'a')],
    })
    fixture.registry.current = { 'spec.md': 'c'.repeat(64), 'architecture.md': 'b'.repeat(64) }
    const recovery = new SpecificationRecovery({ stateStore: fixture.store, workspaceRoot: fixture.root, artifactRegistry: fixture.registry })

    const audit = await recovery.audit()
    expect(audit.status).toBe('blocked')
    expect(audit.issues.map(({ code }) => code)).toContain('STALE_APPROVAL')
    await expect(recovery.resumeFromLastVerified()).rejects.toThrow(/stale|blocked/i)
  })

  it('blocks resume when a new artifact appears after approval', async () => {
    const root = await fixtureRoot()
    const fixture = await createFixture(root, { phase: 'DESIGN', approvals: [approval('requirements', 'spec.md', 'a')] })
    fixture.registry.current = { ...fixture.registry.current, 'new-artifact.md': 'c'.repeat(64) }
    const recovery = new SpecificationRecovery({ stateStore: fixture.store, workspaceRoot: fixture.root, artifactRegistry: fixture.registry })

    const audit = await recovery.audit()
    expect(audit.issues.map(({ code }) => code)).toContain('STALE_APPROVAL')
    expect(audit.staleApprovalPaths).toContain('new-artifact.md')
  })

  it('blocks recovery when a runtime executable changes after provenance was written', async () => {
    const root = await fixtureRoot()
    const fixture = await createFixture(root, { phase: 'SPECIFY' })
    await writeFile(join(root, '.backend-team', 'runtime', 'bin', 'uv'), 'tampered')
    const recovery = new SpecificationRecovery({ stateStore: fixture.store, workspaceRoot: fixture.root, artifactRegistry: fixture.registry })

    const audit = await recovery.audit()
    expect(audit.status).toBe('blocked')
    expect(audit.issues.map(({ code }) => code)).toContain('RUNTIME_PROVENANCE_INVALID')
  })

  it('does not reclaim a lock directory outside the workspace', async () => {
    const root = await fixtureRoot()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-specification-recovery-outside-locks-'))
    roots.push(outside)
    const outsideLocks = join(outside, 'locks')
    await mkdir(outsideLocks, { recursive: true })
    const lock = join(outsideLocks, 'runtime.lock')
    await writeFile(lock, JSON.stringify({ pid: 2147483647, nonce: 'outside-lock-nonce', workspaceRoot: await realpath(root) }), { mode: 0o600 })
    const fixture = await createFixture(root, { phase: 'SPECIFY' })
    const recovery = new SpecificationRecovery({ stateStore: fixture.store, workspaceRoot: fixture.root, artifactRegistry: fixture.registry, locksDirectory: outsideLocks })

    const audit = await recovery.audit()
    expect(audit.status).toBe('blocked')
    expect(audit.issues.map(({ code }) => code)).toContain('UNSAFE_RUNTIME_LOCK')
    await expect(access(lock)).resolves.toBeUndefined()
  })

  it('does not treat later design artifacts as a stale requirements approval', async () => {
    const root = await fixtureRoot()
    const fixture = await createFixture(root, { phase: 'DESIGN', approvals: [approval('requirements', 'spec.md', 'a')] })
    const recovery = new SpecificationRecovery({ stateStore: fixture.store, workspaceRoot: fixture.root, artifactRegistry: fixture.registry })

    const audit = await recovery.audit()
    expect(audit.status).toBe('ready')
    expect(audit.issues.map(({ code }) => code)).not.toContain('STALE_APPROVAL')
  })

  it('blocks a later phase when its required approval is missing instead of skipping the gate', async () => {
    const root = await fixtureRoot()
    const fixture = await createFixture(root, { phase: 'PLAN', approvals: [approval('requirements', 'spec.md', 'a')] })
    const recovery = new SpecificationRecovery({ stateStore: fixture.store, workspaceRoot: fixture.root, artifactRegistry: fixture.registry })

    const audit = await recovery.audit()
    expect(audit.status).toBe('blocked')
    expect(audit.issues.map(({ code }) => code)).toContain('MISSING_DESIGN_APPROVAL')
  })

  it('reclaims only a dead workspace-owned runtime lock', async () => {
    const root = await fixtureRoot()
    const fixture = await createFixture(root, { phase: 'SPECIFY' })
    await mkdir(join(root, '.backend-team', 'locks'), { recursive: true })
    await writeFile(join(root, '.backend-team', 'locks', 'runtime.lock'), JSON.stringify({ pid: 2147483647, nonce: 'dead-lock-nonce', workspaceRoot: await realpath(root) }), { mode: 0o600 })
    const recovery = new SpecificationRecovery({ stateStore: fixture.store, workspaceRoot: root, artifactRegistry: fixture.registry })

    const audit = await recovery.audit()
    expect(audit.cleanedLocks).toEqual(['.backend-team/locks/runtime.lock'])
    await expect(access(join(root, '.backend-team', 'locks', 'runtime.lock'))).rejects.toThrow()
  })

  async function fixtureRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-specification-recovery-'))
    roots.push(root)
    return root
  }
})

async function createFixture(root: string, overrides: Partial<Pick<BackendTeamState, 'phase' | 'runs' | 'approvals'>> = {}) {
  root = await realpath(root)
  const runtime = join(root, '.backend-team', 'runtime')
  const venv = join(runtime, 'spec-kit', '.venv', 'bin')
  await mkdir(venv, { recursive: true })
  await mkdir(join(root, '.backend-team', 'runtime', 'bin'), { recursive: true })
  await mkdir(join(root, '.backend-team', 'runtime', 'python'), { recursive: true })
  await mkdir(join(root, '.backend-team', 'runtime', 'spec-kit'), { recursive: true })
  await mkdir(join(root, '.backend-team', 'cache'), { recursive: true })
  await mkdir(join(root, '.specify'), { recursive: true })
  await mkdir(join(root, 'specs', '001-demo'), { recursive: true })
  await writeFile(join(root, '.specify', 'feature.json'), JSON.stringify({ feature_directory: 'specs/001-demo' }))
  const uv = join(runtime, 'bin', 'uv'); const uvx = join(runtime, 'bin', 'uvx'); const python = join(venv, 'python'); const managedPython = join(runtime, 'python', 'python3.13'); const specify = join(venv, 'specify')
  await Promise.all([writeFile(uv, 'uv'), writeFile(uvx, 'uvx'), writeFile(managedPython, 'python'), symlink('../../../python/python3.13', python), writeFile(specify, 'specify')])
  const closure = [
    { path: '.backend-team/runtime/python', sha256: await sha256WorkspaceTree(root, '.backend-team/runtime/python', ['.backend-team/runtime/python', '.backend-team/runtime/spec-kit/.venv']) },
    { path: '.backend-team/runtime/spec-kit/.venv', sha256: await sha256WorkspaceTree(root, '.backend-team/runtime/spec-kit/.venv', ['.backend-team/runtime/python', '.backend-team/runtime/spec-kit/.venv']) },
  ] as const
  const commandBase = [
    { executable: uv, args: ['--version'] },
    { executable: uv, args: ['python', 'install', '--offline', '3.13.15'] },
    { executable: uv, args: ['venv', '--offline', '--python', '3.13.15', join(runtime, 'spec-kit', '.venv')] },
    { executable: python, args: ['--version'] },
    { executable: uv, args: ['pip', 'check', '--offline', '--python', python] },
    { executable: uv, args: ['pip', 'check', '--offline', '--python', python] },
    { executable: specify, args: ['--version'] },
  ] as const
  const commands = commandBase.map(({ executable, args }) => {
    const command = { executable, args, cwd: join(runtime, 'bin'), env: {}, networkPolicy: 'deny' as const, result: 'ok' as const }
    return { ...command, executionFingerprint: sha256Canonical({ executable, args, cwd: command.cwd, env: command.env, codeWillExecute: true, networkPolicy: command.networkPolicy }) }
  })
  const content = {
    schemaVersion: 3,
    offlineInstall: true,
    artifacts: [{ component: 'specify-cli', version: '0.16.5' }],
    uv: { version: '0.12.3', path: uv, uvxPath: uvx, executableSha256: await fileSha256(uv), uvxSha256: await fileSha256(uvx) },
    python: { version: '3.13.15', path: python, sha256: await fileSha256(python) },
    specify: { version: '0.16.5', path: specify, sha256: await fileSha256(specify) },
    runtimeClosure: closure,
    commands,
    completedAt: '2026-08-27T00:00:00.000Z',
  }
  await writeFile(join(runtime, 'spec-kit', 'provenance.json'), JSON.stringify({ ...content, fingerprint: sha256Canonical(content) }))
  const state = initialState(root, overrides)
  let current = state
  const store: StateStore = {
    load: async () => current,
    create: async (initial) => { current = initial },
    transact: async (revision, change) => { if (revision !== current.revision) throw new Error('revision conflict'); current = { ...change(current), revision: revision + 1 }; return current },
  }
  const registry: RecoveryArtifactRegistryPort & { current: Readonly<Record<string, string>> } = {
    current: { 'spec.md': 'a'.repeat(64), 'architecture.md': 'b'.repeat(64) },
    snapshot: async () => registry.current,
  }
  return { root, store, registry }
}

function initialState(root: string, overrides: Partial<Pick<BackendTeamState, 'phase' | 'runs' | 'approvals'>>): BackendTeamState {
  return { schemaVersion: 1, revision: 0, workspaceRoot: root, phase: overrides.phase ?? 'SPECIFY', runs: overrides.runs ?? [], approvals: overrides.approvals ?? [], approvalTokens: [] }
}

function approval(kind: 'requirements' | 'design', path: string, character: string) {
  void path
  void character
  return { kind, artifactHashes: { 'spec.md': 'a'.repeat(64), 'architecture.md': 'b'.repeat(64) }, approvedAt: '2026-08-27T00:00:00.000Z', tokenId: `${kind}-approval-token-1234` }
}

function timestamp(minutes: number): string {
  return new Date(Date.parse('2026-08-27T00:00:00.000Z') + minutes * 60_000).toISOString()
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
