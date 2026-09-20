import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspaceLayout } from '@dsh-backend-team/contracts'
import { ProjectAnalyzer } from '../../packages/project-analyzer/src/index.js'

function workspace(root: string): WorkspaceLayout {
  const teamDir = resolve(root, '.backend-team')
  return { root, teamDir, stateDir: resolve(teamDir, 'state'), runtimeDir: resolve(teamDir, 'runtime'), cacheDir: resolve(teamDir, 'cache'), logsDir: resolve(teamDir, 'logs'), locksDir: resolve(teamDir, 'locks'), handoffDir: resolve(teamDir, 'handoff') }
}

describe('project analysis flow', () => {
  it('returns clarification rather than inventing a stack for a multi-service monorepo', async () => {
    const root = resolve(import.meta.dirname, '../fixtures/projects/monorepo')
    const analysis = await new ProjectAnalyzer({ workspace: workspace(root) }).analyze()

    expect(analysis.profile.projectKind).toBe('monorepo')
    expect(analysis.strategy).toMatchObject({ kind: 'needs-clarification', writable: false })
  })
})
