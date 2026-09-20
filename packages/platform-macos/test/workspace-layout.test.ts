import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertManagedPath, createWorkspaceLayout, initializeWorkspaceLayout, writeManagedMetadata } from '../src/workspace-layout.js'

const cleanup: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('workspace layout', () => {
  it('places every managed directory below .backend-team', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-platform-layout-'))
    cleanup.push(root)
    const layout = createWorkspaceLayout(root)
    const canonicalRoot = layout.root
    for (const path of Object.values(layout)) {
      expect(path === canonicalRoot || path === join(canonicalRoot, '.backend-team') || path.startsWith(join(canonicalRoot, '.backend-team') + '/')).toBe(true)
    }
    await initializeWorkspaceLayout(layout)
    for (const path of [layout.teamDir, layout.stateDir, layout.runtimeDir, layout.cacheDir, layout.logsDir, layout.locksDir, layout.handoffDir]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700)
    }
  })

  it('rejects a root that is itself inside the managed directory', () => {
    expect(() => createWorkspaceLayout('/work/app/.backend-team')).toThrow(/workspace root/i)
  })

  it('writes connection metadata with mode 0600', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-platform-layout-meta-'))
    cleanup.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const path = join(layout.stateDir, 'connection.secret.json')
    await writeFile(path, JSON.stringify({ url: 'postgres://localhost/test' }), { mode: 0o600, flag: 'wx' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).toContain('localhost')
  })

  it('refuses a symlinked managed ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-platform-layout-link-'))
    cleanup.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-platform-layout-outside-'))
    cleanup.push(outside)
    await symlink(outside, join(root, '.backend-team'))
    await expect(initializeWorkspaceLayout(createWorkspaceLayout(root))).rejects.toThrow(/symlink|unsafe/i)
  })

  it('returns canonical roots and rejects ancestor escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-platform-layout-canonical-'))
    cleanup.push(root)
    const layout = createWorkspaceLayout(root)
    expect(layout.root).toBe(await (await import('node:fs/promises')).realpath(root))
    expect(() => assertManagedPath(layout, join(root, '..', 'outside'))).toThrow(/escapes/i)
  })

  it('writes managed metadata durably with exclusive 0600 creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-platform-layout-write-'))
    cleanup.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const path = await writeManagedMetadata(layout, 'state/connection.secret.json', '{"ok":true}')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(writeManagedMetadata(layout, 'state/connection.secret.json', '{}')).rejects.toMatchObject({ code: 'EEXIST' })
  })
})
