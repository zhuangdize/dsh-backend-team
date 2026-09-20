import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PatchTracker } from '../src/patch-tracker.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'patch-tracker-'))
  await writeFile(join(root, 'service.ts'), 'export const value = 1\n')
  return root
}

describe('PatchTracker', () => {
  it('delegates exactly one normalized write and verifies the writer result', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-writer-once' }).begin(['service.ts'])
      let calls = 0
      const patch = await session.captureAgentEditWithWriter(
        { path: './nested/../service.ts', bytes: 'export const value = 2\n', mode: 0o640 },
        async (input) => {
          calls += 1
          expect(input.path).toBe('service.ts')
          expect(input.bytes).toBeInstanceOf(Uint8Array)
          expect(Buffer.from(input.bytes).toString()).toBe('export const value = 2\n')
          expect(input.before.state).toBe('present')
          expect(input.mode).toBe(0o640)
          await writeFile(join(root, input.path), input.bytes, { mode: input.mode })
        },
      )
      expect(calls).toBe(1)
      expect(patch.status).toBe('applied')
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 2\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('passes a missing before snapshot to the single writer for a new file', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-writer-new' }).begin(['new.ts'])
      let calls = 0
      const patch = await session.captureAgentEditWithWriter({ path: 'new.ts', bytes: 'export const created = true\n' }, async (input) => {
        calls += 1
        expect(input.before.state).toBe('missing')
        await writeFile(join(root, input.path), input.bytes)
      })
      expect(calls).toBe(1)
      expect(patch.before.state).toBe('missing')
      expect(patch.after.state).toBe('present')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a stale expected snapshot before delegating a write', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-writer-stale' }).begin(['service.ts'])
      await writeFile(join(root, 'service.ts'), 'export const value = 99\n')
      let calls = 0
      await expect(session.captureAgentEditWithWriter({ path: 'service.ts', bytes: 'export const value = 2\n' }, async () => { calls += 1 })).rejects.toThrow(/concurrent|snapshot/i)
      expect(calls).toBe(0)
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 99\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rolls back a partial existing-file write when the writer rejects', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-writer-failure' }).begin(['service.ts'])
      await expect(session.captureAgentEditWithWriter({ path: 'service.ts', bytes: 'export const value = 2\n' }, async (input) => {
        await writeFile(join(root, input.path), 'partial\n')
        throw new Error('writer failed')
      })).rejects.toThrow('writer failed')
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 1\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('removes a partial new file when the writer rejects', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-writer-new-failure' }).begin(['new.ts'])
      await expect(session.captureAgentEditWithWriter({ path: 'new.ts', bytes: 'export const created = true\n' }, async (input) => {
        await writeFile(join(root, input.path), 'partial\n')
        throw new Error('writer failed')
      })).rejects.toThrow('writer failed')
      await expect(stat(join(root, 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects and rolls back when the writer reports success with a hash mismatch', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-writer-hash' }).begin(['service.ts'])
      await expect(session.captureAgentEditWithWriter({ path: 'service.ts', bytes: 'export const value = 2\n' }, async (input) => {
        await writeFile(join(root, input.path), 'different\n')
      })).rejects.toThrow(/verification|hash/i)
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 1\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rolls back the file when final evidence publication fails', async () => {
    const root = await fixture()
    try {
      const runId = 'run-writer-evidence'
      const patches = join(root, '.backend-team', 'runs', runId, 'patches')
      await mkdir(patches, { recursive: true })
      await writeFile(join(patches, '0001-c2VydmljZS50cw.after.gz'), 'already exists')
      const session = await new PatchTracker({ workspaceRoot: root, runId }).begin(['service.ts'])
      await expect(session.captureAgentEditWithWriter({ path: 'service.ts', bytes: 'export const value = 2\n' }, async (input) => {
        await writeFile(join(root, input.path), input.bytes)
      })).rejects.toThrow(/EEXIST|exist|evidence/i)
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 1\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses a fresh evidence attempt after a failed writer in the same session', async () => {
    const root = await fixture()
    try {
      const runId = 'run-writer-retry'
      const session = await new PatchTracker({ workspaceRoot: root, runId }).begin(['service.ts'])
      await expect(session.captureAgentEditWithWriter({ path: 'service.ts', bytes: 'export const value = 2\n' }, async () => {
        throw new Error('writer failed')
      })).rejects.toThrow('writer failed')
      const patch = await session.captureAgentEditWithWriter({ path: 'service.ts', bytes: 'export const value = 3\n' }, async (input) => {
        await writeFile(join(root, input.path), input.bytes)
      })
      expect(patch.status).toBe('applied')
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 3\n')
      await expect(stat(join(root, '.backend-team', 'runs', runId, 'patches', '0002-c2VydmljZS50cw.complete'))).resolves.toBeDefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses a fresh evidence attempt after final evidence publication fails', async () => {
    const root = await fixture()
    try {
      const runId = 'run-evidence-retry'
      const patches = join(root, '.backend-team', 'runs', runId, 'patches')
      await mkdir(patches, { recursive: true })
      await writeFile(join(patches, '0001-c2VydmljZS50cw.after.gz'), 'already exists')
      const session = await new PatchTracker({ workspaceRoot: root, runId }).begin(['service.ts'])
      await expect(session.captureAgentEditWithWriter({ path: 'service.ts', bytes: 'export const value = 2\n' }, async (input) => {
        await writeFile(join(root, input.path), input.bytes)
      })).rejects.toThrow(/EEXIST|exist|evidence/i)
      const patch = await session.captureAgentEditWithWriter({ path: 'service.ts', bytes: 'export const value = 3\n' }, async (input) => {
        await writeFile(join(root, input.path), input.bytes)
      })
      expect(patch.status).toBe('applied')
      await expect(stat(join(patches, '0002-c2VydmljZS50cw.complete'))).resolves.toBeDefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('refuses failed-write rollback after an inode replacement and preserves the replacement', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-writer-replacement' }).begin(['service.ts'])
      const replacement = join(root, 'service.replacement.ts')
      await expect(session.captureAgentEditWithWriter({ path: 'service.ts', bytes: 'export const value = 2\n' }, async () => {
        await writeFile(replacement, 'user replacement\n')
        await rename(replacement, join(root, 'service.ts'))
        throw new Error('writer failed after replacement')
      })).rejects.toThrow(/rollback|concurrent/i)
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('user replacement\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('applies unchanged edits and records exact before/after evidence', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-1' }).begin(['service.ts'])
      const patch = await session.captureAgentEdit({ path: 'service.ts', bytes: Buffer.from('export const value = 2\n') })
      expect(patch).toMatchObject({ path: 'service.ts', status: 'applied', before: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }, after: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }, rollback: { status: 'not-attempted' } })
      expect(patch.before.sha256).not.toBe(patch.after.sha256)
      expect(patch.unifiedPatch).toContain('--- a/service.ts')
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 2\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rolls back an untouched agent write without touching unrelated files', async () => {
    const root = await fixture()
    try {
      await writeFile(join(root, 'unrelated.ts'), 'export const untouched = true\n')
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-2' }).begin(['service.ts'])
      await session.captureAgentEdit({ path: 'service.ts', bytes: 'export const value = 3\n' })
      const evidence = await session.rollbackOwnChanges()
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ status: 'rolled-back', afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), restoredSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 1\n')
      await expect(readFile(join(root, 'unrelated.ts'), 'utf8')).resolves.toBe('export const untouched = true\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('restores the user version that existed before the task began', async () => {
    const root = await fixture()
    try {
      await writeFile(join(root, 'service.ts'), 'export const value = 7\n')
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-dirty' }).begin(['service.ts'])
      await session.captureAgentEdit({ path: 'service.ts', bytes: 'export const value = 8\n' })
      await session.rollbackOwnChanges()
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 7\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('refuses rollback after a user edit and never overwrites it', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-3' }).begin(['service.ts'])
      await session.captureAgentEdit({ path: 'service.ts', bytes: 'export const value = 4\n' })
      await writeFile(join(root, 'service.ts'), 'export const value = 99\n')
      const evidence = await session.rollbackOwnChanges()
      expect(evidence[0]).toMatchObject({ status: 'refused', reason: expect.stringMatching(/user|after-state|concurrent/i) })
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 99\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not let callers mutate the guard state through returned evidence', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-immutable' }).begin(['service.ts'])
      await session.captureAgentEdit({ path: 'service.ts', bytes: 'export const value = 5\n' })
      const exposed = session.patchesSnapshot()[0]!
      const exposedIdentity = exposed.after.identity as { ino: number }
      exposedIdentity.ino = 0
      exposed.after.compressedBytes.fill(0)
      await writeFile(join(root, 'service.ts'), 'export const value = 99\n')
      const evidence = await session.rollbackOwnChanges()
      expect(evidence[0]).toMatchObject({ status: 'refused' })
      await expect(readFile(join(root, 'service.ts'), 'utf8')).resolves.toBe('export const value = 99\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('records absence and can safely own a new file', async () => {
    const root = await fixture()
    try {
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'run-4' }).begin(['new.ts'])
      const patch = await session.captureAgentEdit({ path: 'new.ts', bytes: 'export const created = true\n' })
      expect(patch.before.state).toBe('missing')
      expect(patch.after.state).toBe('present')
      await session.rollbackOwnChanges()
      await expect(stat(join(root, 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
