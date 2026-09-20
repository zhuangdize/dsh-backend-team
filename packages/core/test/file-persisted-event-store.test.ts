import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendTeamEvent } from '@dsh-backend-team/contracts'
import { FilePersistedEventStore } from '../src/index.js'

const at = '2026-08-28T00:00:00.000Z'
const event = (id: string, sequence: number): BackendTeamEvent => ({ id, sequence, occurredAt: at, type: 'phase-changed', revision: sequence, phase: 'SPECIFY' })

describe('FilePersistedEventStore', () => {
  let workspaceRoot: string

  beforeEach(async () => { workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-backend-team-events-')) })
  afterEach(async () => { await rm(workspaceRoot, { force: true, recursive: true }) })

  it('recovers events across store instances and persists restrictive files', async () => {
    const first = new FilePersistedEventStore(workspaceRoot)
    await first.append(first.workspaceRoot, event('event-1', 1))

    const second = new FilePersistedEventStore(workspaceRoot)
    await expect(second.read(second.workspaceRoot)).resolves.toEqual([event('event-1', 1)])
    const path = join(second.workspaceRoot, '.backend-team', 'events', 'events.jsonl')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).toContain('event-1')
  })

  it('serializes concurrent appends from separate store instances', async () => {
    const first = new FilePersistedEventStore(workspaceRoot)
    const second = new FilePersistedEventStore(workspaceRoot)
    await Promise.all([
      first.append(first.workspaceRoot, event('event-1', 1)),
      second.append(second.workspaceRoot, event('event-2', 2)),
    ])

    await expect(second.read(second.workspaceRoot)).resolves.toEqual([event('event-1', 1), event('event-2', 2)])
  })

  it('rejects duplicate IDs, conflicting sequences, and workspace mismatches', async () => {
    const store = new FilePersistedEventStore(workspaceRoot)
    await store.append(store.workspaceRoot, event('event-1', 1))
    await expect(store.append(store.workspaceRoot, event('event-1', 2))).rejects.toThrow(/duplicate event id/i)
    await expect(store.append(store.workspaceRoot, { ...event('event-2', 1), phase: 'DESIGN' })).rejects.toThrow(/event sequence/i)
    await expect(store.append('/other', event('event-3', 3))).rejects.toThrow(/workspace mismatch/i)
  })

  it('rejects malformed durable lines and symlinked event files', async () => {
    const path = join(workspaceRoot, '.backend-team', 'events', 'events.jsonl')
    await mkdir(join(workspaceRoot, '.backend-team', 'events'), { recursive: true })
    await writeFile(path, '{"broken":true}\n')
    const store = new FilePersistedEventStore(workspaceRoot)
    await expect(store.read(workspaceRoot)).rejects.toThrow()

    await rm(join(workspaceRoot, '.backend-team'), { force: true, recursive: true })
    await symlink('/tmp', join(workspaceRoot, '.backend-team'))
    await expect(store.append(store.workspaceRoot, event('event-1', 1))).rejects.toThrow(/symlink/i)
  })
})
