import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('backend-team-doctor script', () => {
  it('reports the selected Profile, local runtimes, and Bundle without leaking workspace paths', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'backend-team-doctor-'))
    const dshDirectory = join(workspace, '.backend-team/runtime/dsh/0.1.0-rc.6/node_modules/.bin')
    const nodeDirectory = join(workspace, '.backend-team/runtime/nvm/versions/node/v24.19.0/bin')
    const profileDirectory = join(workspace, '.backend-team/runtime/dsh-home/profiles')
    await mkdir(dshDirectory, { recursive: true })
    await mkdir(nodeDirectory, { recursive: true })
    await mkdir(profileDirectory, { recursive: true })
    const dshPath = join(dshDirectory, 'dsh')
    await writeFile(dshPath, '#!/bin/sh\n', { mode: 0o755 })
    await chmod(dshPath, 0o755)
    await symlink(process.execPath, join(nodeDirectory, 'node'))
    await mkdir(join(profileDirectory, 'web'), { recursive: true })
    await writeFile(join(profileDirectory, 'web/package.json'), JSON.stringify({ dependencies: { '@dsh-backend-team/bundle': 'file:bundle.tgz' } }))
    await mkdir(join(workspace, '.backend-team/state'), { recursive: true })
    await writeFile(join(workspace, '.backend-team/state/current.json'), JSON.stringify({ phase: 'DISCOVER', schemaVersion: 1 }))

    const result = await runDoctor(workspace)

    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as Record<string, unknown>
    expect(report).toMatchObject({
      workspace: '<workspace>',
      profile: 'web',
      dshHomeScope: 'workspace',
      harness: 'present',
      node: 'present',
      bundle: 'installed',
      bundleRows: 1,
      state: 'DISCOVER',
      stateSchema: 1,
    })
    expect(JSON.stringify(report)).not.toContain(workspace)
  })

  it('does not recommend continuing a build when the durable budget has exhausted records', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'backend-team-doctor-budget-'))
    await mkdir(join(workspace, '.backend-team/state'), { recursive: true })
    await mkdir(join(workspace, '.backend-team/development'), { recursive: true })
    await writeFile(join(workspace, '.backend-team/state/current.json'), JSON.stringify({ schemaVersion: 1, revision: 4, phase: 'BUILD', approvals: [], runs: [] }))
    await writeFile(join(workspace, '.backend-team/state/budget-ledger.json'), JSON.stringify({ schemaVersion: 2, records: [{ parentId: 'agent-1', status: 'blocked:budget-exhausted', consumed: { tokens: 1, wallMs: 600000, toolCalls: 1, retries: 0, children: 0 }, overrun: { usage: { tokens: 11, wallMs: 0, toolCalls: 0, retries: 0, children: 0 }, exceeded: ['tokens'] } }] }))
    await writeFile(join(workspace, '.backend-team/development/checkpoint.json'), JSON.stringify({ planHash: 'a'.repeat(64), slices: [{ sliceId: 'S-1', status: 'passed' }] }))

    const result = await runDoctor(workspace)

    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as { budget: { status: string; blockedRecords: number; blockedDimensions: string[] }; checkpoint: { passedSlices: number }; recovery: { action: string; reason: string } }
    expect(report.budget).toMatchObject({ status: 'blocked', blockedRecords: 1, blockedDimensions: ['tokens'] })
    expect(report.checkpoint.passedSlices).toBe(1)
    expect(report.recovery.action).toBe('inspect-state')
    expect(report.recovery.reason).toContain('耗尽维度')
  })

  it('keeps approval preview as the first recovery action while waiting for a decision', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'backend-team-doctor-approval-'))
    await mkdir(join(workspace, '.backend-team/state'), { recursive: true })
    await writeFile(join(workspace, '.backend-team/state/current.json'), JSON.stringify({ schemaVersion: 1, revision: 2, phase: 'AWAIT_DESIGN_APPROVAL', approvals: [], runs: [] }))

    const result = await runDoctor(workspace)

    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as { recovery: { action: string; reason: string } }
    expect(report.recovery).toEqual({ action: 'preview-and-confirm', reason: '当前阶段需要先查看并确认方案' })
  })

  it('uses the unfinished conversation task instead of a stale workspace-root state', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'backend-team-doctor-task-aware-'))
    const taskId = '11111111-1111-4111-8111-111111111111'
    await mkdir(join(workspace, '.backend-team/state'), { recursive: true })
    await mkdir(join(workspace, `.backend-team/state-${taskId}`), { recursive: true })
    await writeFile(join(workspace, '.backend-team/state/current.json'), JSON.stringify({ schemaVersion: 1, revision: 23, phase: 'VERIFY', approvals: [], runs: [] }))
    await writeFile(join(workspace, '.backend-team/conversation-tasks.json'), JSON.stringify({ version: 1, tasks: [{ id: taskId, sessionId: 'session-1234567890', title: '客户管理', objective: '客户管理', createdAt: new Date().toISOString() }] }))
    await writeFile(join(workspace, `.backend-team/state-${taskId}/current.json`), JSON.stringify({ schemaVersion: 1, revision: 9, phase: 'AWAIT_REQUIREMENTS_APPROVAL', approvals: [], runs: [] }))

    const result = await runDoctor(workspace)

    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as { state: string; stateSource: string; activeTaskId: string | null; tasks: Array<{ id: string; phase: string; arrangement: string }>; recovery: { action: string } }
    expect(report).toMatchObject({ state: 'AWAIT_REQUIREMENTS_APPROVAL', stateSource: 'conversation-task', activeTaskId: taskId, recovery: { action: 'preview-and-confirm' } })
    expect(report.tasks).toContainEqual(expect.objectContaining({ id: taskId, phase: 'AWAIT_REQUIREMENTS_APPROVAL', arrangement: 'unfinished' }))
  })

  it('blocks recovery when more than one unfinished conversation task is present', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'backend-team-doctor-conflict-'))
    const first = '22222222-2222-4222-8222-222222222222'
    const second = '33333333-3333-4333-8333-333333333333'
    await mkdir(join(workspace, '.backend-team/state'), { recursive: true })
    await mkdir(join(workspace, `.backend-team/state-${first}`), { recursive: true })
    await mkdir(join(workspace, `.backend-team/state-${second}`), { recursive: true })
    await writeFile(join(workspace, '.backend-team/conversation-tasks.json'), JSON.stringify({ version: 1, tasks: [
      { id: first, sessionId: 'session-1234567890', title: '任务一', objective: '任务一', createdAt: new Date().toISOString() },
      { id: second, sessionId: 'session-1234567891', title: '任务二', objective: '任务二', createdAt: new Date().toISOString() },
    ] }))
    await writeFile(join(workspace, `.backend-team/state-${first}/current.json`), JSON.stringify({ schemaVersion: 1, revision: 1, phase: 'BUILD', approvals: [], runs: [] }))
    await writeFile(join(workspace, `.backend-team/state-${second}/current.json`), JSON.stringify({ schemaVersion: 1, revision: 2, phase: 'BUILD', approvals: [], runs: [] }))

    const result = await runDoctor(workspace)

    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as { recovery: { action: string; reason: string }; tasks: unknown[] }
    expect(report.tasks).toHaveLength(2)
    expect(report.recovery.action).toBe('inspect-state')
    expect(report.recovery.reason).toContain('多个未完成')
  })
})

function runDoctor(workspace: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts/backend-team-doctor.mjs')
    const child = spawn(process.execPath, [script, '--workspace', workspace], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}
