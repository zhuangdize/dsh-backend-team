import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConcurrentChangeGuard } from '../src/concurrent-change-guard.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'change-guard-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/service.ts'), 'export const value = 1\n')
  return root
}

describe('ConcurrentChangeGuard', () => {
  it('captures exact hash, bytes, realpath, identity and compressed evidence', async () => {
    const root = await fixture()
    try {
      const snapshot = await new ConcurrentChangeGuard({ workspaceRoot: root }).capture('src/service.ts')
      expect(snapshot).toMatchObject({ path: 'src/service.ts', state: 'present', bytes: 23, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), realPath: join(await realpath(root), 'src/service.ts'), mode: expect.any(Number), gitStatus: 'unknown' })
      expect(snapshot.identity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number), nlink: 1 })
      expect(snapshot.compressedBytes.byteLength).toBeGreaterThan(0)
      await new ConcurrentChangeGuard({ workspaceRoot: root }).assertUnchanged(snapshot)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects user edits, deletion and replacement as concurrent changes', async () => {
    const root = await fixture()
    try {
      const guard = new ConcurrentChangeGuard({ workspaceRoot: root })
      const snapshot = await guard.capture('src/service.ts')
      await writeFile(join(root, 'src/service.ts'), 'export const value = 2\n')
      await expect(guard.assertUnchanged(snapshot)).rejects.toThrow('concurrent change detected')
      await unlink(join(root, 'src/service.ts'))
      await expect(guard.assertUnchanged(snapshot)).rejects.toThrow('concurrent change detected')
      await writeFile(join(root, 'src/service.ts'), 'export const value = 1\n')
      await expect(guard.assertUnchanged(snapshot)).rejects.toThrow('concurrent change detected')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fails closed for a symlink escape and an out-of-workspace path', async () => {
    const root = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'change-guard-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret\n')
      await symlink(join(outside, 'secret.txt'), join(root, 'src/escape.txt'))
      const guard = new ConcurrentChangeGuard({ workspaceRoot: root })
      await expect(guard.capture('src/escape.txt')).rejects.toThrow(/symlink|workspace|realpath/i)
      await expect(guard.capture('../outside.txt')).rejects.toThrow(/workspace|path/i)
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })
})
