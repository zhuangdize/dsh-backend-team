import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const smoke = await import('../../scripts/dsh-fresh-profile-smoke.mjs')

describe('fresh-profile smoke runner safety helpers', () => {
  it('rejects Node paths and versions outside the configured workspace NVM prefix', () => {
    const configuredRoot = '/workspace/.backend-team/runtime/nvm/versions/node/v24.19.0'
    expect(() => smoke.assertNvmProvenance('20.20.0', '/workspace/.backend-team/runtime/nvm/versions/node/v20.20.0/bin/node', configuredRoot)).toThrow(/Node version/i)
    expect(() => smoke.assertNvmProvenance('24.19.0', '/Users/host/.nvm/versions/node/v24.19.0/bin/node', configuredRoot)).toThrow(/NVM Node path/i)
    expect(() => smoke.assertNvmProvenance('24.19.0', `${configuredRoot}/copied-node`, configuredRoot)).toThrow(/NVM Node path/i)
    expect(() => smoke.assertNvmProvenance('24.19.0', `${configuredRoot}/bin/node`, configuredRoot)).not.toThrow()
  })

  it('rejects cached lock entries resolved from a non-public registry', () => {
    const lock = JSON.stringify({ packages: { 'node_modules/example': { resolved: 'https://mirror.example.invalid/example.tgz' } } })
    expect(() => smoke.assertPublicPackageLock(lock)).toThrow(/registry/i)
    expect(() => smoke.assertPublicPackageLock(JSON.stringify({ packages: { 'node_modules/example': { resolved: 'file:../outside-workspace' } } }))).toThrow(/registry|URL/i)
    expect(() => smoke.assertPublicPackageLock(JSON.stringify({ packages: { 'node_modules/example': { resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz' } } }))).not.toThrow()
  })

  it('classifies a missing pinned DSH executable as blocked', async () => {
    const missing = join(process.cwd(), '.backend-team', 'runtime', 'dsh', '0.1.0-rc.6', 'node_modules', '.bin', 'missing-dsh')
    await expect(smoke.assertPinnedDshAvailable(missing)).rejects.toBeInstanceOf(smoke.SmokeBlockedError)
  })

  it('fails closed on malformed, truncated, or unexpected npm audit results', () => {
    expect(() => smoke.parseAuditSummary({ code: 1, stdout: '{"metadata":', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false })).toThrow(/audit/i)
    expect(() => smoke.parseAuditSummary({ code: 1, stdout: '{"metadata":{"vulnerabilities":{"total":1,"high":1,"critical":0}}}', stderr: '', stdoutTruncated: true, stderrTruncated: false, timedOut: false })).toThrow(/truncated/i)
    expect(() => smoke.parseAuditSummary({ code: 2, stdout: '{"metadata":{"vulnerabilities":{"total":0,"high":0,"critical":0}}}', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false })).toThrow(/exit/i)
    expect(smoke.parseAuditSummary({ code: 1, stdout: '{"metadata":{"vulnerabilities":{"total":1,"high":1,"critical":0}}}', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false })).toEqual({ exitCode: 1, total: 1, high: 1, critical: 0 })
  })

  it('redacts and caps failed artifacts and removes a raw tool result', async () => {
    await mkdir(join(process.cwd(), '.backend-team', 'artifacts'), { recursive: true })
    const artifact = await mkdtemp(join(process.cwd(), '.backend-team', 'artifacts', 'runner-unit-'))
    try {
      await smoke.writeFailureArtifact(artifact, new Error(`unicode-note=${'秘密'.repeat(20_000)}`), 'verification')
      const unicodeResult = JSON.parse(await readFile(join(artifact, 'result.json'), 'utf8'))
      expect(unicodeResult.reason.length).toBeLessThanOrEqual(4_096)
      expect(Buffer.byteLength(unicodeResult.reason, 'utf8')).toBeLessThanOrEqual(4_096)

      await writeFile(join(artifact, 'tool-result.json'), '{"status":"passed","secret":"top-secret"}\n')
      await smoke.writeFailureArtifact(artifact, new Error(`secret=top-secret workspace=${artifact}`), 'verification')
      const result = JSON.parse(await readFile(join(artifact, 'result.json'), 'utf8'))
      expect(result.status).toBe('failed')
      expect(result.reason).not.toContain('top-secret')
      expect(result.reason).not.toContain(artifact)
      expect(result.reason.length).toBeLessThanOrEqual(4_096)
      expect(Buffer.byteLength(result.reason, 'utf8')).toBeLessThanOrEqual(4_096)
      await expect(readFile(join(artifact, 'tool-result.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await smoke.writeFailureArtifact(artifact, new smoke.SmokeBlockedError('pinned executable unavailable'), 'prerequisite')
      expect(JSON.parse(await readFile(join(artifact, 'result.json'), 'utf8')).status).toBe('blocked')
    } finally {
      await rm(artifact, { recursive: true, force: true })
    }
  })

  it('propagates an explicit AbortSignal and terminates only its child', async () => {
    const controller = new AbortController()
    const running = smoke.capture(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } }, { signal: controller.signal, timeoutMs: 5_000 })
    setTimeout(() => controller.abort(), 25)
    const result = await running
    expect(result.timedOut).toBe(false)
    expect(result.code === null || result.signal !== null).toBe(true)
  })

  it('does not write boot logs when the close event is not confirmed', async () => {
    const artifact = await mkdtemp(join(process.cwd(), '.backend-team', 'artifacts', 'runner-log-decision-'))
    const stdoutPath = join(artifact, 'stdout.log')
    const stderrPath = join(artifact, 'stderr.log')
    try {
      const written = await smoke.writeBootLogsIfReaped({ reapTimedOut: true }, 'stdout', 'stderr', [], { stdout: stdoutPath, stderr: stderrPath })
      expect(written).toBe(false)
      await expect(access(stdoutPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(stderrPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(artifact, { recursive: true, force: true })
    }
  })

  it('detaches pipes and unreferences a child after close exhaustion', () => {
    const calls = []
    const child = {
      stdout: { destroy: () => calls.push('stdout') },
      stderr: { destroy: () => calls.push('stderr') },
      unref: () => calls.push('unref'),
    }
    expect(smoke.detachUnreapedChild(child)).toBe(child)
    expect(calls).toEqual(['stdout', 'stderr', 'unref'])
  })

  it('rejects a timed-out child even when it catches SIGTERM and exits 0', async () => {
    const controller = new AbortController()
    const result = await smoke.capture(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50)); setInterval(() => {}, 10000)"], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } }, { signal: controller.signal, timeoutMs: 100 })
    expect(result.code).toBe(0)
    expect(() => smoke.validateChildResult(result, 'timeout-test')).toThrow(/timed out/i)
    expect(smoke.shouldCleanupAfterChild(result)).toBe(true)
    expect(smoke.shouldCleanupAfterChild({ ...result, reapTimedOut: true })).toBe(false)
    expect(smoke.shouldMutateFailureArtifact({ cleanupSafe: true })).toBe(true)
    expect(smoke.shouldMutateFailureArtifact({ cleanupSafe: false })).toBe(false)
    const state = { cleanupSafe: true }
    smoke.markChildUnreaped(state)
    expect(state.cleanupSafe).toBe(false)
  })
})
