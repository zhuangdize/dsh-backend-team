import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PolicyAction, PolicyContext } from '@dsh-backend-team/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DefaultPolicyEngine, PolicyDeniedError } from '../src/index.js'

let commandCwd = ''

describe('action policy', () => {
  let workspaceRoot: string
  let context: PolicyContext
  let engine: DefaultPolicyEngine

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-policy-action-'))
    commandCwd = workspaceRoot
    context = makeContext(workspaceRoot)
    engine = new DefaultPolicyEngine()
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it.each([
    'postgres://user:pass@prod.example.com/app',
    'postgres://user:pass@10.2.3.4/app',
  ])('denies non-local database target: %s', async (connectionString) => {
    expect((await engine.authorize({ kind: 'database', connectionString }, context)).effect).toBe('deny')
  })

  it('does not elevate a loopback database action to an automatic allow', async () => {
    expect(await engine.authorize({ kind: 'database', connectionString: 'postgres://user:pass@[::1]/app' }, context)).toMatchObject({ effect: 'deny', ruleId: 'deny-unknown' })
  })

  it.each([
    { args: ['serve', '--host', '0.0.0.0'] },
    { args: ['serve', '--bind=10.2.3.4'] },
    { args: ['serve', '--listen'] },
  ])('denies non-loopback or malformed service binds: %#', async ({ args }) => {
    expect(await engine.authorize(command('node', args), context)).toMatchObject({ effect: 'deny', ruleId: 'deny-non-loopback-service' })
  })

  it('does not elevate a loopback service bind to an automatic allow', async () => {
    expect(await engine.authorize(command('node', ['serve', '--host=localhost']), context)).toMatchObject({ effect: 'deny', ruleId: 'deny-unknown' })
  })

  it.each([
    { executable: 'rm', args: ['-rf', 'src'] },
    { executable: 'git', args: ['reset', '--hard'] },
  ])('denies destructive commands: %#', async ({ executable, args }) => {
    expect((await engine.authorize(command(executable, args), context)).effect).toBe('deny')
  })

  it.each([
    { executable: 'rm', args: ['-r', '-f', 'src'] },
    { executable: 'rm', args: ['--recursive', '--force', 'src'] },
    { executable: 'rm', args: ['-Rsrc'] },
    { executable: 'npm', args: ['--location=global', 'install', 'zod'] },
    { executable: 'npm', args: ['--prefix=/usr/local', 'install', 'zod'] },
    { executable: 'yarn', args: ['global', 'add', 'zod'] },
    { executable: 'pnpm', args: ['add', '--global', 'zod'] },
    { executable: 'bun', args: ['add', '-g', 'zod'] },
    { executable: 'doas', args: ['npm', 'install', 'zod'] },
    { executable: 'pkexec', args: ['npm', 'install', 'zod'] },
    { executable: 'sh', args: ['-c', 'rm -rf src'] },
    { executable: 'git', args: ['-C', 'repo', 'reset', '--hard'] },
    { executable: 'git', args: ['push', '--force'] },
    { executable: 'git', args: ['branch', '-D', 'feature'] },
    { executable: 'git', args: ['stash', 'clear'] },
    { executable: 'git', args: ['clean', '--force'] },
    { executable: 'git', args: ['checkout', '--', 'changed.ts'] },
    { executable: 'git', args: ['push', '-f'] },
    { executable: 'git', args: ['push', '--force-with-lease'] },
    { executable: 'git', args: ['branch', '--delete', 'feature'] },
    { executable: 'git', args: ['stash', 'drop'] },
    { executable: 'git', args: ['--git-dir', '.git', 'reset', '--hard'] },
  ])('always denies bypassable destructive and global variants: %#', async ({ executable, args }) => {
    expect((await engine.authorize(command(executable, args), context)).effect).toBe('deny')
  })

  it('denies global flags smuggled in an install action label', async () => {
    expect((await engine.authorize({ kind: 'install', packages: ['--global', 'zod'] }, context)).effect).toBe('deny')
  })

  it.each([
    command('psql', ['postgres://user:password@prod.example.com/app']),
    command('psql', ['--url=jdbc:postgresql://prod.example.com/app']),
    command('node', ['--hostname=0.0.0.0']),
    command('node', ['--host', '127.0.0.1', '--bind', '0.0.0.0']),
    command('node', ['-H', '127.0.0.1', '-b', '0.0.0.0']),
    command('find', ['src', '-delete']),
    command('find', ['src', '-execdir', 'rm', '{}', ';']),
    command('unlink', ['src/file.ts']),
    command('env', ['sudo', 'rm', '-rf', 'src']),
    command('git', ['branch', '-d', 'feature']),
    command('npm', ['--global=true', 'install', 'zod']),
    command('npm', ['install', 'zod'], { NPM_CONFIG_GLOBAL: 'true' }),
    command('npm', ['--prefix', '/tmp/untrusted', 'install', 'zod']),
    command('npm', ['--location', 'global', 'install', 'zod']),
    command('npm', ['config', 'set', 'prefix', 'tools']),
    command('npm', ['install', 'zod'], { NPM_CONFIG_PREFIX: '/tmp/untrusted' }),
    command('git', ['checkout', '-f', 'main']),
    command('git', ['worktree', 'remove', '-f', 'work']),
    command('git', ['tag', '--delete', 'old']),
  ])('hard-denies reviewer bypasses without echoing action data: %#', async (action) => {
    const decision = await engine.authorize(action, context)
    expect(decision.effect).toBe('deny')
    expect(decision.reason).not.toContain('prod.example.com')
    expect(decision.reason).not.toContain('password')
  })

  it('hard-denies unsafe database and bind values supplied through command environment', async () => {
    expect((await engine.authorize(command('node', ['server'], { DATABASE_URL: 'postgres://user:password@10.2.3.4/app', HOST: '127.0.0.1' }), context)).effect).toBe('deny')
    expect((await engine.authorize(command('node', ['server'], { BIND_HOST: '0.0.0.0' }), context)).effect).toBe('deny')
  })

  it.each([
    command('npm', ['--location=project', 'install', 'zod']),
    command('npm', ['--prefix=tools/npm', 'install', 'zod']),
  ])('asks for local dependency installs without treating their prefix as global: %#', async (action) => {
    expect(await engine.authorize(action, context)).toMatchObject({ effect: 'ask', ruleId: 'require-install-approval' })
  })

  it('keeps unmatched environment keys out of bind classification', async () => {
    expect((await engine.authorize(command('node', ['server'], { PATH: '/trusted/bin' }), context)).effect).toBe('deny')
  })

  it.each([
    { args: ['worktree', 'remove', '--force'], effect: 'deny' },
    { args: ['tag', '-d', 'old-tag'], effect: 'deny' },
    { args: ['--unknown-global', 'status'], effect: 'deny' },
  ])('classifies additional Git destructive and global-option forms: %#', async ({ args, effect }) => {
    expect((await engine.authorize(command('git', args), context)).effect).toBe(effect)
  })

  it.each(['package.json', 'package-lock.json', 'drizzle/0001.sql', 'node_modules/zod/index.js'])('allows safe in-workspace reads of risk-classified paths: %s', async (targetPath) => {
    expect(await engine.authorize({ kind: 'read', targetPath }, context)).toMatchObject({ effect: 'allow', ruleId: 'allow-known-read' })
  })

  it.each([
    { executable: 'git', args: ['clean', '-fd'] },
    { executable: 'git', args: ['checkout', '.'] },
    { executable: 'git', args: ['restore', '.'] },
    { executable: 'brew', args: ['install', 'wget'] },
    { executable: 'npm', args: ['install', '--global', 'typescript'] },
  ])('denies global or destructive variants: %#', async ({ executable, args }) => {
    expect((await engine.authorize(command(executable, args), context)).effect).toBe('deny')
  })

  it('does not treat a hidden tool as harmless', async () => {
    expect((await engine.authorize(command('rm', ['-rf', 'src']), context)).effect).toBe('deny')
  })

  it.each([
    { executable: '/bin/rm', args: ['-rf', 'src'] },
    { executable: '/usr/bin/sudo', args: ['npm', 'test'] },
  ])('does not trust an absolute executable label: %#', async ({ executable, args }) => {
    expect((await engine.authorize(command(executable, args), context)).effect).toBe('deny')
  })

  it.each([
    { kind: 'install', packages: ['zod'] },
    { kind: 'migration', targetPath: 'drizzle/0001.sql' },
    { kind: 'shared-config', targetPath: 'package.json' },
    command('npm', ['install', 'zod']),
    command('pnpm', ['add', 'zod']),
  ] satisfies PolicyAction[])('requires approval for structurally recognized risky action %#', async (action) => {
    expect((await engine.authorize(action, context)).effect).toBe('ask')
  })

  it.each([command('npm', ['run', 'unknown-script']), command('curl', ['https://example.com'])])('denies unknown commands even when an action label appears harmless: %#', async (action) => {
    expect(await engine.authorize(action, context)).toMatchObject({ effect: 'deny', ruleId: 'deny-unknown' })
  })

  it('keeps non-destructive Git stash commands in the final unknown-command deny path', async () => {
    expect(await engine.authorize(command('git', ['stash', 'show']), context)).toMatchObject({ effect: 'deny', ruleId: 'deny-unknown' })
  })

  it.each([
    { executable: 'npm', args: ['test'] },
    { executable: 'npm', args: ['run', 'typecheck'] },
    { executable: 'git', args: ['status'] },
  ])('does not allow bare verification commands with ambiguous PATH or cwd: %#', async ({ executable, args }) => {
    expect(await engine.authorize(command(executable, args), context)).toMatchObject({ effect: 'deny', ruleId: 'deny-unknown' })
  })

  it.each([
    { executable: 'sh', args: ['-c', 'npm test'] },
    { executable: 'npm', args: ['test', '&&', 'rm', '-rf', 'src'] },
    { executable: 'npm', args: ['test', '>$HOME/out'] },
    { executable: 'npm', args: ['test', '$HOME'] },
    { executable: 'npm', args: ['test', '"quoted"'] },
    { executable: 'npm', args: ['test', '*.ts'] },
    { executable: 'sudo', args: ['npm', 'test'] },
  ])('never automatically allows shell-like command input: %#', async ({ executable, args }) => {
    expect((await engine.authorize(command(executable, args), context)).effect).not.toBe('allow')
  })

  it.each([
    { executable: 'npm', args: ['test', '--prefix', '/tmp/other-project'] },
    { executable: 'git', args: ['status', '--work-tree=/tmp/other-project'] },
    { executable: 'rg', args: ['TODO', '/tmp/other-project'] },
    { executable: '/tmp/npm', args: ['test'] },
  ])('does not automatically allow commands with unverified target scope: %#', async ({ executable, args }) => {
    expect((await engine.authorize(command(executable, args), context)).effect).not.toBe('allow')
  })

  it('denies writes whose assignment ownership cannot be proven', async () => {
    expect(await engine.authorize({ kind: 'write', targetPath: 'src/new.ts' }, context)).toMatchObject({ effect: 'deny', ruleId: 'deny-unknown' })
  })

  it('allows a BUILD write only with canonical owned-path evidence', async () => {
    context = { ...context }
    await expect(engine.enforce({ kind: 'write', targetPath: 'src/new.ts' }, context)).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  it.each(['DISCOVER', 'DESIGN', 'PLAN'] as const)('does not allow owned writes outside an approved build phase: %s', async (phase) => {
    context = { ...context, phase }
    expect((await engine.authorize({ kind: 'write', targetPath: 'src/new.ts' }, context)).effect).toBe('deny')
  })

  it('does not let caller-supplied context forge write ownership', async (testContext) => {
    await mkdir(join(workspaceRoot, 'real-owned'))
    try {
      await symlink(join(workspaceRoot, 'real-owned'), join(workspaceRoot, 'owned-link'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        testContext.skip('platform prohibits creating the symlink ownership fixture')
        return
      }
      throw error
    }
    expect((await engine.authorize({ kind: 'write', targetPath: 'owned-link/new.ts' }, context)).effect).toBe('deny')
  })

  it('classifies generic writes to shared config and migration paths before ownership', async () => {
    context = { ...context }
    await expect(engine.authorize({ kind: 'write', targetPath: 'package.json' }, context)).resolves.toMatchObject({ effect: 'ask', ruleId: 'require-shared-config-approval' })
    await expect(engine.authorize({ kind: 'write', targetPath: 'drizzle/0001.sql' }, context)).resolves.toMatchObject({ effect: 'ask', ruleId: 'require-migration-approval' })
  })

  it.each([
    { action: command('node', ['tool', 'package.json']), ruleId: 'require-shared-config-approval' },
    { action: command('node', ['tool', 'migrate']), ruleId: 'require-migration-approval' },
    { action: { kind: 'write', targetPath: 'node_modules/zod/index.js' } satisfies PolicyAction, ruleId: 'require-install-approval' },
  ])('does not let generic action labels bypass target-derived risk: %#', async ({ action, ruleId }) => {
    expect(await engine.authorize(action, context)).toMatchObject({ effect: 'ask', ruleId })
  })

  it('denies deletion even when the target is inside the workspace', async () => {
    expect(await engine.authorize({ kind: 'delete', targetPath: 'obsolete.ts' }, context)).toMatchObject({ effect: 'deny', ruleId: 'deny-unowned-delete' })
  })

  it('offers a safe error at an enforcement boundary', async () => {
    await expect(engine.enforce({ kind: 'database', connectionString: 'postgres://user:pass@prod.example.com/app' }, context)).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  it('denies malformed command contracts before evaluating executable labels', async () => {
    const malformed = { kind: 'command', executable: 'node', args: ['--host', '0.0.0.0'], cwd: workspaceRoot }
    await expect(engine.authorize(malformed, context)).resolves.toMatchObject({ effect: 'deny', ruleId: 'deny-invalid-contract' })
  })
})

function makeContext(root: string): PolicyContext {
  return {
    workspace: {
      root,
      teamDir: join(root, '.backend-team'), stateDir: join(root, '.backend-team/state'),
      runtimeDir: join(root, '.backend-team/runtime'), cacheDir: join(root, '.backend-team/cache'),
      logsDir: join(root, '.backend-team/logs'), locksDir: join(root, '.backend-team/locks'),
      handoffDir: join(root, '.backend-team/handoffs'),
    },
    phase: 'BUILD',
  }
}

function command(executable: string, args: string[], env: Record<string, string> = {}): PolicyAction {
  return { kind: 'command', executable, args, get cwd() { return commandCwd }, env, executionFingerprint: 'a'.repeat(64) }
}
