import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256WorkspaceTree } from '../src/workspace-tree.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('sha256WorkspaceTree', () => {
  it('binds file bytes, paths, modes and in-workspace symlink targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tree-')); roots.push(root)
    await mkdir(join(root, 'runtime/python/bin'), { recursive: true })
    await mkdir(join(root, 'runtime/venv/bin'), { recursive: true })
    await writeFile(join(root, 'runtime/python/bin/python'), 'python', { mode: 0o700 })
    await symlink(join(root, 'runtime/python/bin/python'), join(root, 'runtime/venv/bin/python'))

    const first = await sha256WorkspaceTree(root, 'runtime/venv', ['runtime/venv', 'runtime/python'])
    const second = await sha256WorkspaceTree(root, 'runtime/venv', ['runtime/venv', 'runtime/python'])
    expect(first).toBe(second)

    const pythonBefore = await sha256WorkspaceTree(root, 'runtime/python', ['runtime/venv', 'runtime/python'])
    await writeFile(join(root, 'runtime/python/bin/python'), 'changed', { mode: 0o700 })
    const pythonAfter = await sha256WorkspaceTree(root, 'runtime/python', ['runtime/venv', 'runtime/python'])
    expect(pythonAfter).not.toBe(pythonBefore)
  })

  it('rejects symlink escapes and hard-linked files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tree-')); roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-tree-outside-')); roots.push(outside)
    await mkdir(join(root, 'runtime/venv'), { recursive: true })
    await writeFile(join(outside, 'payload'), 'outside')
    await symlink(join(outside, 'payload'), join(root, 'runtime/venv/escape'))
    await expect(sha256WorkspaceTree(root, 'runtime/venv', ['runtime/venv'])).rejects.toThrow(/symlink.*escape/i)

    await rm(join(root, 'runtime/venv/escape'))
    await writeFile(join(root, 'runtime/venv/original'), 'same')
    await link(join(root, 'runtime/venv/original'), join(root, 'runtime/venv/alias'))
    await expect(sha256WorkspaceTree(root, 'runtime/venv', ['runtime/venv'])).rejects.toThrow(/hard.?link/i)
  })
})
