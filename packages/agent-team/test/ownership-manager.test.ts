import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OwnershipManager } from '../src/ownership-manager.js'
import { SharedResource } from '../src/shared-resource.js'

const task = (id: string, writePaths: readonly string[]) => ({ id, writePaths })
const workspace = (): string => mkdtempSync(resolve(tmpdir(), 'agent-ownership-'))
const options = (workspaceRoot: string) => ({ workspaceRoot, recoveryToken: 'test-recovery-token-1234' })

describe('OwnershipManager', () => {
  it('allows concurrent reads but serializes a conflicting write from another task', () => {
    const root = workspace()
    const manager = new OwnershipManager(options(root))
    manager.acquire('reader-a', ['src/users'], 'read')
    manager.acquire('reader-b', ['src/users/service.ts'], 'read')

    expect(() => manager.acquire('writer', ['src/users/service.ts'], 'write')).toThrow(/owned by task reader-[ab]/i)
    rmSync(root, { recursive: true, force: true })
  })

  it('allows same-task re-entry and only releases the matching nonce', () => {
    const root = workspace()
    const manager = new OwnershipManager(options(root))
    const first = manager.acquire('task-a', ['src/users'], 'write')
    const second = manager.acquire('task-a', ['src/users/service.ts'], 'write')

    manager.release({ ...first, nonce: 'forged' })
    expect(() => manager.acquire('task-b', ['src/users/service.ts'], 'write')).toThrow(/owned by task task-a/i)
    manager.release(first)
    expect(() => manager.acquire('task-b', ['src/users/service.ts'], 'write')).toThrow(/owned by task task-a/i)
    manager.release(second)
    expect(manager.acquire('task-b', ['src/users/service.ts'], 'write').taskId).toBe('task-b')
    rmSync(root, { recursive: true, force: true })
  })

  it('verifies only a declared and currently leased write path', () => {
    const root = workspace()
    const manager = new OwnershipManager(options(root))
    manager.acquire('task-a', ['src/users'], 'write')

    expect(manager.verifyWrite(task('task-a', ['src/users']), 'src/users/service.ts')).toBe(true)
    expect(() => manager.verifyWrite(task('task-a', ['src/users']), 'src/admin.ts')).toThrow(/outside task ownership/i)
    expect(() => manager.verifyWrite(task('task-b', ['src/users']), 'src/users/service.ts')).toThrow(/lease/i)
    rmSync(root, { recursive: true, force: true })
  })

  it('recovers persisted leases without exposing their nonce in snapshots', () => {
    const root = workspace()
    const first = new OwnershipManager(options(root))
    first.acquire('task-a', ['src/users'], 'write')
    const recovered = new OwnershipManager(options(root))

    expect(() => recovered.acquire('task-b', ['src/users/service.ts'], 'write')).toThrow(/owned by task task-a/i)
    expect(recovered.snapshot()[0]).not.toHaveProperty('nonce')
    expect(recovered.releaseRecovered('task-a', ['src/users'], 'test-recovery-token-1234')).toBe(1)
    expect(recovered.acquire('task-b', ['src/users/service.ts'], 'write').taskId).toBe('task-b')
    rmSync(root, { recursive: true, force: true })
  })

  it('allows only a parent-scoped delegated overlap and preserves it during recovery', () => {
    const root = workspace()
    const first = new OwnershipManager(options(root))
    const parent = first.acquire('expert', ['src/expert'], 'write')
    first.acquire('worker', ['src/expert/child'], 'write', { delegatedFrom: parent })

    expect(() => first.acquire('forged', ['src/expert/child'], 'write', { delegatedFrom: { ...parent, nonce: 'b'.repeat(48) } })).toThrow(/within the parent lease/i)
    expect(() => first.acquire('outside', ['src/other'], 'write', { delegatedFrom: parent })).toThrow(/within the parent lease/i)
    const recovered = new OwnershipManager(options(root))
    expect(() => recovered.acquire('outside', ['src/expert/child'], 'write')).toThrow(/owned by task/i)
    expect(recovered.releaseRecovered('worker', ['src/expert/child'], 'test-recovery-token-1234')).toBe(1)
    expect(recovered.releaseRecovered('expert', ['src/expert'], 'test-recovery-token-1234')).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  it('serializes two managers sharing one workspace through the durable mutex', () => {
    const root = workspace()
    const first = new OwnershipManager(options(root))
    const second = new OwnershipManager(options(root))
    const lease = first.acquire('task-a', ['src/users'], 'write')

    expect(() => second.acquire('task-b', ['src/users/service.ts'], 'write')).toThrow(/owned by task task-a/i)
    first.release(lease)
    expect(second.acquire('task-b', ['src/users/service.ts'], 'write').taskId).toBe('task-b')
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects a symlinked workspace path before creating a lease', () => {
    const root = workspace()
    mkdirSync(resolve(root, 'src'))
    symlinkSync(resolve(root, 'src'), resolve(root, 'linked'))
    const manager = new OwnershipManager(options(root))

    expect(() => manager.acquire('task', ['linked/service.ts'], 'write')).toThrow(/symlink|safe/i)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('SharedResource', () => {
  it('serializes fixed shared resources regardless of requested prompt scope', () => {
    const root = workspace()
    const resources = new SharedResource(options(root))
    const lease = resources.acquire('task-a', 'package.json')

    expect(() => resources.acquire('task-b', 'package.json')).toThrow(/shared resource.*task-a/i)
    resources.release(lease)
    expect(resources.acquire('task-b', 'package.json').taskId).toBe('task-b')
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects non-mandatory and sensitive shared paths', () => {
    const root = workspace()
    const resources = new SharedResource(options(root))

    expect(() => resources.acquire('task', 'src/users/service.ts')).toThrow(/mandatory/i)
    expect(() => resources.acquire('task', '.env')).toThrow(/safe|sensitive/i)
    rmSync(root, { recursive: true, force: true })
  })

  it('serializes a mandatory shared directory and its child paths', () => {
    const root = workspace()
    const resources = new SharedResource(options(root))
    resources.acquire('task-a', 'drizzle')

    expect(() => resources.acquire('task-b', 'drizzle/meta/_journal.json')).toThrow(/shared resource.*task-a/i)
    rmSync(root, { recursive: true, force: true })
  })

  it('recovers and releases a shared resource with the trusted token', () => {
    const root = workspace()
    const first = new SharedResource(options(root))
    first.acquire('task-a', 'package.json')
    const recovered = new SharedResource(options(root))

    expect(recovered.snapshot()[0]).not.toHaveProperty('nonce')
    expect(recovered.releaseRecovered('task-a', 'package.json', 'test-recovery-token-1234')).toBe(true)
    expect(recovered.acquire('task-b', 'package.json').taskId).toBe('task-b')
    rmSync(root, { recursive: true, force: true })
  })
})
