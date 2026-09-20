import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, stat, symlink, rename, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactDownloader } from '../src/artifact-downloader.js'
import { __setArtifactDownloaderTestHooksForTest } from '../src/artifact-downloader.js'
import type { ArtifactFetchCapability, ArtifactFetchScope } from '../src/artifact-downloader.js'

const servers: Server[] = []
const roots: string[] = []
const metadata = Object.freeze({ component: 'fixture-artifact', version: '1.0.0', license: 'MIT', source: 'https://trusted.example/source' })
const capability: ArtifactFetchCapability = { async executeApprovedArtifact<T>(_scope: ArtifactFetchScope, _signal: AbortSignal, operation: () => Promise<T>): Promise<T> { return operation() } }
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  const { rm } = await import('node:fs/promises')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function serve(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<{ url: string; host: string }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  return { url: `http://127.0.0.1:${address.port}/artifact`, host: `127.0.0.1:${address.port}` }
}

function sha256(content: string): string { return createHash('sha256').update(content).digest('hex') }

describe('artifact downloader', () => {
  it('rejects non-HTTPS sources before making a request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-'))
    roots.push(root)
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root })
    await expect(downloader.fetch({ ...metadata, url: 'http://127.0.0.1/artifact', destination: join(root, 'x'), bytes: 10, sha256: sha256('x'), allowedHosts: ['127.0.0.1'] })).rejects.toThrow(/HTTPS/)
  })

  it('re-authorizes the exact source and destination before every request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-policy-'))
    roots.push(root)
    const canonicalRoot = await realpath(root)
    let networkCalls = 0
    const authorize = vi.fn(async (action: unknown) => {
      if (typeof action === 'object' && action !== null && 'url' in action && String(action.url).includes('/redirected')) return { effect: 'deny' as const, ruleId: 'test-deny', reason: 'redirect not approved' }
      return { effect: 'allow' as const, ruleId: 'test-allow', reason: 'approved', canonicalTargetPath: join(canonicalRoot, 'artifact') }
    })
    const downloader = new ArtifactDownloader({ capability: { async executeApprovedArtifact<T>(scope: ArtifactFetchScope, _signal: AbortSignal, operation: () => Promise<T>): Promise<T> { const decision = await authorize(scope); if (decision.effect === 'deny') throw new Error(`policy ${decision.effect}: ${decision.reason}`); return operation() } }, workspaceRoot: root, fetch: async () => { networkCalls += 1; return new Response(null, { status: 302, headers: { location: 'https://trusted.example/redirected' } }) } })
    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/start', destination: join(root, 'artifact'), bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/policy deny/)
    expect(networkCalls).toBe(1)
    expect(authorize).toHaveBeenCalledTimes(3)
  })

  it('removes a checksum-mismatched partial download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-'))
    roots.push(root)
    const response = await serve((_request, reply) => { reply.end('actual') })
    const destination = join(root, 'artifact')
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('actual', { status: 200 }) })
    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 6, sha256: sha256('expected'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/sha256 mismatch/)
    await expect(stat(`${destination}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
    void response
  })

  it('enforces the byte limit and cleans the partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-size-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('too-large', { status: 200 }) })
    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 3, sha256: sha256('too-large'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/bytes/i)
    await expect(stat(`${destination}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not trust wire content-length for encoded responses while retaining exact streamed checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-encoding-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200, headers: { 'content-length': '1', 'content-encoding': 'gzip' } }) })
    await downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })
    await expect(readFile(destination, 'utf8')).resolves.toBe('payload')
  })

  it('follows allowed redirects but rejects an unapproved redirect host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-redirect-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    const calls: string[] = []
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/first')) return new Response(null, { status: 302, headers: { location: 'https://trusted.example/second' } })
      return new Response('payload', { status: 200 })
    } })
    await downloader.fetch({ ...metadata, url: 'https://trusted.example/first', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })
    expect(calls).toEqual(['https://trusted.example/first', 'https://trusted.example/second'])
    await expect(readFile(destination, 'utf8')).resolves.toBe('payload')
  })

  it('rechecks redirect hosts and bounds redirect chains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-redirect-limit-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async (input) => new Response(null, { status: 302, headers: { location: String(input) } }) })
    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/loop', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/redirect limit/)
    const hostChanging = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example/artifact' } }) })
    await expect(hostChanging.fetch({ ...metadata, url: 'https://trusted.example/first', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/not allowed/)
  })

  it('rejects credentials, unapproved ports, and destinations outside before any mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-boundary-'))
    roots.push(root)
    const outside = join(root, '..', 'outside-artifact')
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => { throw new Error('network touched') } })
    const manifest = { ...metadata, destination: outside, bytes: 10, sha256: sha256('x'), allowedHosts: ['trusted.example'], url: 'https://user:pass@trusted.example/artifact' }
    await expect(downloader.fetch(manifest)).rejects.toThrow(/credential|origin|URL/i)
    await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(downloader.fetch({ ...manifest, url: 'https://trusted.example:8443/artifact', destination: join(root, 'port') })).rejects.toThrow(/port|origin/i)
    const outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-downloader-link-outside-'))
    roots.push(outsideRoot)
    await symlink(outsideRoot, join(root, 'link'))
    await expect(downloader.fetch({ ...manifest, url: 'https://trusted.example/artifact', destination: join(root, 'link', 'artifact') })).rejects.toThrow(/escapes|ancestor|outside the workspace/i)
  })

  it('rejects a pre-existing hard-linked or special partial target without deleting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-special-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    const partial = `${destination}.partial`
    const { link, writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'seed'), 'seed')
    await link(join(root, 'seed'), partial)
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200 }) })
    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/partial|link|exists/i)
    await expect(readFile(partial, 'utf8')).resolves.toBe('seed')
  })

  it('reuses a private pre-existing artifact only after exact byte and hash verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-reuse-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    await writeFile(destination, 'payload', { mode: 0o600 })
    await chmod(destination, 0o600)
    let networkCalls = 0
    let capabilityCalls = 0
    const downloader = new ArtifactDownloader({
      capability: { async executeApprovedArtifact<T>(_scope: ArtifactFetchScope, _signal: AbortSignal, operation: () => Promise<T>): Promise<T> { capabilityCalls += 1; return operation() } },
      workspaceRoot: root,
      fetch: async () => { networkCalls += 1; throw new Error('network must not be used for a verified cache hit') },
    })

    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).resolves.toBe(join(await realpath(root), 'artifact'))
    expect(networkCalls).toBe(0)
    expect(capabilityCalls).toBe(1)
  })

  it('keeps the artifact capability active through body verification, fsync, and publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-capability-lifetime-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    let active = false
    let capabilityCalls = 0
    const restore = __setArtifactDownloaderTestHooksForTest({
      afterOpen: async () => { expect(active).toBe(true) },
      write: async (handle, data, offset, length) => { expect(active).toBe(true); return handle.write(data, offset, length) },
      sync: async (handle) => { expect(active).toBe(true); await handle.sync() },
      afterLink: async () => { expect(active).toBe(true) },
    })
    try {
      const downloader = new ArtifactDownloader({
        capability: {
          async executeApprovedArtifact<T>(_scope: ArtifactFetchScope, _signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
            capabilityCalls += 1
            active = true
            try { return await operation() } finally { active = false }
          },
        },
        workspaceRoot: root,
        fetch: async () => new Response('payload', { status: 200 }),
      })
      await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).resolves.toBe(join(await realpath(root), 'artifact'))
      expect(capabilityCalls).toBe(2)
      expect(active).toBe(false)
    } finally { restore() }
  })

  it('rejects a mismatched pre-existing artifact without overwriting or fetching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-reuse-mismatch-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    await writeFile(destination, 'altered', { mode: 0o600 })
    await chmod(destination, 0o600)
    let networkCalls = 0
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => { networkCalls += 1; throw new Error('network must not run') } })

    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/existing artifact|hash|bytes/i)
    expect(networkCalls).toBe(0)
    await expect(readFile(destination, 'utf8')).resolves.toBe('altered')
  })

  it('cannot create destination parents after its callback-scoped capability is closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-closed-'))
    roots.push(root)
    const parent = join(root, 'new/cache/path')
    const downloader = new ArtifactDownloader({
      workspaceRoot: root,
      capability: { executeApprovedArtifact: async () => { throw new Error('approved install session is closed') } },
      fetch: async () => new Response('payload'),
    })

    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination: join(parent, 'artifact'), bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/closed/i)
    await expect(stat(parent)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not publish or delete a replacement partial pathname after open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-swap-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    const replacement = `${destination}.partial`
    const original = `${replacement}.original`
    const restore = __setArtifactDownloaderTestHooksForTest({ afterOpen: async (path) => { await rename(path, original); await writeFile(path, 'attacker') } })
    try {
      const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200 }) })
      await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/identity|cleanup|replaced/i)
      await expect(readFile(replacement, 'utf8')).resolves.toBe('attacker')
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { restore() }
  })

  it('rejects malformed content lengths and honors request timeout/abort', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-timeout-'))
    roots.push(root)
    const badLength = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200, headers: { 'content-length': 'not-a-number' } }) })
    await expect(badLength.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination: join(root, 'bad'), bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/content-length/i)
    const controller = new AbortController()
    const slow = new ArtifactDownloader({ capability, workspaceRoot: root, timeoutMs: 1, fetch: async (_url, init) => { await new Promise((resolve) => setTimeout(resolve, 20)); if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError'); return new Response('payload', { status: 200 }) } })
    await expect(slow.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination: join(root, 'slow'), bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] }, controller.signal)).rejects.toThrow(/abort|timeout/i)
  })

  it('preserves the original stream error when a response body fails while being consumed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-stream-error-'))
    roots.push(root)
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode('x'))
        else controller.error(new Error('stream failed'))
      },
    })
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response(body, { status: 200 }) })
    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination: join(root, 'artifact'), bytes: 2, sha256: sha256('xx'), allowedHosts: ['trusted.example'] })).rejects.toThrow('stream failed')
  })

  it('preserves an abort error when a response body is locked during cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-stream-abort-'))
    roots.push(root)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'))
        setTimeout(() => controller.error(new DOMException('aborted', 'AbortError')), 20)
      },
    })
    const controller = new AbortController()
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response(body, { status: 200 }) })
    setTimeout(() => controller.abort(), 5)
    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination: join(root, 'artifact'), bytes: 2, sha256: sha256('xx'), allowedHosts: ['trusted.example'] }, controller.signal)).rejects.toThrow(/abort|timeout/i)
  })

  it('rejects redirect responses without a valid approved HTTPS location', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-location-'))
    roots.push(root)
    const missing = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response(null, { status: 302 }) })
    await expect(missing.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination: join(root, 'missing'), bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/location/i)
    const calls: string[] = []
    const relative = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async (input) => {
      calls.push(String(input))
      return calls.length === 1 ? new Response(null, { status: 302, headers: { location: '/next' } }) : new Response('payload', { status: 200 })
    } })
    await relative.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination: join(root, 'relative'), bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })
    expect(calls).toEqual(['https://trusted.example/artifact', 'https://trusted.example/next'])
  })

  it('rolls back the published destination when post-link cleanup or parent sync fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-transaction-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    const restore = __setArtifactDownloaderTestHooksForTest({ afterLink: async () => { throw new Error('post-link fault') } })
    try {
      const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200 }) })
      const failure = await downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(AggregateError)
      expect((failure as Error).message).toMatch(/post-link fault/)
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(`${destination}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { restore() }
  })

  it('cleans a partial after a short or zero write fault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-write-fault-'))
    roots.push(root)
    const restore = __setArtifactDownloaderTestHooksForTest({ write: async () => ({ bytesWritten: 0 }) })
    try {
      const destination = join(root, 'artifact')
      const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200 }) })
      await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/short write/i)
      await expect(stat(`${destination}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { restore() }
  })

  it('rolls back both names when unlink or parent synchronization fails after link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-publish-fault-'))
    roots.push(root)
    for (const hooks of [
      { unlink: async () => { throw new Error('unlink fault') } },
      { syncParent: async () => { throw new Error('parent sync fault') } },
    ]) {
      const destination = join(root, hooks.unlink === undefined ? 'sync-artifact' : 'unlink-artifact')
      const restore = __setArtifactDownloaderTestHooksForTest(hooks)
      try {
        const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200 }) })
        await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/fault|rollback/i)
        await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(`${destination}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally { restore() }
    }
  })

  it('does not leave a second cleanup error after a pre-publish link failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-link-fault-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    const restore = __setArtifactDownloaderTestHooksForTest({ link: async () => { throw new Error('link-before-publish fault') } })
    try {
      const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200 }) })
      const failure = await downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] }).catch((error: unknown) => error)
      expect(failure).not.toBeInstanceOf(AggregateError)
      expect((failure as Error).message).toMatch(/link-before-publish fault/)
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(`${destination}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { restore() }
  })

  it('retains complete errors and cleans up after retained-handle sync or close faults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-handle-fault-'))
    roots.push(root)
    for (const hooks of [
      { sync: async () => { throw new Error('retained sync fault') } },
      { close: async (handle: Awaited<ReturnType<typeof import('node:fs/promises').open>>) => { await handle.close(); throw new Error('retained close fault') } },
    ]) {
      const destination = join(root, hooks.sync === undefined ? 'close-artifact' : 'sync-artifact')
      const restore = __setArtifactDownloaderTestHooksForTest(hooks)
      try {
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200 }) })
        const failure = await downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] }).catch((error: unknown) => error)
        expect((failure as Error).message).toMatch(/retained (sync|close) fault/)
        await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(`${destination}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally { restore() }
    }
  })

  it('aggregates a rollback unlink fault without reporting a phantom cleanup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-rollback-unlink-fault-'))
    roots.push(root)
    const destination = join(root, 'artifact')
    const restore = __setArtifactDownloaderTestHooksForTest({ afterLink: async () => { throw new Error('post-link primary') }, rollbackUnlink: async () => { throw new Error('rollback unlink fault') } })
    try {
      const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => new Response('payload', { status: 200 }) })
      const failure = await downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination, bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toHaveLength(2)
      expect((failure as AggregateError).errors.map((error) => String(error))).toEqual(expect.arrayContaining([expect.stringMatching(/post-link primary/), expect.stringMatching(/rollback unlink fault/)]))
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(`${destination}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { restore() }
  })

  it('does not swallow redirect body cancellation failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-cancel-fault-'))
    roots.push(root)
    const body = { cancel: async () => { throw new Error('cancel fault') } }
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async () => ({ status: 302, ok: false, headers: new Headers(), body } as unknown as Response) })
    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/artifact', destination: join(root, 'artifact'), bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/cancel fault/i)
  })

  it('cancels every response body independently across redirects and final-response failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-downloader-body-cancel-'))
    roots.push(root)
    let cancels = 0
    const redirectBody = { cancel: async () => { cancels += 1 } }
    const finalBody = { cancel: async () => { cancels += 1 } }
    const downloader = new ArtifactDownloader({ capability, workspaceRoot: root, fetch: async (input) => String(input).endsWith('/start')
      ? ({ status: 302, ok: false, headers: new Headers({ location: '/next' }), body: redirectBody } as unknown as Response)
      : ({ status: 200, ok: true, headers: new Headers({ 'content-length': 'bad' }), body: finalBody } as unknown as Response) })
    await expect(downloader.fetch({ ...metadata, url: 'https://trusted.example/start', destination: join(root, 'artifact'), bytes: 7, sha256: sha256('payload'), allowedHosts: ['trusted.example'] })).rejects.toThrow(/content-length/)
    expect(cancels).toBe(2)
  })
})
