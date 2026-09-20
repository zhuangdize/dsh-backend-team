import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileContextCheckpointStore } from '../../agent-team/src/context-manager.js'
import { LongTaskExecutionSession, ownershipPort } from '../../agent-team/src/long-task-execution-session.js'
import { OwnershipManager } from '../../agent-team/src/ownership-manager.js'
import { FileDevelopmentCheckpointStore } from '../src/file-development-checkpoint-store.js'

const contextOptions = {
  contextWindowTokens: 300,
  outputLimitTokens: 30,
  toolBufferTokens: 20,
  safetyMarginTokens: 20,
  retainRecentMessages: 2,
  maxSummaryTokens: 40,
}

describe('long task host integration', () => {
  it('uses the real development run lock before opening a resumable context session', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'long-task-host-'))
    try {
      const checkpoints = new FileDevelopmentCheckpointStore(root, 'task-1')
      const ownership = new OwnershipManager({ workspaceRoot: root, recoveryToken: 'long-task-host-token-1234' })
      const pathLease = ownership.acquire('task-1', ['src'], 'write')
      const options = {
        taskId: 'task-1',
        readPaths: [],
        writePaths: ['src'],
        runLease: { acquire: () => checkpoints.acquireRun() },
        ownership: ownershipPort(ownership),
        contextStore: new FileContextCheckpointStore(root),
        contextOptions,
        budget: { taskMaxTokens: 100, windowMaxTokens: 40, compactionMaxTokens: 20 },
      }
      const first = await LongTaskExecutionSession.open(options)
      await expect(LongTaskExecutionSession.open(options)).rejects.toThrow(/run lock is busy|run lease is busy/i)
      await first.append([{ id: 'user-1', role: 'user', content: 'Continue this task after a restart.' }])
      await first.close()

      const resumed = await LongTaskExecutionSession.open(options)
      expect((await resumed.snapshot()).context.transcript).toMatchObject([{ id: 'user-1', role: 'user' }])
      await resumed.close()
      ownership.release(pathLease)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
