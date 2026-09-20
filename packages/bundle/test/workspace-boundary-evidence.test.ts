import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { DevelopmentPlan } from '@dsh-backend-team/development'
import { FileStateStore } from '@dsh-backend-team/core'
import { ensureWorkspaceBaseline, workspaceBoundaryReport } from '../src/workspace-boundary-evidence.js'

it('captures current files, executes boundary checks and preserves stable evidence on reload', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-boundary-')))
  try {
    await mkdir(join(root, '.backend-team'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'test'))
    await writeFile(join(root, 'src/existing.ts'), 'existing local edits')
    await ensureWorkspaceBaseline(root, 'demo', ['src', 'test'])
    await writeFile(join(root, 'src/new.ts'), 'new implementation')
    const plan = { slices: [{ expectedPaths: ['src/new.ts'] }] } as unknown as DevelopmentPlan
    const report = await workspaceBoundaryReport(root, 'demo', plan, true)
    const content = JSON.parse(await readFile(join(root, report.file), 'utf8'))
    expect(content).toMatchObject({ status: 'passed', checkedExistingFiles: 1 })
    expect(Object.keys(content.files)).toEqual(['src/existing.ts', 'src/new.ts'])
    expect(await workspaceBoundaryReport(root, 'demo', plan, false)).toEqual(report)
    await writeFile(join(root, 'src/existing.ts'), 'unexpected modification')
    await ensureWorkspaceBaseline(root, 'demo', ['src', 'test'])
    await expect(workspaceBoundaryReport(root, 'demo', plan, true)).rejects.toThrow('Unplanned existing file changed')
    await writeFile(join(root, 'src/existing.ts'), 'existing local edits')
    await writeFile(join(root, 'test/unplanned.mjs'), 'unexpected output')
    await expect(workspaceBoundaryReport(root, 'demo', plan, true)).rejects.toThrow('Unplanned new file')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('accepts the explicitly approved personnel footprint while rejecting other extras', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-forward-migration-')))
  try {
    await mkdir(join(root, '.backend-team'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'test'))
    await mkdir(join(root, 'migrations'))
    await ensureWorkspaceBaseline(root, 'personnel', ['src', 'test', 'migrations'])
    const migrations = [
      '0001_personnel_person.sql',
      '0002_personnel_assignment.sql',
      '0003_personnel_change_record.sql',
      '0004_personnel_integrity_indexes.sql',
    ]
    for (const file of migrations) await writeFile(join(root, 'migrations', file), `-- ${file}\n`)
    await mkdir(join(root, 'src/personnel/domain'), { recursive: true })
    await mkdir(join(root, 'src/personnel/api'), { recursive: true })
    await writeFile(join(root, 'src/personnel/domain/audit.ts'), 'export {}\n')
    await writeFile(join(root, 'src/personnel/api/host-adapter.ts'), 'export {}\n')
    await writeFile(join(root, 'src/personnel/index.ts'), 'export {}\n')
    const plan = { slices: [{ expectedPaths: migrations.slice(0, 3).map(file => `migrations/${file}`) }] } as unknown as DevelopmentPlan
    const report = await workspaceBoundaryReport(root, 'personnel', plan, true)
    expect(JSON.parse(await readFile(join(root, report.file), 'utf8'))).toMatchObject({ status: 'passed', checkedExistingFiles: 0 })
    await writeFile(join(root, 'migrations/unplanned.sql'), '-- reject')
    await expect(workspaceBoundaryReport(root, 'personnel', plan, true)).rejects.toThrow('Unplanned new file')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses to invent a pre-development snapshot after business execution began', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-late-baseline-')))
  try {
    await new FileStateStore(root, 'late').create({ schemaVersion: 1, revision: 0, workspaceRoot: root, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] })
    await expect(ensureWorkspaceBaseline(root, 'late', ['src', 'test'])).rejects.toThrow('不能补造修改前的证据')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps original evidence and uses a prospective change baseline for newly configured roots', async () => {
  const { prepareWorkspaceChangeBaseline, validateWorkspacePlanBoundary } = await import('../src/workspace-boundary-evidence.js')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-change-baseline-')))
  const id = '12345678-1234-4234-8234-123456789abc'
  try {
    await mkdir(join(root, '.backend-team')); await mkdir(join(root, 'src')); await mkdir(join(root, 'migrations'))
    await writeFile(join(root, 'src/existing.ts'), 'original')
    await ensureWorkspaceBaseline(root, 'demo', ['src'])
    const originalPath = join(root, '.backend-team/task-evidence/demo-baseline.json')
    const original = await readFile(originalPath, 'utf8')
    const originalReport = await workspaceBoundaryReport(root, 'demo', { slices: [] } as unknown as DevelopmentPlan, true)
    const originalReportBytes = await readFile(join(root, originalReport.file), 'utf8')
    const store = new FileStateStore(root, 'demo')
    await store.create({ schemaVersion: 1, revision: 0, workspaceRoot: root, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] })
    const plan = { slices: [{ expectedPaths: ['migrations/new.sql'] }] } as unknown as DevelopmentPlan
    await expect(validateWorkspacePlanBoundary(root, 'demo', plan, ['src', 'migrations'])).rejects.toThrow('当前配置允许')
    await writeFile(join(root, 'src/existing.ts'), 'old implementation kept for new scope')
    await store.transact(0, state => ({ ...state, phase: 'SPECIFY', requirementChanges: [{ id, text: 'add persistence', requestedAt: new Date().toISOString(), requestedBy: 'session-human-123456', fromPhase: 'BUILD', status: 'preparing', previousDocuments: [], previousApprovals: [], previousRuns: [] }] }))
    await prepareWorkspaceChangeBaseline(root, 'demo', id, ['src', 'migrations'])
    await prepareWorkspaceChangeBaseline(root, 'demo', id, ['migrations', 'src'])
    await validateWorkspacePlanBoundary(root, 'demo', plan)
    await writeFile(join(root, 'migrations/new.sql'), 'CREATE TABLE example(id int);')
    const changedReport = await workspaceBoundaryReport(root, 'demo', plan, true)
    expect(changedReport.file).not.toBe(originalReport.file)
    expect(await readFile(join(root, originalReport.file), 'utf8')).toBe(originalReportBytes)
    expect(await readFile(originalPath, 'utf8')).toBe(original)
    await writeFile(join(root, 'src/existing.ts'), 'unplanned new change')
    await expect(workspaceBoundaryReport(root, 'demo', plan, true)).rejects.toThrow('Unplanned existing file changed')
    await expect(prepareWorkspaceChangeBaseline(root, 'demo', id, ['src', 'migrations', 'test'])).rejects.toThrow('目录配置已变化')
    await expect(prepareWorkspaceChangeBaseline(root, 'demo', '87654321-1234-4234-8234-123456789abc', ['src'])).rejects.toThrow('变更记录已变化')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not fill in a missing baseline once changed requirements have already been generated', async () => {
  const { prepareWorkspaceChangeBaseline } = await import('../src/workspace-boundary-evidence.js')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-change-too-late-')))
  const id = '12345678-1234-4234-8234-123456789abc'
  try {
    await mkdir(join(root, '.backend-team')); await mkdir(join(root, 'src'))
    await ensureWorkspaceBaseline(root, 'demo', ['src'])
    await new FileStateStore(root, 'demo').create({ schemaVersion: 1, revision: 0, workspaceRoot: root, phase: 'AWAIT_REQUIREMENTS_APPROVAL', runs: [], approvals: [], approvalTokens: [], requirementChanges: [{ id, text: 'change', requestedAt: new Date().toISOString(), requestedBy: 'session-human-123456', fromPhase: 'BUILD', status: 'preparing', previousDocuments: [], previousApprovals: [], previousRuns: [] }] })
    await expect(prepareWorkspaceChangeBaseline(root, 'demo', id, ['src'])).rejects.toThrow('不能补造')
  } finally { await rm(root, { recursive: true, force: true }) }
})
