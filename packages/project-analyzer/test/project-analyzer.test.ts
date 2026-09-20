import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandRequest, CommandResult, CommandRunner, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { ProjectAnalyzer } from '../src/index.js'

const fixtures = resolve(import.meta.dirname, '../../../tests/fixtures/projects')

function workspace(root: string): WorkspaceLayout {
  const teamDir = resolve(root, '.backend-team')
  return { root, teamDir, stateDir: resolve(teamDir, 'state'), runtimeDir: resolve(teamDir, 'runtime'), cacheDir: resolve(teamDir, 'cache'), logsDir: resolve(teamDir, 'logs'), locksDir: resolve(teamDir, 'locks'), handoffDir: resolve(teamDir, 'handoff') }
}

function gitRunner(outputs: readonly CommandResult[]): { readonly runner: CommandRunner; readonly requests: CommandRequest[] } {
  const requests: CommandRequest[] = []
  let index = 0
  return {
    requests,
    runner: { async run(request) { requests.push(request); return outputs[index++] ?? { exitCode: 1, stdout: '', stderr: 'unexpected', durationMs: 1 } } },
  }
}

describe('ProjectAnalyzer', () => {
  it('preserves the existing Nest, Drizzle, PostgreSQL, and exact Node stack', async () => {
    const analysis = await new ProjectAnalyzer({ workspace: workspace(resolve(fixtures, 'nest-drizzle-postgres')) }).analyze()

    expect(analysis.profile).toMatchObject({ projectKind: 'node-service', databaseRecommendation: { target: 'preserve-existing' }, nodeRuntime: { status: 'selected', exactVersion: '24.19.0' } })
    expect(analysis.profile.technologies.map((technology) => technology.value)).toEqual(expect.arrayContaining(['nest', 'drizzle', 'postgresql', 'npm']))
    expect(analysis.strategy).toMatchObject({ kind: 'modify-in-place', nodeVersion: '24.19.0', framework: 'nest', database: 'postgresql', orm: 'drizzle' })
  })

  it('does not migrate the existing Express, Prisma, MySQL, or Node 20 fixture', async () => {
    const analysis = await new ProjectAnalyzer({ workspace: workspace(resolve(fixtures, 'express-prisma-mysql')) }).analyze()

    expect(analysis.profile).toMatchObject({ nodeRuntime: { exactVersion: '20.20.0' }, databaseRecommendation: { target: 'preserve-existing' } })
    expect(analysis.profile.technologies.map((technology) => technology.value)).toEqual(expect.arrayContaining(['express', 'prisma', 'mysql']))
    expect(analysis.strategy).toMatchObject({ kind: 'needs-clarification', writable: false })
  })

  it('keeps an ambiguous service boundary explicit for the workflow caller', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'project-analyzer-services-'))
    try {
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['services/*'] }), 'utf8')
      mkdirSync(resolve(root, 'services/api-a'), { recursive: true })
      mkdirSync(resolve(root, 'services/api-b'), { recursive: true })
      writeFileSync(resolve(root, 'services/api-a/package.json'), JSON.stringify({ dependencies: { express: '5.0.0' }, scripts: { start: 'node server.js' } }), 'utf8')
      writeFileSync(resolve(root, 'services/api-b/package.json'), JSON.stringify({ dependencies: { fastify: '5.0.0' }, scripts: { start: 'node server.js' } }), 'utf8')

      const analysis = await new ProjectAnalyzer({ workspace: workspace(root) }).analyze()

      expect(analysis.serviceBoundaryDecision).toMatchObject({ status: 'needs-user-selection', candidates: [{ relativeRoot: 'services/api-a' }, { relativeRoot: 'services/api-b' }] })
      expect(analysis.profile.serviceBoundary).toBeNull()
      expect(analysis.strategy).toMatchObject({ kind: 'needs-clarification', writable: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts an explicit service boundary only when it is manifest-backed', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'project-analyzer-selected-service-'))
    try {
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['services/*'] }), 'utf8')
      mkdirSync(resolve(root, 'services/api-a'), { recursive: true })
      mkdirSync(resolve(root, 'services/api-b'), { recursive: true })
      writeFileSync(resolve(root, 'services/api-a/package.json'), JSON.stringify({ dependencies: { express: '5.0.0' }, scripts: { start: 'node server.js' } }), 'utf8')
      writeFileSync(resolve(root, 'services/api-b/package.json'), JSON.stringify({ dependencies: { fastify: '5.0.0' }, scripts: { start: 'node server.js' } }), 'utf8')

      const analysis = await new ProjectAnalyzer({ workspace: workspace(root) }).analyze('services/api-b')

      expect(analysis.serviceBoundaryDecision).toMatchObject({ status: 'selected', boundary: { relativeRoot: 'services/api-b' } })
      expect(analysis.profile.serviceBoundary).toMatchObject({ relativeRoot: 'services/api-b' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the approved preset for an empty workspace and writes profile state only when opted in', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'project-analyzer-empty-'))
    try {
      const analysis = await new ProjectAnalyzer({ workspace: workspace(root), persistProfile: true }).analyze()

      expect(analysis.strategy).toMatchObject({ kind: 'new-node-postgresql', nodeVersion: '24.19.0' })
      const profilePath = resolve(root, '.backend-team/project-profile.json')
      expect(existsSync(profilePath)).toBe(true)
      expect(JSON.parse(readFileSync(profilePath, 'utf8'))).toMatchObject({ projectKind: 'empty' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats a dependency-free Node manifest as a new Node project', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'project-analyzer-new-node-'))
    try {
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'new-service', private: true }), 'utf8')

      const analysis = await new ProjectAnalyzer({ workspace: workspace(root) }).analyze()

      expect(analysis.profile).toMatchObject({ projectKind: 'node-service', nodeRuntime: { status: 'needs-clarification' } })
      expect(analysis.strategy).toMatchObject({ kind: 'new-node-postgresql', nodeVersion: '24.19.0' })
      expect(existsSync(resolve(root, '.backend-team'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns a read-only strategy for non-Node content', async () => {
    const analysis = await new ProjectAnalyzer({ workspace: workspace(resolve(fixtures, 'non-node')) }).analyze()

    expect(analysis.profile).toMatchObject({ projectKind: 'non-node', nodeRuntime: null })
    expect(analysis.strategy).toMatchObject({ kind: 'unsupported-read-only', writable: false })
  })

  it('retains injected Git baseline evidence without running any project command', async () => {
    const git = gitRunner([
      { exitCode: 0, stdout: '/workspace\n', stderr: '', durationMs: 1 },
      { exitCode: 0, stdout: 'abc123\n', stderr: '', durationMs: 1 },
      { exitCode: 0, stdout: '? src/uncommitted.ts\0', stderr: '', durationMs: 1 },
    ])

    const analysis = await new ProjectAnalyzer({ workspace: workspace(resolve(fixtures, 'nest-drizzle-postgres')), gitRunner: git.runner }).analyze()

    expect(analysis.gitBaseline).toMatchObject({ repository: true, head: 'abc123', entries: [{ path: 'src/uncommitted.ts' }] })
    expect(analysis.profile.baselineIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'git-worktree-change', evidence: [expect.objectContaining({ kind: 'git', path: 'src/uncommitted.ts' })] })]))
    expect(git.requests.every((request) => request.executable === 'git')).toBe(true)
  })

  it('blocks strategy selection for an injected conflicted Git worktree state', async () => {
    const git = gitRunner([
      { exitCode: 0, stdout: '/workspace\n', stderr: '', durationMs: 1 },
      { exitCode: 0, stdout: 'abc123\n', stderr: '', durationMs: 1 },
      { exitCode: 0, stdout: 'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts\0', stderr: '', durationMs: 1 },
    ])

    const analysis = await new ProjectAnalyzer({ workspace: workspace(resolve(fixtures, 'nest-drizzle-postgres')), gitRunner: git.runner }).analyze()

    expect(analysis.profile.baselineIssues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'blocking', evidence: [expect.objectContaining({ kind: 'git', path: 'src/conflict.ts' })] })]))
    expect(analysis.strategy).toEqual(expect.objectContaining({ kind: 'needs-clarification', writable: false }))
  })

  it('persists a redacted runtime classification rather than arbitrary declaration text', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'project-analyzer-redacted-profile-'))
    try {
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'safe-project', private: true }), 'utf8')
      writeFileSync(resolve(root, '.nvmrc'), 'untrusted-runtime-declaration-should-never-persist', 'utf8')

      await new ProjectAnalyzer({ workspace: workspace(root), persistProfile: true }).analyze()

      const persisted = readFileSync(resolve(root, '.backend-team/project-profile.json'), 'utf8')
      expect(persisted).not.toContain('untrusted-runtime-declaration-should-never-persist')
      expect(JSON.parse(persisted)).toMatchObject({ nodeRuntime: { declarations: [{ range: 'unresolved' }] } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an exact runtime declaration in memory but persists only its normalized safe selection', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'project-analyzer-normalized-profile-'))
    try {
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'safe-project', private: true, engines: { node: '>=24 <25' } }), 'utf8')
      writeFileSync(resolve(root, '.nvmrc'), 'v24.19.0', 'utf8')

      const analysis = await new ProjectAnalyzer({ workspace: workspace(root), persistProfile: true }).analyze()

      expect(analysis.profile.nodeRuntime).toEqual(expect.objectContaining({ exactVersion: '24.19.0', declarations: expect.arrayContaining([expect.objectContaining({ range: 'v24.19.0' })]) }))
      const persisted = readFileSync(resolve(root, '.backend-team/project-profile.json'), 'utf8')
      expect(persisted).not.toContain('v24.19.0')
      expect(JSON.parse(persisted)).toEqual(expect.objectContaining({ nodeRuntime: expect.objectContaining({ exactVersion: '24.19.0', declarations: expect.arrayContaining([expect.objectContaining({ range: '24.19.0' })]) }) }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a pre-existing .backend-team symlink instead of writing outside the workspace', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'project-analyzer-symlink-state-'))
    const external = mkdtempSync(resolve(tmpdir(), 'project-analyzer-external-state-'))
    try {
      symlinkSync(external, resolve(root, '.backend-team'))

      await expect(new ProjectAnalyzer({ workspace: workspace(root), persistProfile: true }).analyze()).rejects.toThrow(/symlink/i)
      expect(existsSync(resolve(external, 'project-profile.json'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('rejects a pre-existing profile-file symlink instead of replacing external state', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'project-analyzer-profile-symlink-'))
    const external = mkdtempSync(resolve(tmpdir(), 'project-analyzer-external-profile-'))
    try {
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'safe-project', private: true }), 'utf8')
      writeFileSync(resolve(external, 'profile.json'), 'external state', 'utf8')
      const stateDirectory = resolve(root, '.backend-team')
      mkdirSync(stateDirectory)
      symlinkSync(resolve(external, 'profile.json'), resolve(stateDirectory, 'project-profile.json'))

      await expect(new ProjectAnalyzer({ workspace: workspace(root), persistProfile: true }).analyze()).rejects.toThrow(/symlink/i)
      expect(readFileSync(resolve(external, 'profile.json'), 'utf8')).toBe('external state')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })
})
