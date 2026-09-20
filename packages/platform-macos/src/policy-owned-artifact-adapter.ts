import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, writeFile, lstat } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { dirname, join, relative, resolve } from 'node:path'
import { ArtifactDownloader, type ArtifactFetchCapability } from './artifact-downloader.js'
import type { GuardedArtifactAdapter, NodeRuntimeInstallationReceipt } from './workspace-node-bootstrap.js'
import type { NvmManifest, NodeRuntimeManifest } from './node-runtime-manifest.js'

/** Product-facing adapter. Policy capability is mandatory and never defaulted. */
export class PolicyOwnedArtifactAdapter implements GuardedArtifactAdapter {
  private readonly downloader: ArtifactDownloader
  constructor(options: { workspaceRoot: string; capability: ArtifactFetchCapability; fetch?: typeof globalThis.fetch }) {
    this.downloader = new ArtifactDownloader(options)
  }
  async provisionNvm(manifest: NvmManifest, targetDirectory: string, approval: { readonly token: string }, signal?: AbortSignal): Promise<string> {
    const host = new URL(manifest.url).hostname
    if (host !== 'raw.githubusercontent.com') throw new Error(`NVM loader host is not approved: ${host}`)
    if (approval.token.length === 0) throw new Error('NVM approval token is required')
    const loader = await this.downloader.fetch({ component: 'nvm', version: manifest.exactVersion, license: manifest.license, source: manifest.source, url: manifest.url, destination: join(targetDirectory, 'nvm.sh'), bytes: manifest.bytes, sha256: manifest.sha256, allowedHosts: ['raw.githubusercontent.com'] }, signal)
    if (await sha256File(loader) !== manifest.sha256) throw new Error('NVM loader hash verification failed')
    return loader
  }
  async provisionNodeRuntime(manifest: NodeRuntimeManifest, targetDirectory: string, approval: { readonly token: string }, signal?: AbortSignal): Promise<NodeRuntimeInstallationReceipt> {
    const host = new URL(manifest.url).hostname
    if (host !== 'nodejs.org' || approval.token.length === 0) throw new Error('node artifact policy scope is invalid')
    const versionRoot = join(targetDirectory, 'versions', 'node', `v${manifest.exactVersion}`)
    const archive = await this.downloader.fetch({ component: 'node-runtime', version: manifest.exactVersion, license: manifest.license, source: manifest.source, url: manifest.url, destination: `${targetDirectory}/.node-${manifest.exactVersion}-${manifest.architecture}.tar.gz`, bytes: manifest.bytes, sha256: manifest.sha256, allowedHosts: ['nodejs.org'] }, signal)
    if (await sha256File(archive) !== manifest.sha256) throw new Error('Node archive hash verification failed')
    const existing = await readExistingRuntimeReceipt(versionRoot, manifest, archive, targetDirectory)
    if (existing !== undefined) {
      await verifyRuntimeAgainstArchive(archive, targetDirectory, manifest, existing)
      return existing
    }
    const paths = await extractNodeArchive(archive, targetDirectory, manifest)
    const hashes = await hashRuntimePaths(paths)
    const runtimeTreeSha256 = await hashRuntimeTree(join(targetDirectory, 'versions', 'node', `v${manifest.exactVersion}`))
    const receipt = { ...paths, ...hashes, runtimeTreeSha256, exactVersion: manifest.exactVersion, architecture: manifest.architecture, archiveSha256: manifest.sha256 }
    try {
      await writeRuntimeReceipt(versionRoot, receipt)
      return receipt
    } catch (error) {
      await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
}

async function sha256File(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex') }
type RuntimePaths = { readonly node: string; readonly npm: string; readonly npx: string }
const runtimeReceiptName = '.backend-team-runtime-receipt.json'

async function readExistingRuntimeReceipt(versionRoot: string, manifest: NodeRuntimeManifest, archive: string, targetDirectory: string): Promise<NodeRuntimeInstallationReceipt | undefined> {
  let rootDetails: Awaited<ReturnType<typeof lstat>>
  try { rootDetails = await lstat(versionRoot) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) throw new Error('existing Node runtime root is unsafe')
  const receiptPath = join(versionRoot, runtimeReceiptName)
  let value: unknown
  try {
    const details = await lstat(receiptPath)
    if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) throw new Error('existing Node runtime receipt is unsafe')
    value = JSON.parse(await readFile(receiptPath, 'utf8'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('existing Node runtime receipt is missing')
    if (error instanceof SyntaxError) throw new Error('existing Node runtime receipt is invalid')
    throw error
  }
  if ((!isRuntimeReceipt(value) && !isLegacyRuntimeReceipt(value))) throw new Error('existing Node runtime receipt does not match approved manifest')
  const receiptValue = value as RuntimeReceiptValue
  if (receiptValue.exactVersion !== manifest.exactVersion || receiptValue.architecture !== manifest.architecture || receiptValue.archiveSha256 !== manifest.sha256) throw new Error('existing Node runtime receipt does not match approved manifest')
  const paths = await verifyRuntimePaths(versionRoot)
  const hashes = await hashRuntimePaths(paths)
  const runtimeTreeSha256 = await hashRuntimeTree(versionRoot)
  if (paths.node !== receiptValue.node || paths.npm !== receiptValue.npm || paths.npx !== receiptValue.npx || hashes.nodeSha256 !== receiptValue.nodeSha256 || hashes.npmSha256 !== receiptValue.npmSha256 || hashes.npxSha256 !== receiptValue.npxSha256 || (receiptValue.runtimeTreeSha256 !== undefined && runtimeTreeSha256 !== receiptValue.runtimeTreeSha256)) throw new Error('existing Node runtime receipt does not match runtime contents')
  const receipt: NodeRuntimeInstallationReceipt = { ...paths, ...hashes, runtimeTreeSha256, exactVersion: receiptValue.exactVersion, architecture: receiptValue.architecture, archiveSha256: receiptValue.archiveSha256 }
  if (receiptValue.runtimeTreeSha256 === undefined) {
    await verifyRuntimeAgainstArchive(archive, targetDirectory, manifest, receipt)
    await replaceRuntimeReceipt(versionRoot, receipt)
  }
  return receipt
}

async function writeRuntimeReceipt(versionRoot: string, receipt: NodeRuntimeInstallationReceipt): Promise<void> {
  const path = join(versionRoot, runtimeReceiptName)
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(JSON.stringify(receipt) + '\n')
    await handle.sync()
  } finally { await handle.close() }
}

async function replaceRuntimeReceipt(versionRoot: string, receipt: NodeRuntimeInstallationReceipt): Promise<void> {
  const path = join(versionRoot, runtimeReceiptName)
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error('existing Node runtime receipt is unsafe')
  const temporary = join(versionRoot, `${runtimeReceiptName}.migrate-${randomBytes(16).toString('hex')}`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(JSON.stringify(receipt) + '\n')
    await handle.sync()
  } finally { await handle.close() }
  try {
    const current = await lstat(path)
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino) throw new Error('existing Node runtime receipt changed during migration')
    await rename(temporary, path)
    const parent = await open(versionRoot, constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function verifyRuntimePaths(versionRoot: string): Promise<RuntimePaths> {
  const canonicalRoot = await realpath(versionRoot)
  const bin = join(versionRoot, 'bin')
  const binDetails = await lstat(bin)
  if (binDetails.isSymbolicLink() || !binDetails.isDirectory()) throw new Error('existing Node runtime bin directory is unsafe')
  const paths = { node: await realpath(join(bin, 'node')), npm: await realpath(join(bin, 'npm')), npx: await realpath(join(bin, 'npx')) }
  for (const path of Object.values(paths)) {
    const pathRelative = relative(canonicalRoot, path)
    if (pathRelative.startsWith('..') || pathRelative.includes('\\') || pathRelative.split('/').includes('..')) throw new Error('Node runtime binary escapes version root')
    const details = await stat(path)
    if (!details.isFile() || details.size === 0 || (details.mode & 0o111) === 0) throw new Error('existing Node runtime binary is invalid')
  }
  return paths
}

type RuntimeHashes = { readonly nodeSha256: string; readonly npmSha256: string; readonly npxSha256: string }
async function hashRuntimePaths(paths: RuntimePaths): Promise<RuntimeHashes> {
  return { nodeSha256: await sha256File(paths.node), npmSha256: await sha256File(paths.npm), npxSha256: await sha256File(paths.npx) }
}

type RuntimeTreeEntry = { readonly path: string; readonly kind: 'file' | 'directory' | 'symlink'; readonly mode: number; readonly bytes?: number; readonly sha256?: string; readonly target?: string }
async function hashRuntimeTree(versionRoot: string): Promise<string> {
  const entries: RuntimeTreeEntry[] = []
  await collectRuntimeTree(versionRoot, '', entries)
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const digest = createHash('sha256')
  for (const entry of entries) digest.update(JSON.stringify(entry)).update('\n')
  return digest.digest('hex')
}
async function collectRuntimeTree(root: string, relativeRoot: string, entries: RuntimeTreeEntry[]): Promise<void> {
  const directory = relativeRoot === '' ? root : join(root, relativeRoot)
  for (const name of await readdir(directory)) {
    if (relativeRoot === '' && name === runtimeReceiptName) continue
    const relativePath = relativeRoot === '' ? name : `${relativeRoot}/${name}`
    const path = join(root, relativePath)
    const details = await lstat(path)
    const mode = details.mode & 0o7777
    if (details.isDirectory()) {
      entries.push({ path: relativePath, kind: 'directory', mode })
      await collectRuntimeTree(root, relativePath, entries)
    } else if (details.isFile()) {
      const data = await readFile(path)
      const after = await lstat(path)
      if (!after.isFile() || after.dev !== details.dev || after.ino !== details.ino || after.size !== details.size || after.mode !== details.mode) throw new Error('runtime file changed during integrity verification')
      entries.push({ path: relativePath, kind: 'file', mode, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') })
    } else if (details.isSymbolicLink()) {
      const target = await readlink(path)
      const resolvedTarget = resolve(dirname(path), target)
      const targetRelative = relative(root, resolvedTarget)
      if (target.startsWith('/') || targetRelative.startsWith('..') || targetRelative.split('/').includes('..')) throw new Error('runtime symlink escapes version root')
      entries.push({ path: relativePath, kind: 'symlink', mode, target })
    } else throw new Error('runtime tree contains unsupported entry type')
  }
}

async function verifyRuntimeAgainstArchive(archive: string, targetDirectory: string, manifest: NodeRuntimeManifest, actual: NodeRuntimeInstallationReceipt): Promise<void> {
  const validationRoot = await mkdtemp(join(targetDirectory, '.verify-runtime-'))
  try {
    const expectedPaths = await extractNodeArchive(archive, validationRoot, manifest)
    const expected = await hashRuntimePaths(expectedPaths)
    const expectedTreeSha256 = await hashRuntimeTree(join(validationRoot, 'versions', 'node', `v${manifest.exactVersion}`))
    if (actual.nodeSha256 !== expected.nodeSha256 || actual.npmSha256 !== expected.npmSha256 || actual.npxSha256 !== expected.npxSha256 || actual.runtimeTreeSha256 !== expectedTreeSha256) throw new Error('existing Node runtime content does not match approved archive')
  } finally { await rm(validationRoot, { recursive: true, force: true }).catch(() => undefined) }
}

type RuntimeReceiptValue = Omit<NodeRuntimeInstallationReceipt, 'runtimeTreeSha256'> & { readonly runtimeTreeSha256?: string }
function isRuntimeReceipt(value: unknown): value is NodeRuntimeInstallationReceipt {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.node === 'string' && typeof record.npm === 'string' && typeof record.npx === 'string' && typeof record.exactVersion === 'string' && (record.architecture === 'darwin-arm64' || record.architecture === 'darwin-x64') && typeof record.archiveSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.archiveSha256) && typeof record.nodeSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.nodeSha256) && typeof record.npmSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.npmSha256) && typeof record.npxSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.npxSha256) && typeof record.runtimeTreeSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.runtimeTreeSha256)
}
function isLegacyRuntimeReceipt(value: unknown): value is RuntimeReceiptValue {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.node === 'string' && typeof record.npm === 'string' && typeof record.npx === 'string' && typeof record.exactVersion === 'string' && (record.architecture === 'darwin-arm64' || record.architecture === 'darwin-x64') && typeof record.archiveSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.archiveSha256) && typeof record.nodeSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.nodeSha256) && typeof record.npmSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.npmSha256) && typeof record.npxSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.npxSha256) && record.runtimeTreeSha256 === undefined
}

async function extractNodeArchive(archive: string, targetDirectory: string, manifest: NodeRuntimeManifest): Promise<RuntimePaths> {
  const tar = gunzipSync(await readFile(archive)); const prefix = `node-v${manifest.exactVersion}-${manifest.architecture}/`; const staging = join(targetDirectory, `.extract-${randomBytes(16).toString('hex')}`); const entries = new Map<string, { readonly kind: 'file' | 'dir' | 'symlink'; readonly data?: Buffer; readonly link?: string; readonly mode: number }>()
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const header = tar.subarray(offset, offset + 512); offset += 512
    if (header.every((value) => value === 0)) break
    const name = tarName(header); const size = parseTarNumber(header.subarray(124, 136)); const mode = parseTarNumber(header.subarray(100, 108)); const type = header[156] ?? 0
    const segments = name.split('/')
    if (!name.startsWith(prefix) || name.includes('\\') || segments.some((part, index) => (part === '' && index !== segments.length - 1) || part === '.' || part === '..')) throw new Error('Node archive contains an unsafe path')
    if (entries.has(name)) throw new Error('Node archive contains duplicate entries')
    const content = tar.subarray(offset, offset + size); if (content.byteLength !== size) throw new Error('Node archive entry is truncated'); offset += Math.ceil(size / 512) * 512
    if (type === 0 || type === 48) entries.set(name, { kind: 'file', data: Buffer.from(content), mode })
    else if (type === 5 || type === 53) entries.set(name, { kind: 'dir', mode })
    else if (type === 2 || type === 50) entries.set(name, { kind: 'symlink', link: tarText(header.subarray(157, 257)), mode })
    else throw new Error('Node archive contains unsupported entry type')
  }
  await mkdir(staging, { recursive: true, mode: 0o700 })
  let publishedRoot: string | undefined
  try {
    for (const [name, entry] of entries) {
      const relativeName = name.slice(prefix.length); if (relativeName === '') continue
      const destination = resolve(staging, relativeName); const rel = relative(staging, destination); if (rel.startsWith('..') || rel.split('/').includes('..')) throw new Error('Node archive extraction escaped staging')
      if (entry.kind === 'dir') await mkdir(destination, { recursive: true, mode: entry.mode & 0o777 || 0o755 })
      else if (entry.kind === 'file') { if (entry.data === undefined) throw new Error('Node archive file entry has no data'); await mkdir(dirname(destination), { recursive: true, mode: 0o755 }); await writeFile(destination, entry.data); await chmod(destination, entry.mode & 0o777 || 0o600) }
      else {
        const link = entry.link ?? ''; const target = resolve(dirname(destination), link); const targetRelative = relative(staging, target)
        if (link.startsWith('/') || targetRelative.startsWith('..') || targetRelative.split('/').includes('..')) throw new Error('Node archive symlink escapes root')
        await mkdir(dirname(destination), { recursive: true, mode: 0o755 }); await symlink(link, destination)
      }
    }
    const versionRoot = join(targetDirectory, 'versions', 'node', `v${manifest.exactVersion}`); await mkdir(dirname(versionRoot), { recursive: true, mode: 0o700 })
    try { await stat(versionRoot); throw new Error('selected Node runtime already exists') } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rename(staging, versionRoot); publishedRoot = versionRoot
    return await verifyRuntimePaths(versionRoot)
  } catch (error) { await rm(publishedRoot ?? staging, { recursive: true, force: true }).catch(() => undefined); throw error }
}

function tarText(value: Uint8Array): string { const end = value.indexOf(0); return Buffer.from(end < 0 ? value : value.subarray(0, end)).toString('utf8') }
function tarName(header: Uint8Array): string { const name = tarText(header.subarray(0, 100)); const prefix = tarText(header.subarray(345, 500)); return prefix === '' ? name : `${prefix}/${name}` }
function parseTarNumber(value: Uint8Array): number { const text = tarText(value).trim(); if (text === '') return 0; const parsed = Number.parseInt(text, 8); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Node archive contains an invalid size'); return parsed }
