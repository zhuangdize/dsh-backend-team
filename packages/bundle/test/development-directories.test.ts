import { mkdtemp, mkdir, realpath, rm, symlink, stat, writeFile, readFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { DevelopmentPlan } from '@dsh-backend-team/development'
import { prepareDevelopmentDirectories, validateDevelopmentPaths } from '../src/development-directories.js'

it('creates only declared output parents and rejects traversal and symlink parents', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'development-directories-')))
  const plan = (path: string) => ({ slices: [{ expectedPaths: [path] }] } as unknown as DevelopmentPlan)
  try {
    await prepareDevelopmentDirectories(root, plan('src/demo/nested/service.mjs'), ['src'])
    expect((await stat(join(root, 'src/demo/nested'))).isDirectory()).toBe(true)
    await expect(stat(join(root, 'src/demo/nested/service.mjs'))).rejects.toThrow()
    await expect(prepareDevelopmentDirectories(root, plan('src/../escape.mjs'), ['src'])).rejects.toThrow('写入目录')
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, 'src/link'))
    await expect(prepareDevelopmentDirectories(root, plan('src/link/service.mjs'), ['src'])).rejects.toThrow('目录不安全')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reports the conflicting file before creating any output directories', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'development-preflight-')))
  const plan = { slices: [{ expectedPaths: ['src/new/customer.ts', 'migrations/001-customer.sql'] }] } as unknown as DevelopmentPlan
  try {
    await expect(prepareDevelopmentDirectories(root, plan, ['src','test'])).rejects.toThrow('migrations/001-customer.sql')
    await expect(stat(join(root,'src'))).rejects.toThrow()
    await prepareDevelopmentDirectories(root, plan, ['src','test','migrations'])
    expect((await stat(join(root,'migrations'))).isDirectory()).toBe(true)
    await expect(stat(join(root,'migrations/001-customer.sql'))).rejects.toThrow()
  } finally { await rm(root, { recursive:true, force:true }) }
})

it('validates a new plan without creating directories or changing existing source', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'development-readonly-')))
  try {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/existing.mjs'), 'original')
    const plan = { slices: [{ expectedPaths: ['src/existing.mjs', 'test/new/service.test.mjs'] }] } as unknown as DevelopmentPlan
    await validateDevelopmentPaths(root, plan, ['src', 'test'])
    expect(await readFile(join(root, 'src/existing.mjs'), 'utf8')).toBe('original')
    await expect(stat(join(root, 'test'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['symlink', 'directory', 'parent-file', 'hardlink'])('rejects a later %s conflict before creating earlier output parents', async kind => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'development-conflict-')))
  try {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'original.mjs'), 'keep')
    let conflict = 'src/conflict.mjs'
    if (kind === 'symlink') await symlink(join(root, 'original.mjs'), join(root, conflict))
    if (kind === 'directory') await mkdir(join(root, conflict))
    if (kind === 'parent-file') { await writeFile(join(root, conflict), 'keep'); conflict += '/nested.mjs' }
    if (kind === 'hardlink') await link(join(root, 'original.mjs'), join(root, conflict))
    const plan = { slices: [{ expectedPaths: ['test/new/example.test.mjs', conflict] }] } as unknown as DevelopmentPlan
    await expect(prepareDevelopmentDirectories(root, plan, ['src', 'test'])).rejects.toThrow(conflict)
    await expect(stat(join(root, 'test'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'original.mjs'), 'utf8')).toBe('keep')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['src/.private/output.mjs', 'src/bad\u007f.mjs', 'src/service'])('rejects invalid managed paths or file/parent collisions: %s', async file => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'development-paths-')))
  try {
    const plan = { slices: [{ expectedPaths: [file, 'src/service/index.mjs'] }] } as unknown as DevelopmentPlan
    await expect(validateDevelopmentPaths(root, plan, ['src'])).rejects.toThrow()
    await expect(stat(join(root, 'src'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
