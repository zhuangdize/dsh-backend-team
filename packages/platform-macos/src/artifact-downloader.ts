import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { lstat, mkdir, open, realpath, rm, link } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

export interface ArtifactManifest { readonly component: string; readonly version: string; readonly license: string; readonly source: string; readonly url: string; readonly destination: string; readonly bytes: number; readonly sha256: string; readonly allowedHosts: readonly string[] }
export interface ArtifactFetchScope { readonly component: string; readonly version: string; readonly license: string; readonly source: string; readonly url: string; readonly allowedHosts: readonly string[]; readonly destination: string; readonly bytes: number; readonly sha256: string }
/** Policy-engine-owned, single-use capability. The downloader never creates a permissive default. */
export interface ArtifactFetchCapability { executeApprovedArtifact<T>(scope: ArtifactFetchScope, signal: AbortSignal, operation: () => Promise<T>): Promise<T> }
export interface ArtifactDownloaderOptions { readonly workspaceRoot: string; readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number; readonly capability: ArtifactFetchCapability }
interface ArtifactDownloaderTestHooks {
  readonly afterOpen?: (path: string, handle: Awaited<ReturnType<typeof open>>) => Promise<void>
  readonly afterLink?: (destination: string) => Promise<void>
  readonly write?: (handle: Awaited<ReturnType<typeof open>>, data: Uint8Array, offset: number, length: number) => Promise<{ readonly bytesWritten: number }>
  readonly sync?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>
  readonly close?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>
  readonly link?: (existingPath: string, destinationPath: string) => Promise<void>
  readonly unlink?: (path: string) => Promise<void>
  readonly rollbackUnlink?: (path: string) => Promise<void>
  readonly syncParent?: (path: string) => Promise<void>
}
let testHooks: ArtifactDownloaderTestHooks = {}
export function __setArtifactDownloaderTestHooksForTest(hooks: ArtifactDownloaderTestHooks): () => void { const previous = testHooks; testHooks = hooks; return () => { testHooks = previous } }

export class ArtifactDownloader {
  private readonly options: ArtifactDownloaderOptions
  private readonly request: typeof globalThis.fetch
  private readonly workspaceRoot: string
  private readonly timeoutMs: number
  constructor(options: ArtifactDownloaderOptions) {
    if (options.capability === undefined || typeof options.capability.executeApprovedArtifact !== 'function') throw new Error('policy execution capability is required')
    this.options = options
    if (options.workspaceRoot.includes('\0')) throw new Error('workspace root contains NUL')
    this.workspaceRoot = realpathSync(resolve(options.workspaceRoot))
    this.request = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 120_000
  }

  async fetch(manifest: ArtifactManifest, signal?: AbortSignal): Promise<string> {
    validateManifest(manifest)
    validateUrl(manifest.url, manifest.allowedHosts)
    const requested = resolve(manifest.destination)
    const rawRelative = relative(resolve(this.options.workspaceRoot), requested)
    const canonicalRelative = relative(this.workspaceRoot, requested)
    const requestedRelative = insideRelative(canonicalRelative) ? canonicalRelative : rawRelative
    if (!insideRelative(requestedRelative)) throw new Error('destination escapes workspace')
    const destination = resolve(this.workspaceRoot, requestedRelative)
    const partial = `${destination}.partial`
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const scopeFor = (url: string): ArtifactFetchScope => Object.freeze({ component: manifest.component, version: manifest.version, license: manifest.license, source: manifest.source, url, allowedHosts: Object.freeze([...manifest.allowedHosts]), destination, bytes: manifest.bytes, sha256: manifest.sha256 })
    const download = async (url: string, redirects: number): Promise<string> => {
      validateUrl(url, manifest.allowedHosts)
      return this.options.capability.executeApprovedArtifact(scopeFor(url), requestSignal, async () => {
        let response: Response | undefined
        let handle: Awaited<ReturnType<typeof open>> | undefined
        let created = false
        let ownerIdentity: { readonly dev: number; readonly ino: number } | undefined
        let bodyConsumed = false
        let bodyCancelAttempted = false
        let partialOwned = false
        let destinationOwned = false
        let publishRollbackComplete = false
        try {
          response = await this.request(url, { redirect: 'manual', signal: requestSignal })
          if (response.status >= 300 && response.status < 400) {
            bodyCancelAttempted = true
            try { await response.body?.cancel() } catch (error: unknown) { throw new AggregateError([error], `redirect body cancellation failed: ${error instanceof Error ? error.message : String(error)}`) }
            if (redirects >= 3) throw new Error('redirect limit exceeded')
            const location = response.headers.get('location')
            if (location === null) throw new Error('redirect response has no location')
            return download(new URL(location, url).toString(), redirects + 1)
          }
          if (!response.ok || response.body === null) throw new Error(`download failed with HTTP ${response.status}`)
          const contentLength = response.headers.get('content-length')
          if (contentLength !== null && (!/^\d+$/u.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))) throw new Error('invalid content-length')
          const contentEncoding = response.headers.get('content-encoding')
          if (contentLength !== null && contentEncoding === null && Number(contentLength) !== manifest.bytes) throw new Error('download content-length does not match approved exact bytes')
          handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          created = true
          const openedIdentity = await verifyPartialIdentity(handle, partial)
          ownerIdentity = openedIdentity
          await testHooks.afterOpen?.(partial, handle)
          const hash = createHash('sha256')
          let bytes = 0
          for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
            bytes += data.byteLength
            if (bytes > manifest.bytes) throw new Error(`download exceeds approved exact bytes (${manifest.bytes})`)
            hash.update(data)
            await writeAll(handle, data)
          }
          bodyConsumed = true
          if (bytes !== manifest.bytes) throw new Error(`download size does not match approved exact bytes (${manifest.bytes})`)
          if (hash.digest('hex') !== manifest.sha256) throw new Error('sha256 mismatch')
          await verifyPartialIdentity(handle, partial, openedIdentity)
          await syncHandle(handle)
          await verifyPartialIdentity(handle, partial, openedIdentity)
          await closeHandle(handle)
          handle = undefined
          partialOwned = true
          try {
            await (testHooks.link ?? link)(partial, destination)
            destinationOwned = true
            await testHooks.afterLink?.(destination)
            await (testHooks.unlink ?? (async (path: string) => rm(path)))(partial)
            partialOwned = false
            created = false
            await syncParent(dirname(destination))
            return destination
          } catch (publishError: unknown) {
            const rollbackErrors: unknown[] = []
            if (destinationOwned) await removeOwnedPath(destination, ownerIdentity).then(() => { destinationOwned = false }).catch((error: unknown) => rollbackErrors.push(error))
            if (partialOwned) await removeOwnedPath(partial, ownerIdentity, testHooks.rollbackUnlink).then(() => { partialOwned = false; created = false }).catch((error: unknown) => rollbackErrors.push(error))
            await syncParent(dirname(destination)).catch((error: unknown) => rollbackErrors.push(error))
            publishRollbackComplete = !destinationOwned && !partialOwned
            if (rollbackErrors.length > 0) throw new AggregateError([publishError, ...rollbackErrors], 'artifact publish rollback failed')
            throw publishError
          }
        } catch (error: unknown) {
          const cleanupErrors: unknown[] = []
          if (!bodyConsumed && !bodyCancelAttempted && response?.body !== null && response?.body !== undefined) {
            // A stream may still be locked by Readable.fromWeb after an abort.
            // Cancellation is best-effort cleanup and must never hide the root error.
            await response.body.cancel().catch(() => undefined)
          }
          if (handle !== undefined) await closeHandle(handle).catch((closeError: unknown) => cleanupErrors.push(closeError))
          if (created && !publishRollbackComplete) await removeOwnPartial(partial, ownerIdentity).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError))
          if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], `artifact download and cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
          throw error
        }
      })
    }
    return this.options.capability.executeApprovedArtifact(scopeFor(manifest.url), requestSignal, async () => {
      const preparedDestination = await prepareDestination(manifest.destination, this.workspaceRoot)
      if (preparedDestination !== destination) throw new Error('prepared artifact destination changed')
      await rejectExistingArtifactPath(partial)
      if (await verifyExistingArtifact(destination, manifest)) return destination
      return download(manifest.url, 0)
    })
  }
}

function validateManifest(manifest: ArtifactManifest): void {
  if (typeof manifest.component !== 'string' || manifest.component.length === 0 || typeof manifest.version !== 'string' || manifest.version.length === 0 || typeof manifest.license !== 'string' || manifest.license.length === 0 || typeof manifest.source !== 'string' || manifest.source.length === 0) throw new Error('artifact metadata must be complete')
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1) throw new Error('bytes must be a positive safe integer')
  if (!/^[a-f0-9]{64}$/u.test(manifest.sha256)) throw new Error('sha256 must be a lowercase SHA-256 digest')
  if (!isAbsolute(manifest.destination) || manifest.destination.includes('\0')) throw new Error('destination must be absolute and NUL-free')
}
function insideRelative(value: string): boolean { return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value) }

function validateUrl(value: string, allowedHosts: readonly string[]): void {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('artifact downloads require HTTPS')
  if (url.username !== '' || url.password !== '') throw new Error('artifact URL credentials are forbidden')
  if (url.port !== '') throw new Error('artifact URL ports are forbidden')
  if (!allowedHosts.includes(url.hostname)) throw new Error(`artifact host is not allowed: ${url.hostname}`)
}

async function prepareDestination(input: string, workspaceRoot: string): Promise<string> {
  const sourceDestination = resolve(input)
  const sourceParent = dirname(sourceDestination)
  const canonicalRoot = await realpath(workspaceRoot)
  const existingParent = await findExistingAncestor(sourceParent)
  const canonicalExistingParent = await realpath(existingParent)
  const missingRelative = relative(existingParent, sourceParent)
  const parent = missingRelative === '' ? canonicalExistingParent : resolve(canonicalExistingParent, missingRelative)
  const destination = resolve(parent, sourceDestination.slice(sourceParent.length + 1))
  const rootRelative = relative(canonicalRoot, parent)
  if (rootRelative.startsWith('..') || isAbsolute(rootRelative)) throw new Error('destination escapes workspace')
  let current = canonicalRoot
  for (const segment of rootRelative.split('/').filter(Boolean)) {
    current = resolve(current, segment)
    try {
      const details = await lstat(current)
      if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('destination has unsafe ancestor')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o700 })
    }
  }
  return destination
}

async function verifyExistingArtifact(path: string, manifest: ArtifactManifest): Promise<boolean> {
  let before: Awaited<ReturnType<typeof lstat>>
  try { before = await lstat(path) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size !== manifest.bytes || (before.mode & 0o777) !== 0o600) throw new Error(`existing artifact does not match approved identity: ${path}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    const first = await sha256Handle(handle)
    const second = await sha256Handle(handle)
    const after = await handle.stat()
    const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== manifest.bytes || (opened.mode & 0o777) !== 0o600 || opened.dev !== before.dev || opened.ino !== before.ino || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || first !== manifest.sha256 || second !== first) throw new Error(`existing artifact does not match approved bytes or hash: ${path}`)
    return true
  } finally { await handle.close() }
}

async function findExistingAncestor(path: string): Promise<string> {
  let current = path
  while (true) {
    try { await lstat(current); return current } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw new Error('destination has no existing ancestor')
      current = parent
    }
  }
}

async function rejectExistingArtifactPath(path: string): Promise<void> {
  try {
    const details = await lstat(path)
    if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) throw new Error(`artifact target already exists or is unsafe: ${path}`)
    throw new Error(`artifact target already exists: ${path}`)
  } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

async function removeOwnPartial(path: string, owner: { readonly dev: number; readonly ino: number } | undefined): Promise<void> {
  await removeOwnedPath(path, owner)
}

async function removeOwnedPath(path: string, owner: { readonly dev: number; readonly ino: number } | undefined, remove?: (path: string) => Promise<void>): Promise<void> {
  const details = await lstat(path)
  if (details.isSymbolicLink() || !details.isFile() || details.nlink < 1 || (owner !== undefined && (details.dev !== owner.dev || details.ino !== owner.ino))) throw new Error('refusing to remove replaced artifact')
  await (remove ?? (async (target: string) => rm(target)))(path)
}

async function syncParent(path: string): Promise<void> {
  if (testHooks.syncParent !== undefined) { await testHooks.syncParent(path); return }
  const parentHandle = await open(path, constants.O_RDONLY)
  try { await parentHandle.sync() } finally { await parentHandle.close() }
}

async function syncHandle(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  if (testHooks.sync !== undefined) await testHooks.sync(handle)
  else await handle.sync()
}

async function closeHandle(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  if (testHooks.close !== undefined) await testHooks.close(handle)
  else await handle.close()
}

async function verifyPartialIdentity(handle: Awaited<ReturnType<typeof open>>, path: string, expected?: { readonly dev: number; readonly ino: number }): Promise<{ readonly dev: number; readonly ino: number }> {
  const retained = await handle.stat()
  const current = await lstat(path)
  if (!retained.isFile() || retained.nlink !== 1 || !current.isFile() || current.nlink !== 1 || retained.dev !== current.dev || retained.ino !== current.ino || (expected !== undefined && (expected.dev !== retained.dev || expected.ino !== retained.ino))) throw new Error('partial artifact identity changed')
  return { dev: retained.dev, ino: retained.ino }
}


async function writeAll(handle: Awaited<ReturnType<typeof open>>, data: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    const result = await (testHooks.write === undefined ? handle.write(data, offset, data.byteLength - offset) : testHooks.write(handle, data, offset, data.byteLength - offset))
    if (result.bytesWritten === 0) throw new Error('artifact short write')
    offset += result.bytesWritten
  }
}

async function sha256Handle(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}
