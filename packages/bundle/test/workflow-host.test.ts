import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createConfiguredWorkflowHost, formatRecoveryFailure } from '../src/workflow-host.js'

it('formats migration recovery failures as bounded actionable status', () => {
  expect(formatRecoveryFailure(new Error('snapshot hash mismatch'))).toBe('数据库迁移恢复失败，已阻止自动应用：snapshot hash mismatch')
  expect(formatRecoveryFailure('database unavailable')).toBe('数据库迁移恢复失败，已阻止自动应用：database unavailable')
  expect(formatRecoveryFailure(new Error('x'.repeat(2_000))).length).toBeLessThanOrEqual(930)
})

it('does nothing without explicit enablement and rejects uninitialized projects before state creation', async () => {
  expect(await createConfiguredWorkflowHost({}, { enabled: false })).toBeUndefined()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-host-')))
  try {
    await expect(createConfiguredWorkflowHost({}, { enabled: true, workspaceRoot: root, feature: 'demo' })).rejects.toThrow()
    await expect(readFile(join(root, '.backend-team/state/current.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('mounts an authenticated workflow with explicit development enablement %s', async (developmentEnabled) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-host-')))
  const remove = vi.fn()
  const register = vi.fn(() => remove)
  const sessionId = 'workflow-session-1234567890'
  try {
    await mkdir(join(root, '.specify'))
    await mkdir(join(root, '.backend-team/runtime/spec-kit/commands'), { recursive: true })
    const integration = { version: '0.16.5', integration_state_schema: 1, installed_integrations: ['generic'], integration_settings: { generic: { script: 'sh', raw_options: '--commands-dir .backend-team/runtime/spec-kit/commands', parsed_options: { commands_dir: '.backend-team/runtime/spec-kit/commands' }, invoke_separator: '.' } }, integration: 'generic', default_integration: 'generic' }
    await writeFile(join(root, '.specify/integration.json'), JSON.stringify(integration))
    for (const id of ['specify', 'clarify', 'plan', 'tasks']) await writeFile(join(root, `.backend-team/runtime/spec-kit/commands/speckit.${id}.md`), 'fixture prompt $ARGUMENTS')
    const host = await createConfiguredWorkflowHost({ webServer: { host: '127.0.0.1', register }, sessions: { get: () => ({ id: sessionId, header: { cwd: root } }) }, agents: { get: () => ({ id: sessionId }), create: async () => { throw new Error('model not used in construction test') } } }, { enabled: true, workspaceRoot: root, feature: 'demo', ...(developmentEnabled ? { development: { enabled: true } } : {}) })
    expect(host?.mode).toBe('supported')
    expect(register).toHaveBeenCalledOnce()
    expect(host?.surface?.projector.snapshot()).toMatchObject({ workspaceId: root, phase: 'DISCOVER', executionAvailable: developmentEnabled })
    expect(await readFile(join(root, '.backend-team/state/workflow-host.key'), 'utf8')).toMatch(/^[a-f0-9]{64}$/)
    await host?.dispose()
    expect(remove).toHaveBeenCalledOnce()
  } finally { await rm(root, { recursive: true, force: true }) }
})
