import { expect, it } from 'vitest'
import { mkdtemp, realpath, rm, stat, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileCredentialStore } from '../src/credential-store.js'

it('persists a private credential across independent store instances and deletes it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-credentials-')))
  try {
    const directory = join(root, 'private'); const first = new FileCredentialStore(directory)
    const ref = await first.put('postgresql-test', 'test-only-secret')
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, ref))).mode & 0o777).toBe(0o600)
    const second = new FileCredentialStore(directory)
    expect(Buffer.from((await second.get(ref))!).toString()).toBe('test-only-secret')
    await second.delete(ref); expect(await first.get(ref)).toBeUndefined()
    await expect(first.get('../outside')).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects redirected files and overly broad credential permissions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-credentials-')))
  try {
    const store = new FileCredentialStore(join(root, 'private')); const ref = await store.put('test', 'test-only-secret')
    await chmod(join(root, 'private', ref), 0o644); await expect(store.get(ref)).rejects.toThrow()
    await chmod(join(root, 'private', ref), 0o600)
    const redirected = 'credential-' + 'a'.repeat(32); await symlink(join(root, 'private', ref), join(root, 'private', redirected))
    await expect(store.get(redirected)).rejects.toThrow()
    await symlink(join(root, 'private'), join(root, 'alias'))
    await expect(new FileCredentialStore(join(root, 'alias')).get(ref)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
