import { mkdtemp, mkdir, realpath, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runManagedTypecheck } from '../src/managed-typecheck.js'

it.skipIf(process.platform !== 'darwin')('checks real TypeScript and declared imports without emitting files or executing top-level code', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-typecheck-')))
  try {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/lib.ts'), 'export const value: number = 1;')
    await writeFile(join(root, 'src/app.ts'), "import {value} from './lib.ts'; import {writeFileSync} from 'node:fs'; const answer: number = value; writeFileSync('MUST_NOT_EXIST', String(answer));")
    const options = { workspaceRoot: root, files: ['src/app.ts'], readPaths: ['src/app.ts', 'src/lib.ts'], signal: new AbortController().signal, maxWallMs: 15000 }
    const result = await runManagedTypecheck(options)
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(await readdir(root)).toEqual(['src'])
    expect(await readdir(join(root, 'src'))).toEqual(['app.ts', 'lib.ts'])
    await writeFile(join(root, 'src/lib.ts'), "export const value: string = 'wrong';")
    const failure = await runManagedTypecheck(options)
    expect(failure.exitCode).not.toBe(0)
    expect(failure.stdout).toContain('TS2322')
    const denied = await runManagedTypecheck({ ...options, readPaths: ['src/app.ts'] })
    expect(denied.exitCode).not.toBe(0)
    expect(denied.stdout).not.toContain('wrong')
    await expect(runManagedTypecheck({ ...options, files: ['src/missing.ts'] })).rejects.toThrow('声明')
    await expect(runManagedTypecheck({ ...options, signal: AbortSignal.abort() })).rejects.toThrow('取消')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
