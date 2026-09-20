import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PatchTracker } from '../../packages/development/src/patch-tracker.js'

describe('existing dirty project', () => {
  it('refuses rollback after a user edit and preserves the user bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-dirty-'))
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'service.ts'), 'user baseline\n', 'utf8')
      const session = await new PatchTracker({ workspaceRoot: root, runId: 'dirty' }).begin(['src/service.ts'])
      await session.capture('src/service.ts', 'agent change\n')
      await writeFile(join(root, 'src', 'service.ts'), 'user concurrent change\n', 'utf8')
      const rollback = await session.rollbackOwnChanges()
      expect(rollback[0]?.status).toBe('refused')
      await expect(readFile(join(root, 'src', 'service.ts'), 'utf8')).resolves.toBe('user concurrent change\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
