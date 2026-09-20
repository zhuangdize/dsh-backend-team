import { access, mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { PolicyContext } from '@dsh-backend-team/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { DefaultPolicyEngine, canonicalizeTargetPath, recheckAuthorizedTargetPath } from '../src/index.js'

describe('workspace path policy', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it.each([
    '../outside.txt',
    '.backend-team/runtime/link-to-outside/secret',
    '/tmp/other-project/file.ts',
  ])('denies workspace escape: %s', async (target) => {
    const { workspaceRoot, context } = await fixture()
    const engine = new DefaultPolicyEngine()

    expect((await engine.authorize({ kind: 'write', targetPath: target }, context)).effect).toBe('deny')
    await expect(canonicalizeTargetPath(workspaceRoot, target)).rejects.toThrow()
  })

  it('resolves a missing child only beneath the real workspace root', async () => {
    const { workspaceRoot } = await fixture()

    await expect(canonicalizeTargetPath(workspaceRoot, 'src/new/file.ts')).resolves.toBe(
      join(await realpath(workspaceRoot), 'src', 'new', 'file.ts'),
    )
  })

  it('rejects NUL paths without creating anything', async () => {
    const { workspaceRoot } = await fixture()

    await expect(canonicalizeTargetPath(workspaceRoot, 'src/unsafe\0file.ts')).rejects.toThrow(/NUL/)
  })

  it('allows a known read inside the workspace', async () => {
    const { context, workspaceRoot } = await fixture()
    const engine = new DefaultPolicyEngine()

    expect(await engine.authorize({ kind: 'read', targetPath: 'README.md' }, context)).toMatchObject({ effect: 'allow', canonicalTargetPath: join(await realpath(workspaceRoot), 'README.md') })
  })

  it('rejects a workspace-prefix trap', async () => {
    const { workspaceRoot } = await fixture()
    const prefixTrap = `${workspaceRoot}-other/file.ts`

    await expect(canonicalizeTargetPath(workspaceRoot, prefixTrap)).rejects.toThrow(/workspace/)
  })

  it('canonicalizes symlink leaves and ancestors without mutating the filesystem', async () => {
    const { workspaceRoot, outsideRoot } = await fixture()
    await mkdir(join(workspaceRoot, 'real'))
    await writeFile(join(workspaceRoot, 'real', 'leaf.ts'), 'safe')
    await symlink(join(workspaceRoot, 'real'), join(workspaceRoot, 'linked'))
    const before = await realpath(join(workspaceRoot, 'linked', 'leaf.ts'))

    await expect(canonicalizeTargetPath(workspaceRoot, 'linked/leaf.ts')).resolves.toBe(before)
    await expect(canonicalizeTargetPath(workspaceRoot, 'linked/new.ts')).resolves.toBe(join(await realpath(workspaceRoot), 'real', 'new.ts'))
    await expect(canonicalizeTargetPath(workspaceRoot, join(outsideRoot, 'secret'))).rejects.toThrow()
  })

  it('detects a symlink swapped after authorization before execution', async () => {
    const { workspaceRoot, outsideRoot } = await fixture()
    await mkdir(join(workspaceRoot, 'real'))
    await writeFile(join(workspaceRoot, 'real', 'leaf.ts'), 'safe')
    const link = join(workspaceRoot, 'linked')
    await symlink(join(workspaceRoot, 'real'), link)
    const canonicalTargetPath = await canonicalizeTargetPath(workspaceRoot, 'linked/leaf.ts')
    await unlink(link)
    await symlink(outsideRoot, link)

    await expect(recheckAuthorizedTargetPath(workspaceRoot, 'linked/leaf.ts', canonicalTargetPath)).rejects.toThrow()
  })

  it('does not create a missing target while authorizing it', async () => {
    const { workspaceRoot, context } = await fixture()
    const engine = new DefaultPolicyEngine()

    await expect(engine.authorize({ kind: 'write', targetPath: 'new/nested/file.ts' }, context)).resolves.toMatchObject({ canonicalTargetPath: join(await realpath(workspaceRoot), 'new', 'nested', 'file.ts') })
    await expect(access(join(workspaceRoot, 'new'))).rejects.toThrow()
  })

  async function fixture(): Promise<{ workspaceRoot: string; outsideRoot: string; context: PolicyContext }> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-policy-workspace-'))
    roots.push(workspaceRoot)
    const outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-policy-outside-'))
    roots.push(outsideRoot)
    await mkdir(join(workspaceRoot, '.backend-team', 'runtime'), { recursive: true })
    await mkdir(join(workspaceRoot, 'src'))
    await writeFile(join(workspaceRoot, 'README.md'), '# test\n')
    await writeFile(join(outsideRoot, 'secret'), 'secret')
    try {
      await symlink(outsideRoot, join(workspaceRoot, '.backend-team', 'runtime', 'link-to-outside'))
    } catch (error: unknown) { throw error }
    return { workspaceRoot, outsideRoot, context: makeContext(workspaceRoot) }
  }
})

function makeContext(root: string): PolicyContext {
  return {
    workspace: {
      root,
      teamDir: join(root, '.backend-team'),
      stateDir: join(root, '.backend-team', 'state'),
      runtimeDir: join(root, '.backend-team', 'runtime'),
      cacheDir: join(root, '.backend-team', 'cache'),
      logsDir: join(root, '.backend-team', 'logs'),
      locksDir: join(root, '.backend-team', 'locks'),
      handoffDir: join(root, '.backend-team', 'handoff'),
    },
    phase: 'BUILD',
  }
}
