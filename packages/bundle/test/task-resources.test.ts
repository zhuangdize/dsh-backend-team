import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readTaskResources } from '../src/task-resources.js'
it('lists bounded task documents and declared outputs, excluding unrelated and secret files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'task-resources-')))
  try {
    await mkdir(join(root, 'specs/task-demo'), { recursive: true }); await mkdir(join(root, 'src'))
    await writeFile(join(root, 'specs/task-demo/spec.md'), '# Customer requirements')
    await writeFile(join(root, 'src/customer.mjs'), 'export const customer = true')
    await writeFile(join(root, 'src/.env'), 'secret')
    await writeFile(join(root, 'private.txt'), 'private')
    await symlink(join(root, 'private.txt'), join(root, 'src/link.mjs'))
    const files = await readTaskResources(root, 'task-demo', ['src/customer.mjs','src/.env','private.txt','src/../private.txt','src/link.mjs'])
    expect(files.map(file => file.path)).toEqual(['specs/task-demo/spec.md','src/customer.mjs','src/link.mjs'])
    expect(files[0]).toMatchObject({ content: '# Customer requirements', category: '方案文档', sha256: expect.any(String) })
    expect(files[2]).toMatchObject({ error: expect.any(String) })
    expect(JSON.stringify(files)).not.toContain('secret')
    expect(JSON.stringify(files)).not.toContain('"content":"private"')
    await expect(readTaskResources(root, '../other', [])).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
