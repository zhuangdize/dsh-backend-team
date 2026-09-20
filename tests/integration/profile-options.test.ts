import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveDshBinDirectory, resolveDshHome, resolveDshPath, resolveProfileName, resolveProfileStoreDirectory, resolveWorkspaceNodeExecutable, resolveWorkspaceNodePath, resolveWorkspaceRoot } from '../../scripts/backend-team-profile-options.mjs'

describe('Backend Team profile defaults', () => {
  it('defaults to the web Profile and the caller workspace', () => {
    expect(resolveProfileName(undefined)).toBe('web')
    expect(resolveWorkspaceRoot(undefined, '/tmp/backend-team-project')).toBe('/tmp/backend-team-project')
    expect(resolveDshHome('/tmp/backend-team-project')).toBe('/tmp/backend-team-project/.backend-team/runtime/dsh-home')
    expect(resolveDshHome('/tmp/backend-team-project', '/Users/example/.dsh')).toBe('/Users/example/.dsh')
    expect(resolveDshBinDirectory('/tmp/backend-team-project')).toBe('/tmp/backend-team-project/.backend-team/runtime/dsh/0.1.0-rc.6/node_modules/.bin')
    expect(resolveWorkspaceNodeExecutable('/tmp/backend-team-project')).toBe('/tmp/backend-team-project/.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node')
  })

  it('selects the workspace-local DSH executable without consulting a global binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backend-team-profile-options-'))
    const dshPath = join(root, '.backend-team/runtime/dsh/0.1.0-rc.6/node_modules/.bin/dsh')
    await mkdir(join(root, '.backend-team/runtime/dsh/0.1.0-rc.6/node_modules/.bin'), { recursive: true })
    await writeFile(dshPath, '#!/bin/sh\n', { mode: 0o755 })

    await expect(resolveDshPath(undefined, root)).resolves.toBe(await realpath(dshPath))
    await expect(resolveDshPath('/usr/local/bin/dsh', root)).rejects.toThrow(/workspace-local|absolute|runtime/i)
  })

  it('rejects a workspace path whose DSH symlink escapes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backend-team-profile-options-'))
    const directory = join(root, '.backend-team/runtime/dsh/0.1.0-rc.6/node_modules/.bin')
    await mkdir(directory, { recursive: true })
    await symlink('/bin/sh', join(directory, 'dsh'))

    await expect(resolveDshPath(undefined, root)).rejects.toThrow(/workspace-local|runtime/i)
  })

  it('rejects a workspace Node symlink that escapes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backend-team-profile-options-'))
    const directory = join(root, '.backend-team/runtime/nvm/versions/node/v24.19.0/bin')
    await mkdir(directory, { recursive: true })
    await symlink('/bin/sh', join(directory, 'node'))

    await expect(resolveWorkspaceNodePath(root)).rejects.toThrow(/workspace-local|runtime/i)
  })

  it('reuses an explicit Profile’s existing pnpm store', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'backend-team-profile-options-'))
    const dshHome = await mkdtemp(join(tmpdir(), 'backend-team-user-dsh-'))
    const profileNodeModules = join(dshHome, 'profiles/web/node_modules')
    const store = join(workspace, '.backend-team/runtime/dsh-user-store')
    await mkdir(profileNodeModules, { recursive: true })
    await writeFile(join(profileNodeModules, '.modules.yaml'), JSON.stringify({ storeDir: `${store}/v11` }))

    await expect(resolveProfileStoreDirectory(workspace, dshHome, 'web')).resolves.toBe(store)
  })

  it('rejects unsafe Profile names before touching the filesystem', () => {
    expect(() => resolveProfileName('../web')).toThrow(/profile/i)
    expect(() => resolveProfileName('web/other')).toThrow(/profile/i)
  })
})
