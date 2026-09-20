import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DbGateInstaller } from '../src/index.js'

describe('DbGateInstaller', () => {
  it.each(['.backend-team', '.backend-team/runtime', '.backend-team/runtime/dbgate'])('rejects a redirected %s before creating descendants or invoking npm', async (redirected) => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-dbgate-redirect-'))
    const root = join(fixture, 'workspace')
    const outside = join(fixture, 'outside')
    try {
      await mkdir(root)
      await mkdir(outside)
      await writeFile(join(outside, 'sentinel'), 'unchanged')
      const link = join(root, redirected)
      await mkdir(dirname(link), { recursive: true })
      await symlink(outside, link)
      let calls = 0
      const installer = new DbGateInstaller({ workspaceRoot: root, npmPath: '/workspace/node/bin/npm', runner: { run: async () => { calls += 1; return { exitCode: 0, stdout: '', stderr: '' } } } })
      await expect(installer.ensureInstalled(true, 'approved-token-123456')).rejects.toThrow(/symlink|directory|workspace/i)
      expect(calls).toBe(0)
      expect(await readdir(outside)).toEqual(['sentinel'])
    } finally { await rm(fixture, { recursive: true, force: true }) }
  })

  it('rejects an internal directory alias instead of installing into another workspace directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-alias-'))
    try {
      const other = join(root, 'other')
      await mkdir(other)
      await symlink(other, join(root, '.backend-team'))
      let calls = 0
      const installer = new DbGateInstaller({ workspaceRoot: root, npmPath: '/workspace/node/bin/npm', runner: { run: async () => { calls += 1; return { exitCode: 0, stdout: '', stderr: '' } } } })
      await expect(installer.ensureInstalled(true, 'approved-token-123456')).rejects.toThrow(/symlink|directory|workspace/i)
      expect(calls).toBe(0)
      expect(await readdir(other)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('requires an explicit approval token before invoking npm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-installer-'))
    try {
      let calls = 0
      const installer = new DbGateInstaller({ workspaceRoot: root, npmPath: '/workspace/node/bin/npm', runner: { run: async () => { calls += 1; return { exitCode: 0, stdout: '', stderr: '' } } } })
      await expect(installer.ensureInstalled(true, 'short')).rejects.toThrow(/explicit approval/i)
      await expect(installer.ensureInstalled(false, 'approved-token-123456')).rejects.toThrow(/explicit approval/i)
      expect(calls).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('installs the pinned packages under the workspace runtime with lifecycle scripts disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-installer-'))
    try {
      let request: { args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> } | undefined
      const installer = new DbGateInstaller({ workspaceRoot: root, npmPath: '/workspace/node/bin/npm', runner: { run: async (args, cwd, env) => { request = { args, cwd, env }; await seedRuntimePackages(runtimeRoot); return { exitCode: 0, stdout: '', stderr: '' } } } })
      const workspaceRoot = await realpath(root)
      const runtimeRoot = join(workspaceRoot, '.backend-team/runtime/dbgate')
      await expect(installer.ensureInstalled(true, 'approved-token-123456')).resolves.toMatchObject({
        runtimeRoot,
        packages: ['dbgate-api@7.2.3', 'dbgate-web@7.2.3', 'dbgate-plugin-postgres@7.2.3'],
      })
      expect(await readFile(join(runtimeRoot, 'dbgate-postgres-serve.cjs'), 'utf8')).toContain("global.PLUGINS_DIR = path.join(__dirname, 'plugins')")
      expect(await readdir(join(runtimeRoot, 'plugins'))).toEqual(['dbgate-plugin-postgres'])
      expect(request).toEqual({
        args: ['/workspace/node/bin/npm', 'install', '--prefix', runtimeRoot, '--ignore-scripts', '--save-exact', 'dbgate-api@7.2.3', 'dbgate-web@7.2.3', 'dbgate-plugin-postgres@7.2.3'],
        cwd: workspaceRoot,
        env: { npm_config_ignore_scripts: 'true', npm_config_prefix: runtimeRoot },
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('writes the reviewed dependency overrides into the runtime package manifest before npm runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-policy-'))
    try {
      const runtimeRoot = join(await realpath(root), '.backend-team/runtime/dbgate')
      let manifest: Record<string, unknown> | undefined
      const installer = new DbGateInstaller({ workspaceRoot: root, npmPath: '/workspace/node/bin/npm', runner: { run: async () => {
        await seedRuntimePackages(runtimeRoot)
        manifest = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8')) as Record<string, unknown>
        return { exitCode: 0, stdout: '', stderr: '' }
      } } })
      await installer.ensureInstalled(true, 'approved-token-123456')
      expect(manifest).toMatchObject({
        private: true,
        dependencies: { 'dbgate-api': '7.2.3', 'dbgate-web': '7.2.3', 'dbgate-plugin-postgres': '7.2.3' },
        overrides: {
          'dbgate-api': { jsonwebtoken: '9.0.3', tar: '7.5.22' },
          'flat-cache': { flatted: '3.4.4' },
          'external-editor': { tmp: '0.2.7' },
          qs: '6.16.0',
          http: '0.0.1-security',
        },
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('cleans legacy connector remnants before npm and rejects them if npm reintroduces them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-policy-clean-'))
    try {
      const runtimeRoot = join(root, '.backend-team/runtime/dbgate')
      await mkdir(join(runtimeRoot, 'node_modules/dbgate-serve'), { recursive: true })
      await mkdir(join(runtimeRoot, 'node_modules/.bin'), { recursive: true })
      await symlink('../xlsx/bin/xlsx.njs', join(runtimeRoot, 'node_modules/.bin/xlsx'))
      let staleEntriesSeen = true
      const installer = new DbGateInstaller({ workspaceRoot: root, npmPath: '/workspace/node/bin/npm', runner: { run: async () => {
        staleEntriesSeen = (await readdir(join(runtimeRoot, 'node_modules'))).includes('dbgate-serve') || (await readdir(join(runtimeRoot, 'node_modules/.bin'))).includes('xlsx')
        await seedRuntimePackages(runtimeRoot)
        await mkdir(join(runtimeRoot, 'node_modules/xlsx'), { recursive: true })
        return { exitCode: 0, stdout: '', stderr: '' }
      } } })
      await expect(installer.ensureInstalled(true, 'approved-token-123456')).rejects.toThrow(/disabled package xlsx/i)
      expect(staleEntriesSeen).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('preserves user package metadata and unrelated dependencies while adding the reviewed policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-policy-preserve-'))
    try {
      const runtimeRoot = join(root, '.backend-team/runtime/dbgate')
      await mkdir(runtimeRoot, { recursive: true })
      await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({
        name: 'user-runtime',
        dependencies: { 'user-package': '1.2.3' },
        overrides: { 'dbgate-api': { 'user-patch': '1.0.0' } },
        customConfig: { keep: true },
      }))
      let manifest: Record<string, unknown> | undefined
      const installer = new DbGateInstaller({ workspaceRoot: root, npmPath: '/workspace/node/bin/npm', runner: { run: async () => {
        await seedRuntimePackages(runtimeRoot)
        manifest = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8')) as Record<string, unknown>
        return { exitCode: 0, stdout: '', stderr: '' }
      } } })
      await installer.ensureInstalled(true, 'approved-token-123456')
      expect(manifest).toMatchObject({
        name: 'user-runtime',
        dependencies: { 'user-package': '1.2.3', 'dbgate-api': '7.2.3', 'dbgate-web': '7.2.3', 'dbgate-plugin-postgres': '7.2.3' },
        overrides: { 'dbgate-api': { 'user-patch': '1.0.0', jsonwebtoken: '9.0.3', tar: '7.5.22' } },
        customConfig: { keep: true },
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fails on a conflicting reviewed override before invoking npm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-dbgate-policy-conflict-'))
    try {
      const runtimeRoot = join(root, '.backend-team/runtime/dbgate')
      await mkdir(runtimeRoot, { recursive: true })
      await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({ overrides: { 'dbgate-api': { tar: '6.2.1' } } }))
      let calls = 0
      const installer = new DbGateInstaller({ workspaceRoot: root, npmPath: '/workspace/node/bin/npm', runner: { run: async () => { calls += 1; return { exitCode: 0, stdout: '', stderr: '' } } } })
      await expect(installer.ensureInstalled(true, 'approved-token-123456')).rejects.toThrow(/conflicts.*dependency policy/i)
      expect(calls).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a symlinked package manifest before writing through it', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-dbgate-policy-link-'))
    const root = join(fixture, 'workspace')
    const outside = join(fixture, 'outside')
    try {
      await mkdir(join(root, '.backend-team/runtime/dbgate'), { recursive: true })
      await mkdir(outside)
      await writeFile(join(outside, 'package.json'), JSON.stringify({ customConfig: { keep: true } }))
      await symlink(join(outside, 'package.json'), join(root, '.backend-team/runtime/dbgate/package.json'))
      let calls = 0
      const installer = new DbGateInstaller({ workspaceRoot: root, npmPath: '/workspace/node/bin/npm', runner: { run: async () => { calls += 1; return { exitCode: 0, stdout: '', stderr: '' } } } })
      await expect(installer.ensureInstalled(true, 'approved-token-123456')).rejects.toThrow(/symlink|manifest|directory/i)
      expect(calls).toBe(0)
      expect(await readFile(join(outside, 'package.json'), 'utf8')).toContain('customConfig')
    } finally { await rm(fixture, { recursive: true, force: true }) }
  })
})

async function seedRuntimePackages(runtimeRoot: string): Promise<void> {
  for (const name of ['dbgate-api', 'dbgate-web', 'dbgate-plugin-postgres']) {
    const directory = join(runtimeRoot, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '7.2.3' }))
  }
}
