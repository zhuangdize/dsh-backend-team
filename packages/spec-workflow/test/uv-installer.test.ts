import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactDownloader, createWorkspaceLayout, initializeWorkspaceLayout } from '@dsh-backend-team/platform-macos'
import { sha256Canonical } from '@dsh-backend-team/core'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRuntimeEnvironment, runtimeDownloadPath } from '../src/runtime-environment.js'
import { __setUvInstallerTestHooksForTest, parseUvVersion, UvInstaller } from '../src/uv-installer.js'
import type { UvManifest } from '../src/runtime-manifest.js'
import type { InstallPlanArtifact } from '../src/install-plan.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('UvInstaller', () => {
  it('publishes only safe archive executables with private permissions and verifies the pinned version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-install-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const archive = await writeArchive(layout.cacheDir, officialArchive('#!/bin/sh\nprintf "uv 0.12.3 (aarch64-apple-darwin)\\n"\n', '#!/bin/sh\nexit 0\n'))
    const commands: unknown[] = []; const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const installer = new UvInstaller({
      layout, environment: buildRuntimeEnvironment(layout),
      plan: planFor(layout, artifact), artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader: fixtureDownloader(layout, archive),
      runCommand: async (request) => { commands.push(request); return { exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 } },
    })

    const result = await installer.ensureInstalled()

    expect(result.uvPath).toBe(join(layout.runtimeDir, 'bin/uv'))
    expect(await readFile(result.uvPath, 'utf8')).toContain('uv 0.12.3')
    expect((await stat(result.uvPath)).mode & 0o777).toBe(0o700)
    expect((await stat(result.uvxPath)).mode & 0o777).toBe(0o700)
    expect(result.versionEvidence).toBe('executed')
    expect(commands).toMatchObject([{ executable: result.uvPath, args: ['--version'], cwd: join(layout.runtimeDir, 'bin'), env: buildRuntimeEnvironment(layout) }])
  })

  it.each([
    ['traversal', [{ name: '../uv', body: 'bad' }, { name: 'bundle/uvx', body: 'ok' }]],
    ['symlink', [{ name: 'bundle/uv', body: 'bad', type: '2' }, { name: 'bundle/uvx', body: 'ok' }]],
    ['hard link', [{ name: 'bundle/uv', body: 'bad', type: '1' }, { name: 'bundle/uvx', body: 'ok' }]],
    ['oversized entry', [{ name: 'bundle/uv', body: 'bad', size: 200_000_000 }, { name: 'bundle/uvx', body: 'ok' }]],
    ['duplicate executable', [{ name: 'a/uv', body: 'ok' }, { name: 'b/uv', body: 'bad' }, { name: 'bundle/uvx', body: 'ok' }]],
  ])('rejects a %s archive before publishing executables', async (_kind, entries) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-malformed-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const archive = await writeArchive(layout.cacheDir, entries)
    const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const installer = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: planFor(layout, artifact), artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader: fixtureDownloader(layout, archive), runCommand: async () => ({ exitCode: 0, stdout: 'uv 0.12.3', stderr: '', durationMs: 1 }) })

    await expect(installer.ensureInstalled()).rejects.toThrow(/archive|unsafe|duplicate|link|traversal/i)
    await expect(stat(join(layout.runtimeDir, 'bin/uv'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves published paths on post-publication failure so a retry fails closed instead of deleting a replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-cleanup-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const archive = await writeArchive(layout.cacheDir, officialArchive())
    const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const installer = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: planFor(layout, artifact), artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader: fixtureDownloader(layout, archive), runCommand: async () => ({ exitCode: 0, stdout: 'uv 0.12.2', stderr: '', durationMs: 1 }) })

    await expect(installer.ensureInstalled()).rejects.toThrow(/version/i)
    await expect(stat(join(layout.runtimeDir, 'bin/uv'))).resolves.toBeDefined()
    await expect(stat(join(layout.runtimeDir, 'bin/uvx'))).resolves.toBeDefined()
    await expect(stat(runtimeDownloadPath(layout))).resolves.toBeDefined()
  })

  it('does not attempt pathname rollback after executable publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-race-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const archive = await writeArchive(layout.cacheDir, officialArchive()); const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const replacement = join(layout.runtimeDir, 'bin/replacement'); const target = join(layout.runtimeDir, 'bin/uv'); let raced = false
    const restore = __setUvInstallerTestHooksForTest({ beforeOwnedCleanup: async (path) => { if (!raced && path === target) { raced = true; await writeFile(replacement, 'user replacement', { mode: 0o600 }); await rename(replacement, target) } } })
    try { const installer = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: planFor(layout, artifact), artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader: fixtureDownloader(layout, archive), runCommand: async () => ({ exitCode: 0, stdout: 'uv 0.12.2\n', stderr: '', durationMs: 1 }) }); await expect(installer.ensureInstalled()).rejects.toThrow(/version/i) } finally { restore() }
    expect(raced).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('uv')
  })

  it('rejects a non-Team plan destination before download or command execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-destination-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const archive = await writeArchive(layout.cacheDir, officialArchive()); const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    let fetches = 0; let commands = 0; const downloader = new ArtifactDownloader({ workspaceRoot: layout.root, capability: { executeApprovedArtifact: async (_scope, _signal, operation) => operation() }, fetch: async () => { fetches++; return new Response(await readFile(archive)) } })
    const installer = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: { ...planFor(layout, artifact), destination: '../outside.tar.gz' }, artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader, runCommand: async () => { commands++; return { exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 } } })
    await expect(installer.ensureInstalled()).rejects.toThrow(/destination/i)
    expect(fetches).toBe(0); expect(commands).toBe(0)
  })

  it('rejects an altered PATH before download or command execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-env-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const archive = await writeArchive(layout.cacheDir, officialArchive()); const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const installer = new UvInstaller({ layout, environment: { ...buildRuntimeEnvironment(layout), PATH: '/host/uv' }, plan: planFor(layout, artifact), artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader: fixtureDownloader(layout, archive), runCommand: async () => { throw new Error('must not run') } })
    await expect(installer.ensureInstalled()).rejects.toThrow(/environment/i)
  })

  it('rejects a tampered uvx on repeat without a second download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-repeat-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const archive = await writeArchive(layout.cacheDir, officialArchive()); const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    let commands = 0
    const installer = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: planFor(layout, artifact), artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader: fixtureDownloader(layout, archive), runCommand: async () => { commands++; return { exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 } } })
    await installer.ensureInstalled(); await writeFile(join(layout.runtimeDir, 'bin/uvx'), 'tampered', { mode: 0o700 })
    await expect(installer.ensureInstalled()).rejects.toThrow(/content|evidence/i)
    expect(commands).toBe(1)
  })

  it('rebuilds trusted evidence from the exact archive without executing recovered uv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-recover-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const archive = await writeArchive(layout.cacheDir, officialArchive())
    const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const plan = planFor(layout, artifact); const manifest = manifestFor(artifact); let fetches = 0; let commands = 0
    const downloader = new ArtifactDownloader({ workspaceRoot: layout.root, capability: { executeApprovedArtifact: async (_scope, _signal, operation) => operation() }, fetch: async () => { fetches++; return new Response(await readFile(archive)) } })
    const runCommand = async () => { commands++; return { exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 } }
    await new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan, artifact, manifest, architecture: 'arm64', downloader, runCommand }).ensureInstalled()

    const recovered = await new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan, artifact, manifest, architecture: 'arm64', downloader, runCommand: async () => { throw new Error('recovered uv must not execute before provenance validation') } }).ensureInstalled()

    expect(recovered.uvSha256).toBe(createHash('sha256').update('uv').digest('hex'))
    expect(recovered.uvxSha256).toBe(createHash('sha256').update('uvx').digest('hex'))
    expect(fetches).toBe(1)
    expect(commands).toBe(1)
    expect(recovered.verifiedCommand.args).toEqual(['--version'])
    expect(recovered.versionEvidence).toBe('archive')
  })

  it('rejects recovered uvx that no longer matches the exact approved archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-recover-race-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const archive = await writeArchive(layout.cacheDir, officialArchive())
    const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const plan = planFor(layout, artifact); const manifest = manifestFor(artifact); const downloader = fixtureDownloader(layout, archive)
    await new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan, artifact, manifest, architecture: 'arm64', downloader, runCommand: async () => ({ exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 }) }).ensureInstalled()
    await writeFile(join(layout.runtimeDir, 'bin/uvx'), 'tampered', { mode: 0o700 })
    const recovering = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan, artifact, manifest, architecture: 'arm64', downloader, runCommand: async () => { throw new Error('recovered uv must not execute') } })

    await expect(recovering.ensureInstalled()).rejects.toThrow(/content|archive|evidence/i)
  })

  it('rejects an artifact URL that is not the manifest direct URL before side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-direct-url-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const archive = await writeArchive(layout.cacheDir, officialArchive())
    const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz?mirror=1', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const approved = { ...artifact, url: 'https://releases.example.test/uv.tar.gz' }; let fetches = 0; let commands = 0
    const downloader = new ArtifactDownloader({ workspaceRoot: layout.root, capability: { executeApprovedArtifact: async (_scope, _signal, operation) => operation() }, fetch: async () => { fetches++; return new Response(await readFile(archive)) } })
    const installer = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: planFor(layout, artifact), artifact, manifest: manifestFor(approved), architecture: 'arm64', downloader, runCommand: async () => { commands++; return { exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 } } })

    await expect(installer.ensureInstalled()).rejects.toThrow(/manifest|direct URL|artifact/i)
    expect(fetches).toBe(0)
    expect(commands).toBe(0)
  })

  it('refuses to issue evidence if the approved plan changes during verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-plan-race-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const archive = await writeArchive(layout.cacheDir, officialArchive())
    const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const plan = planFor(layout, artifact)
    const installer = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan, artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader: fixtureDownloader(layout, archive), runCommand: async () => { (plan as { destination: string }).destination = '.backend-team/cache/downloads/replaced.tar.gz'; return { exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 } } })

    await expect(installer.ensureInstalled()).rejects.toThrow(/plan|changed|evidence/i)
  })

  it.each(['checksum', 'magic', 'truncation'])('rejects malformed tar %s before publication', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-header-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const archive = await writeArchive(layout.cacheDir, officialArchive()); const bytes = Buffer.from(await readFile(archive))
    if (kind === 'checksum') bytes[0] = 0x78
    if (kind === 'magic') bytes.write('bad!!!', 257)
    if (kind === 'truncation') bytes.fill(1, bytes.length - 512)
    await writeFile(archive, bytes)
    const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), allowedHosts: ['releases.example.test'] })
    const installer = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: planFor(layout, artifact), artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader: fixtureDownloader(layout, archive), runCommand: async () => ({ exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 }) })
    await expect(installer.ensureInstalled()).rejects.toThrow(/header|magic|archive/i)
    await expect(stat(join(layout.runtimeDir, 'bin/uv'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects entries outside the exact official archive layout before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-uv-flood-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root)); const archive = await writeArchive(layout.cacheDir, [...officialArchive(), { name: 'uv-aarch64-apple-darwin/extra', body: '' }]); const artifact = uvArtifact({ url: 'https://releases.example.test/uv.tar.gz', bytes: (await stat(archive)).size, sha256: await sha256(archive), allowedHosts: ['releases.example.test'] })
    const installer = new UvInstaller({ layout, environment: buildRuntimeEnvironment(layout), plan: planFor(layout, artifact), artifact, manifest: manifestFor(artifact), architecture: 'arm64', downloader: fixtureDownloader(layout, archive), runCommand: async () => ({ exitCode: 0, stdout: 'uv 0.12.3 (aarch64-apple-darwin)\n', stderr: '', durationMs: 1 }) })
    await expect(installer.ensureInstalled()).rejects.toThrow(/unexpected|layout/i)
  })
})

describe('uv verification boundaries', () => {
  it.each(['uv 0.12.3 (aarch64-apple-darwin)\n', 'uv 0.12.3+4 (53b0f5d92 2026-08-25 aarch64-apple-darwin)\r\n'])('accepts only the official arm64 uv version format: %j', (value) => { expect(parseUvVersion(value, 'arm64')).toBe('0.12.3') })
  it('accepts the pinned x64 target and rejects a cross-architecture binary', () => {
    expect(parseUvVersion('uv 0.12.3 (x86_64-apple-darwin)\n', 'x64')).toBe('0.12.3')
    expect(parseUvVersion('uv 0.12.3 (x86_64-apple-darwin)\n', 'arm64')).toBeUndefined()
  })
  it.each(['uv 0.12.3\n', 'uv 0.12.30 (aarch64-apple-darwin)\n', 'junk uv 0.12.3 (aarch64-apple-darwin)\n', 'uv 0.12.3 (aarch64-apple-darwin)\nsecond', 'uv 0.12.3 arbitrary\n'])('rejects an unsafe uv version output: %j', (value) => { expect(parseUvVersion(value, 'arm64')).toBeUndefined() })
})

async function sha256(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex') }
function officialArchive(uv = 'uv', uvx = 'uvx', architecture: 'arm64' | 'x64' = 'arm64'): readonly { name: string; body: string; type?: string }[] {
  const root = architecture === 'arm64' ? 'uv-aarch64-apple-darwin' : 'uv-x86_64-apple-darwin'
  return [{ name: `${root}/`, body: '', type: '5' }, { name: `${root}/uv`, body: uv }, { name: `${root}/uvx`, body: uvx }]
}
function uvArtifact(value: { readonly url: string; readonly bytes: number; readonly sha256: string; readonly allowedHosts: readonly string[] }): InstallPlanArtifact {
  return { component: 'uv', version: '0.12.3', license: 'MIT', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', ...value, destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz' }
}
function planFor(layout: Awaited<ReturnType<typeof initializeWorkspaceLayout>>, artifact: InstallPlanArtifact) {
  const env = buildRuntimeEnvironment(layout); const uv = join(layout.runtimeDir, 'bin/uv')
  const args = ['--version']; const cwd = join(layout.runtimeDir, 'bin'); const networkPolicy = 'deny' as const
  return { intent: 'runtime-install' as const, tool: 'uv', version: '0.12.3', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', license: 'MIT', destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz', artifacts: [artifact], managedPaths: [], commands: [{ executable: uv, args, cwd, env, executionFingerprint: sha256Canonical({ executable: uv, args, cwd, env, codeWillExecute: true, networkPolicy }), codeWillExecute: true, networkPolicy }] }
}
function manifestFor(artifact: Pick<InstallPlanArtifact, 'url' | 'bytes' | 'sha256'>): UvManifest { const selected = uvArtifact({ ...artifact, allowedHosts: ['releases.example.test'] }); return { component: 'uv', version: '0.12.3', license: 'MIT', source: 'https://github.com/astral-sh/uv/releases/tag/0.12.3', artifacts: { 'darwin-arm64': selected, 'darwin-x64': selected } } }
function fixtureDownloader(layout: Awaited<ReturnType<typeof initializeWorkspaceLayout>>, archive: string): ArtifactDownloader { return new ArtifactDownloader({ workspaceRoot: layout.root, capability: { executeApprovedArtifact: async (_scope, _signal, operation) => operation() }, fetch: async () => new Response(await readFile(archive)) }) }
async function writeArchive(directory: string, entries: readonly { name: string; body: string; type?: string; size?: number }[]): Promise<string> {
  const archive = join(directory, 'uv.tar')
  const bytes = Buffer.concat([...entries.flatMap((entry) => {
    const header = Buffer.alloc(512); header.write(entry.name); header.write('0000700\0', 100); header.write(`${(entry.size ?? entry.body.length).toString(8).padStart(11, '0')}\0`, 124); header.write(entry.type ?? '0', 156); header.write('ustar\0', 257); header.write('00', 263); header.fill(0x20, 148, 156); header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
    return [header, Buffer.concat([Buffer.from(entry.body), Buffer.alloc((512 - entry.body.length % 512) % 512)])]
  }), Buffer.alloc(1024)])
  await writeFile(archive, bytes); await chmod(archive, 0o600); return archive
}
