import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('workspace build order', () => {
  it('plans a clean build with every internal dependency before its consumer', () => {
    const result = spawnSync(process.execPath, ['scripts/build-workspaces.mjs', '--plan'], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      '@dsh-backend-team/contracts',
      '@dsh-backend-team/agent-team',
      '@dsh-backend-team/core',
      '@dsh-backend-team/policy-engine',
      '@dsh-backend-team/development',
      '@dsh-backend-team/dependency-governance',
      '@dsh-backend-team/database',
      '@dsh-backend-team/web',
      '@dsh-backend-team/verification',
      '@dsh-backend-team/platform-macos',
      '@dsh-backend-team/spec-workflow',
      '@dsh-backend-team/project-analyzer',
      '@dsh-backend-team/harness-adapter',
      '@dsh-backend-team/bundle',
    ])
  })

  it('builds a disposable source copy without stale workspace dist artifacts', async () => {
    const cacheRoot = join(root, '.backend-team', 'cache')
    await mkdir(cacheRoot, { recursive: true })
    const fixture = await mkdtemp(join(cacheRoot, 'clean-build-order-'))
    try {
      const archivePath = join(fixture, 'source.tar')
      const archive = spawnSync('git', ['archive', '--format=tar', `--output=${archivePath}`, 'HEAD'], { cwd: root, encoding: 'utf8' })
      expect(archive.status, archive.stderr.toString()).toBe(0)
      const source = join(fixture, 'source')
      await mkdir(source)
      const extracted = spawnSync('tar', ['-xf', archivePath, '-C', source], { encoding: 'utf8' })
      expect(extracted.status, extracted.stderr).toBe(0)
      await symlink(join(root, 'node_modules'), join(source, 'node_modules'), 'dir')
      await expect(stat(join(source, 'packages', 'platform-macos', 'dist'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(source, 'packages', 'agent-team', 'dist'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(source, 'packages', 'spec-workflow', 'dist'))).rejects.toMatchObject({ code: 'ENOENT' })

      const result = spawnSync(process.execPath, ['scripts/build-workspaces.mjs'], {
        cwd: source,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
      })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      await expect(stat(join(source, 'packages', 'platform-macos', 'dist', 'index.js'))).resolves.toBeDefined()
      await expect(stat(join(source, 'packages', 'agent-team', 'dist', 'index.js'))).resolves.toBeDefined()
      await expect(stat(join(source, 'packages', 'spec-workflow', 'dist', 'index.js'))).resolves.toBeDefined()
      await expect(stat(join(source, 'packages', 'project-analyzer', 'dist', 'index.js'))).resolves.toBeDefined()
      await expect(stat(join(source, 'packages', 'bundle', 'lib', 'index.js'))).resolves.toBeDefined()
    } finally { await rm(fixture, { recursive: true, force: true }) }
  }, 120_000)
})
