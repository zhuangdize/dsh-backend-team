import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NewProjectBootstrapper } from '../../packages/development/src/new-project-bootstrapper.js'
import { DevelopmentActionCatalog } from '../../packages/development/src/development-action-catalog.js'

describe('new project simulated Harness flow', () => {
  it('starts through user actions and creates the pinned PostgreSQL baseline', async () => {
    const calls: string[] = []
    const workflow = {
      start: async (objective: string) => { calls.push(`start:${objective}`); return { phase: 'SPECIFY' } },
      refine: async (input: unknown) => { calls.push(`refine:${String(input)}`); return { phase: 'SPECIFY' } },
      approve: async (gate: 'requirements' | 'design') => { calls.push(`approve:${gate}`); return { phase: gate === 'requirements' ? 'DESIGN' : 'PLAN' } },
      status: () => ({ phase: calls.length > 0 ? 'PLAN' : 'DISCOVER' }),
      resume: async () => { calls.push('resume'); return { phase: 'BUILD' } },
    }
    const actions = new DevelopmentActionCatalog(workflow)
    await actions.get('backend_team_start')!.execute({ objective: '订单查询后端接口' })
    await actions.get('backend_team_refine')!.execute({ missing: ['分页规则'] })
    await actions.get('backend_team_approve')!.execute({ gate: 'requirements' })
    await actions.get('backend_team_approve')!.execute({ gate: 'design' })
    expect(calls).toEqual(['start:订单查询后端接口', 'refine:[object Object]', 'approve:requirements', 'approve:design'])

    const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-new-'))
    try {
      const bootstrapper = new NewProjectBootstrapper({
        workspaceRoot: root,
        runtime: { resolve: async () => ({ nodeRealPath: `${root}/.backend-team/runtime/node`, npmRealPath: `${root}/.backend-team/runtime/npm`, npxRealPath: `${root}/.backend-team/runtime/npx` }) },
        commandRunner: { run: async () => ({ exitCode: 0 }) },
      })
      const result = await bootstrapper.apply({ kind: 'new-project', nodeRuntime: { exactVersion: '24.19.0', source: 'new-project-default' } }, { design: true, dependency: true, install: true, installToken: 'install-approved' })
      expect(result.dependencies).toHaveProperty('pg', '8.23.0')
      expect(result.dependencies).not.toHaveProperty('mysql')
      expect(result.files.map((file) => file.path)).toContain('src/health/health.controller.ts')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
