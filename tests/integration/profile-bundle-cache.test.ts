import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
// @ts-expect-error Workspace maintenance scripts are JavaScript modules.
import { stageProfileBundle } from '../../scripts/profile-bundle-cache.mjs'

it('changes the package URL when a same-name local archive is rebuilt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-bundle-cache-'))
  try {
    const archive = join(root, 'bundle.tgz')
    await writeFile(archive, 'first build')
    const first = await stageProfileBundle(archive, root)
    expect(await stageProfileBundle(archive, root)).toBe(first)
    await writeFile(archive, 'second build')
    const second = await stageProfileBundle(archive, root)
    expect(second).not.toBe(first)
    expect(await readFile(first, 'utf8')).toBe('first build')
    expect(await readFile(second, 'utf8')).toBe('second build')
    await writeFile(second, 'corrupted')
    await expect(stageProfileBundle(archive, root)).rejects.toThrow('digest')
  } finally { await rm(root, { recursive: true, force: true }) }
})
