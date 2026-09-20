import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { CommandRequest, CommandResult, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { sha256Canonical } from '@dsh-backend-team/core'
import { ArtifactDownloader } from '@dsh-backend-team/platform-macos'
import type { InstallPlan, InstallPlanArtifact, InstallPlanCommand } from './install-plan.js'
import { selectUvArtifact, type UvManifest } from './runtime-manifest.js'
import { assertRuntimeEnvironment, runtimeDownloadPath, runtimePath } from './runtime-environment.js'

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024
const MAX_ENTRY_BYTES = 128 * 1024 * 1024
const MAX_ENTRIES = 1024
export interface ApprovedRuntimeCommandRunner { run(request: CommandRequest): Promise<CommandResult> }
export interface UvInstallerOptions { readonly layout: WorkspaceLayout; readonly environment: Readonly<Record<string, string>>; readonly plan: InstallPlan; readonly artifact: InstallPlanArtifact; readonly manifest: UvManifest; readonly architecture: 'arm64' | 'x64'; readonly downloader: ArtifactDownloader; readonly runCommand: ApprovedRuntimeCommandRunner['run'] }
export interface VerifiedUvArtifact { readonly url: string; readonly bytes: number; readonly sha256: string; readonly destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz' }
const installedUvBrand: unique symbol = Symbol('InstalledUv')
/** Evidence produced only after the archive and both published executables were verified. */
export interface InstalledUv { readonly [installedUvBrand]: true; readonly uvPath: string; readonly uvxPath: string; readonly version: '0.12.3'; readonly artifact: VerifiedUvArtifact; readonly uvSha256: string; readonly uvxSha256: string; readonly verifiedCommand: InstallPlanCommand; readonly versionEvidence: 'executed' | 'archive' }
export interface UvInstallerTestHooks { readonly beforeOwnedCleanup?: (path: string) => Promise<void> }
let hooks: UvInstallerTestHooks = {}
export function __setUvInstallerTestHooksForTest(value: UvInstallerTestHooks): () => void { const old = hooks; hooks = value; return () => { hooks = old } }
interface OwnedFile { readonly path: string; readonly dev: number; readonly ino: number }
interface VerifiedArchive { readonly file: OwnedFile; readonly bytes: Buffer }
const issuedUvEvidence = new WeakMap<object, string>()

export class UvInstaller {
  constructor(private readonly options: UvInstallerOptions) {}
  async ensureInstalled(): Promise<InstalledUv> {
    const env = assertRuntimeEnvironment(this.options.layout, this.options.environment)
    const uvPath = runtimePath(this.options.layout, 'bin/uv'); const uvxPath = runtimePath(this.options.layout, 'bin/uvx')
    assertPlanDestination(this.options.plan)
    const artifact = approvedArtifact(this.options.plan, this.options.artifact, this.options.manifest, this.options.architecture)
    const planFingerprint = sha256Canonical(this.options.plan); const trustFingerprint = uvTrustFingerprint(this.options)
    const prefetched = await this.prefetchArtifacts()
    const archivePath = prefetched.get(artifact.destination)
    if (archivePath === undefined) throw new Error('approved uv archive was not prefetched')
    const uvExists = await exists(uvPath); const uvxExists = await exists(uvxPath)
    if (uvExists || uvxExists) {
      if (!uvExists || !uvxExists) throw new Error('existing uv installation is incomplete')
      const archive = await verifyArtifact(archivePath, this.options.layout, artifact)
      const files = readUvArchive(archive.bytes, this.options.architecture)
      let uvSha256 = await executableSha256(uvPath, this.options.layout); let uvxSha256 = await executableSha256(uvxPath, this.options.layout)
      const archiveUvSha256 = sha256Buffer(files.uv); const archiveUvxSha256 = sha256Buffer(files.uvx)
      if (uvSha256 !== archiveUvSha256 || uvxSha256 !== archiveUvxSha256) throw new Error('existing uv installation content does not match the approved archive evidence')
      const verifiedCommand = approvedCommand(this.options.plan, uvPath, ['--version'], dirname(uvPath), env)
      uvSha256 = await executableSha256(uvPath, this.options.layout); uvxSha256 = await executableSha256(uvxPath, this.options.layout)
      if (uvSha256 !== archiveUvSha256 || uvxSha256 !== archiveUvxSha256) throw new Error('existing uv installation content changed during evidence recovery')
      // Recovery proves identity from the exact approved archive and plan. It must
      // not execute installed code before Spec Kit provenance closes the full runtime.
      return issueInstalledUv(this.options, planFingerprint, trustFingerprint, uvPath, uvxPath, '0.12.3', artifact, uvSha256, uvxSha256, verifiedCommand, 'archive')
    }
    const archive = await verifyArtifact(archivePath, this.options.layout, artifact)
    try {
      const files = readUvArchive(archive.bytes, this.options.architecture)
      await ensureDirectory(dirname(uvPath), this.options.layout)
      await publish(files.uv, uvPath, this.options.layout)
      await publish(files.uvx, uvxPath, this.options.layout)
      const verified = await this.verifyVersion(uvPath, env)
      const uvSha256 = await executableSha256(uvPath, this.options.layout); const uvxSha256 = await executableSha256(uvxPath, this.options.layout)
      if (uvSha256 !== sha256Buffer(files.uv) || uvxSha256 !== sha256Buffer(files.uvx)) throw new Error('published uv installation content does not match the approved archive evidence')
      const installed = issueInstalledUv(this.options, planFingerprint, trustFingerprint, uvPath, uvxPath, verified.version, artifact, uvSha256, uvxSha256, verified.command, 'executed')
      return installed
    } catch (error) {
      // Published paths are deliberately never rolled back by pathname: another same-UID
      // process may replace one after publication. A partial install is fail-closed on retry.
      throw error
    }
  }

  private async prefetchArtifacts(): Promise<ReadonlyMap<string, string>> {
    const fetched = new Map<string, string>()
    for (const artifact of this.options.plan.artifacts) {
      const destination = resolve(this.options.layout.root, artifact.destination)
      assertInside(this.options.layout.root, destination, 'runtime artifact')
      const path = await this.options.downloader.fetch({ component: artifact.component, version: artifact.version, license: artifact.license, source: artifact.source, url: artifact.url, allowedHosts: artifact.allowedHosts, destination, bytes: artifact.bytes, sha256: artifact.sha256 })
      if (path !== destination || fetched.has(artifact.destination)) throw new Error('runtime artifact prefetch returned an unexpected or duplicate destination')
      fetched.set(artifact.destination, path)
    }
    return fetched
  }
  private async verifyVersion(uvPath: string, environment: Readonly<Record<string, string>>): Promise<{ readonly version: '0.12.3'; readonly command: InstallPlanCommand }> {
    const command = approvedCommand(this.options.plan, uvPath, ['--version'], dirname(uvPath), environment)
    const result = await this.options.runCommand(toRequest(command, 'verify workspace-local uv'))
    const version = result.exitCode === 0 ? parseUvVersion(result.stdout, this.options.architecture) : undefined
    if (version === undefined) throw new Error('workspace-local uv version verification failed')
    return Object.freeze({ version, command })
  }
}

/** Internal runtime boundary used by SpecKitInstaller; not re-exported from the package. */
export async function assertInstalledUvEvidence(installed: InstalledUv, layout: WorkspaceLayout, plan: InstallPlan): Promise<void> {
  if (typeof installed !== 'object' || installed === null || issuedUvEvidence.get(installed) !== sha256Canonical(plan)) throw new Error('Spec Kit requires verified evidence issued by UvInstaller for this install plan')
  const uvPath = runtimePath(layout, 'bin/uv'); const uvxPath = runtimePath(layout, 'bin/uvx')
  if (installed.uvPath !== uvPath || installed.uvxPath !== uvxPath || installed.version !== '0.12.3' || (installed.versionEvidence !== 'executed' && installed.versionEvidence !== 'archive')) throw new Error('verified uv evidence does not match the workspace runtime')
  if (approvedCommand(plan, uvPath, ['--version'], dirname(uvPath), buildRuntimeEnvironmentForEvidence(layout, plan)) !== installed.verifiedCommand) throw new Error('verified uv command evidence does not match the approved plan')
  if (await executableSha256(uvPath, layout) !== installed.uvSha256 || await executableSha256(uvxPath, layout) !== installed.uvxSha256) throw new Error('verified uv evidence no longer matches current executable content')
}

export function parseUvVersion(value: string, architecture: 'arm64' | 'x64'): '0.12.3' | undefined {
  const target = architecture === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const match = /^uv 0\.12\.3(?:\+\d+)? \((?:(?:[0-9a-f]{9}) (?:\d{4}-\d{2}-\d{2}) )?([a-z0-9_]+-apple-darwin)\)\r?\n?$/u.exec(value)
  return match?.[1] === target ? '0.12.3' : undefined
}
function assertPlanDestination(plan: InstallPlan): void { if (plan.destination !== '.backend-team/cache/downloads/uv-0.12.3.tar.gz') throw new Error('runtime install archive destination must be the workspace cache download path') }
function approvedArtifact(plan: InstallPlan, artifact: InstallPlanArtifact, manifest: UvManifest, architecture: 'arm64' | 'x64'): InstallPlanArtifact {
  const selected = selectUvArtifact(manifest, architecture); const direct = approvedDirectUrl(selected.url)
  if (manifest.version !== '0.12.3' || plan.intent !== 'runtime-install' || plan.tool !== 'uv' || plan.version !== manifest.version || plan.source !== manifest.source || plan.license !== manifest.license) throw new Error('runtime install plan does not match the approved uv manifest')
  if (artifact.component !== selected.component || artifact.version !== selected.version || artifact.license !== selected.license || artifact.source !== selected.source || artifact.url !== selected.url || artifact.bytes !== selected.bytes || artifact.sha256 !== selected.sha256 || artifact.destination !== selected.destination || !sameStrings(artifact.allowedHosts, selected.allowedHosts) || !sameStrings(selected.allowedHosts, [direct.hostname])) throw new Error('uv artifact does not match the complete approved manifest metadata')
  const matched = plan.artifacts.find((item) => item.component === 'uv' && item.version === manifest.version)
  if (matched === undefined || !sameArtifact(matched, artifact)) throw new Error('runtime install plan does not approve uv artifact')
  return Object.freeze({ ...matched, allowedHosts: Object.freeze([...matched.allowedHosts]) })
}
function approvedDirectUrl(value: string): URL { const url = new URL(value); if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') throw new Error('approved uv manifest requires a credential-free HTTPS direct URL'); return url }
export function approvedCommand(plan: InstallPlan, executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): InstallPlanCommand { const command = plan.commands.find((item) => item.executable === executable && item.cwd === cwd && item.codeWillExecute === true && sameStrings(item.args, args) && sameRecord(item.env, env)); if (command === undefined) throw new Error(`runtime install plan does not approve command: ${basename(executable)} ${args.join(' ')}`); return command }
export function toRequest(command: InstallPlanCommand, purpose: string): CommandRequest { return Object.freeze({ executable: command.executable, args: command.args, cwd: command.cwd, env: command.env, purpose, risk: 'install', executionFingerprint: command.executionFingerprint, networkPolicy: command.networkPolicy, ...(command.expectedExecutableSha256 === undefined ? {} : { expectedExecutableSha256: command.expectedExecutableSha256 }) }) }

async function verifyArtifact(path: string, layout: WorkspaceLayout, artifact: InstallPlanArtifact): Promise<VerifiedArchive> {
  if (path !== runtimeDownloadPath(layout)) throw new Error('uv archive downloader returned an unexpected destination')
  const canonical = await realpath(path); if (canonical !== path) throw new Error('uv archive real path changed'); assertInside(layout.teamDir, canonical, 'uv archive')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const retained = await handle.stat(); const current = await lstat(path)
    if (!sameIdentity(retained, current) || !retained.isFile() || retained.nlink !== 1 || retained.size !== artifact.bytes || retained.size > MAX_ARCHIVE_BYTES || (retained.mode & 0o777) !== 0o600) throw new Error('uv archive size or identity is invalid')
    const bytes = await handle.readFile()
    const after = await handle.stat(); const currentAfter = await lstat(path)
    if (!sameIdentity(retained, after) || !sameIdentity(retained, currentAfter) || retained.size !== after.size || sha256Buffer(bytes) !== artifact.sha256) throw new Error('uv archive hash or identity is invalid')
    return { file: { path, dev: retained.dev, ino: retained.ino }, bytes }
  } finally { await handle.close() }
}
function readUvArchive(raw: Buffer, architecture: 'arm64' | 'x64'): { readonly uv: Buffer; readonly uvx: Buffer } {
  const archive = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: MAX_UNPACKED_BYTES }) : raw
  if (archive.length === 0 || archive.length > MAX_UNPACKED_BYTES || archive.length % 512 !== 0) throw new Error('uv archive format is invalid')
  const root = architecture === 'arm64' ? 'uv-aarch64-apple-darwin' : 'uv-x86_64-apple-darwin'
  const directory = `${root}/`; const uvName = `${root}/uv`; const uvxName = `${root}/uvx`
  const seen = new Set<string>(); const found = new Map<string, Buffer>(); let total = 0; let entries = 0; let ended = false
  for (let offset = 0; offset < archive.length;) {
    const header = archive.subarray(offset, offset + 512); offset += 512
    if (header.length !== 512) throw new Error('uv archive header is truncated')
    if (header.every((byte) => byte === 0)) { if (archive.length - offset < 512 || !archive.subarray(offset, offset + 512).every((byte) => byte === 0) || !archive.subarray(offset + 512).every((byte) => byte === 0)) throw new Error('uv archive terminator is invalid'); ended = true; break }
    if (++entries > MAX_ENTRIES) throw new Error('uv archive has too many entries')
    validateHeader(header); const name = archiveName(header); const size = octal(header.subarray(124, 136)); const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!)
    if (seen.has(name)) throw new Error('uv archive contains duplicate entries'); seen.add(name)
    if (name === directory) {
      if (type !== '5' || size !== 0) throw new Error('uv archive root directory is unsafe')
    } else if ((name !== uvName && name !== uvxName) || type !== '0' || size > MAX_ENTRY_BYTES) throw new Error('uv archive contains an unexpected entry')
    if (total + size > MAX_UNPACKED_BYTES || offset + Math.ceil(size / 512) * 512 > archive.length) throw new Error('uv archive entry is unsafe')
    total += size
    const body = Buffer.from(archive.subarray(offset, offset + size)); offset += Math.ceil(size / 512) * 512
    if (name === uvName) found.set('uv', body)
    if (name === uvxName) found.set('uvx', body)
  }
  if (!ended || entries !== 3 || !seen.has(directory) || found.get('uv') === undefined || found.get('uvx') === undefined) throw new Error('uv archive does not match the official architecture layout')
  return { uv: found.get('uv')!, uvx: found.get('uvx')! }
}
function validateHeader(header: Buffer): void { if (header.subarray(257, 263).toString('ascii') !== 'ustar\0' || header.subarray(263, 265).toString('ascii') !== '00') throw new Error('uv archive magic or version is invalid'); const declared = octal(header.subarray(148, 156)); const copy = Buffer.from(header); copy.fill(0x20, 148, 156); if (declared !== copy.reduce((sum, byte) => sum + byte, 0)) throw new Error('uv archive header checksum is invalid') }
function archiveName(header: Buffer): string { const name = tarString(header.subarray(0, 100)); const prefix = tarString(header.subarray(345, 500)); if (name.length === 0) throw new Error('uv archive contains an empty entry'); return prefix.length === 0 ? name : `${prefix}/${name}` }
function tarString(value: Buffer): string { const zero = value.indexOf(0); return value.subarray(0, zero === -1 ? value.length : zero).toString('utf8') }
function octal(value: Buffer): number { const text = tarString(value).trim(); if (!/^[0-7]+$/u.test(text)) throw new Error('uv archive contains invalid octal field'); const parsed = Number.parseInt(text, 8); if (!Number.isSafeInteger(parsed)) throw new Error('uv archive contains invalid octal field'); return parsed }
async function publish(content: Buffer, destination: string, layout: WorkspaceLayout): Promise<OwnedFile> {
  const temporary = `${destination}.publish-${randomUUID()}`; let temp: OwnedFile | undefined; let linked = false
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700)
    try { await handle.writeFile(content); await handle.chmod(0o700); await handle.sync() } finally { await handle.close() }
    temp = await owned(temporary, layout, 0o700)
    const { link } = await import('node:fs/promises'); await link(temporary, destination); linked = true
    // Keep the temporary inode witness until the destination is proven to be that inode.
    await assertSameOwned(destination, temp, layout, 0o700, 2)
    await unlinkOwned(temp, 2)
    return await assertSameOwned(destination, temp, layout, 0o700, 1)
  } finally {
    // Once linked, never pathname-clean either link on failure: it may have been replaced.
    if (temp !== undefined && !linked) await removeOwned(temp)
  }
}
async function ensureDirectory(path: string, layout: WorkspaceLayout): Promise<void> { assertInside(layout.teamDir, path, 'runtime directory'); let current = layout.teamDir; for (const part of relative(layout.teamDir, path).split('/').filter(Boolean)) { current = `${current}/${part}`; try { const details = await lstat(current); if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('runtime directory is unsafe') } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(current, { mode: 0o700 }); await chmod(current, 0o700) } } }
async function owned(path: string, layout: WorkspaceLayout, mode?: number): Promise<OwnedFile> { const canonical = await realpath(path); if (canonical !== path) throw new Error('runtime file real path changed'); assertInside(layout.teamDir, path, 'runtime file'); const details = await lstat(path); if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || (mode !== undefined && (details.mode & 0o777) !== mode)) throw new Error('runtime file identity or permissions are invalid'); return { path, dev: details.dev, ino: details.ino } }
async function assertSameOwned(path: string, expected: OwnedFile, layout: WorkspaceLayout, mode: number, links: number): Promise<OwnedFile> { const canonical = await realpath(path); if (canonical !== path) throw new Error('runtime file real path changed'); assertInside(layout.teamDir, path, 'runtime file'); const details = await lstat(path); if (!details.isFile() || details.isSymbolicLink() || details.nlink !== links || details.dev !== expected.dev || details.ino !== expected.ino || (details.mode & 0o777) !== mode) throw new Error(`runtime publication was replaced: ${path}`); return { path, dev: details.dev, ino: details.ino } }
async function unlinkOwned(file: OwnedFile, links = 1): Promise<void> { await hooks.beforeOwnedCleanup?.(file.path); const details = await lstat(file.path); if (!details.isFile() || details.isSymbolicLink() || details.nlink !== links || details.dev !== file.dev || details.ino !== file.ino) throw new Error(`refusing to remove replaced runtime file: ${file.path}`); await unlink(file.path) }
async function removeOwned(file: OwnedFile): Promise<void> { try { await unlinkOwned(file) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
function assertInside(root: string, path: string, label: string): void { const rel = relative(root, path); if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes workspace runtime`) }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]) }
function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean { const a = Object.keys(left).sort(); const b = Object.keys(right).sort(); return sameStrings(a, b) && a.every((key) => left[key] === right[key]) }
function sameArtifact(left: InstallPlanArtifact, right: InstallPlanArtifact): boolean { return left.component === right.component && left.version === right.version && left.license === right.license && left.source === right.source && left.url === right.url && left.bytes === right.bytes && left.sha256 === right.sha256 && left.destination === right.destination && sameStrings(left.allowedHosts, right.allowedHosts) }
function sha256Buffer(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex') }
function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino }
async function executableSha256(path: string, layout: WorkspaceLayout): Promise<string> {
  assertInside(layout.teamDir, path, 'runtime executable')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const retained = await handle.stat(); const current = await lstat(path)
    if (!sameIdentity(retained, current) || !retained.isFile() || retained.nlink !== 1 || (retained.mode & 0o777) !== 0o700) throw new Error('runtime executable identity or permissions are invalid')
    const hash = sha256Buffer(await handle.readFile()); const after = await handle.stat(); const currentAfter = await lstat(path)
    if (!sameIdentity(retained, after) || !sameIdentity(retained, currentAfter) || retained.size !== after.size) throw new Error('runtime executable content changed during verification')
    return hash
  } finally { await handle.close() }
}
function uvTrustFingerprint(options: UvInstallerOptions): string { return sha256Canonical({ plan: options.plan, manifest: options.manifest, artifact: options.artifact, architecture: options.architecture }) }
function issueInstalledUv(options: UvInstallerOptions, planFingerprint: string, trustFingerprint: string, uvPath: string, uvxPath: string, version: '0.12.3', artifact: InstallPlanArtifact, uvSha256: string, uvxSha256: string, verifiedCommand: InstallPlanCommand, versionEvidence: InstalledUv['versionEvidence']): InstalledUv {
  if (sha256Canonical(options.plan) !== planFingerprint || uvTrustFingerprint(options) !== trustFingerprint) throw new Error('approved uv plan or manifest changed during verification')
  const evidence = { uvPath, uvxPath, version, artifact: Object.freeze({ url: artifact.url, bytes: artifact.bytes, sha256: artifact.sha256, destination: '.backend-team/cache/downloads/uv-0.12.3.tar.gz' as const }), uvSha256, uvxSha256, verifiedCommand, versionEvidence } as InstalledUv
  Object.defineProperty(evidence, installedUvBrand, { value: true })
  Object.freeze(evidence)
  issuedUvEvidence.set(evidence, planFingerprint)
  return evidence
}

function buildRuntimeEnvironmentForEvidence(_layout: WorkspaceLayout, plan: InstallPlan): Readonly<Record<string, string>> {
  const command = plan.commands.find((item) => item.args.length === 1 && item.args[0] === '--version' && basename(item.executable) === 'uv')
  if (command === undefined) throw new Error('verified uv command is absent from the approved plan')
  return command.env
}
