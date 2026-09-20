import { expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrmSchemaSynchronizer } from '../src/index.js'

it('previews and atomically applies a hash-bound ORM schema update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-orm-'))
  try {
    await mkdir(join(root, 'generation'), { mode: 0o700 }); await mkdir(join(root, 'src', 'db'), { recursive: true, mode: 0o700 })
    await writeFile(join(root, 'generation', 'schema.ts'), 'export const users = table(\'users\')\n', { mode: 0o600 })
    await writeFile(join(root, 'src', 'db', 'schema.ts'), 'export const old = true\n', { mode: 0o600 })
    const prepared = await new OrmSchemaSynchronizer(root).prepare(join(root, 'generation', 'schema.ts'), 'src/db/schema.ts')
    expect(prepared.preview.path).toBe('src/db/schema.ts')
    expect(await readFile(join(root, 'src', 'db', 'schema.ts'), 'utf8')).toContain('old')
    await prepared.apply()
    expect(await readFile(join(root, 'src', 'db', 'schema.ts'), 'utf8')).toContain('users')
    await prepared.restore()
    expect(await readFile(join(root, 'src', 'db', 'schema.ts'), 'utf8')).toContain('old')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects an ORM target changed after preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-orm-'))
  try {
    await mkdir(join(root, 'generation'), { mode: 0o700 }); await mkdir(join(root, 'src'), { mode: 0o700 })
    await writeFile(join(root, 'generation', 'schema.ts'), 'new\n', { mode: 0o600 }); await writeFile(join(root, 'src', 'schema.ts'), 'old\n', { mode: 0o600 })
    const prepared = await new OrmSchemaSynchronizer(root).prepare(join(root, 'generation', 'schema.ts'), 'src/schema.ts')
    await writeFile(join(root, 'src', 'schema.ts'), 'changed\n', { mode: 0o600 })
    await expect(prepared.apply()).rejects.toThrow(/changed before approval/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})
