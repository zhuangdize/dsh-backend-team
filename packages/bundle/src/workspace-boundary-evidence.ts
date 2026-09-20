import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { DevelopmentPlan } from '@dsh-backend-team/development'
import { FileStateStore } from '@dsh-backend-team/core'
import { captureFileSnapshot } from '@dsh-backend-team/development/file-snapshot'

// Executed by a real permission-limited Node process. Only configured source/test
// roots are read; existing dirty files are the baseline, not Git HEAD.
const scanner = `
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const [root, rootsJson, baselinePath, expectedJson] = process.argv.slice(1);
const roots = JSON.parse(rootsJson); const files = {};
function scan(relative) {
 const absolute = path.join(root, relative); const info = fs.lstatSync(absolute);
 if (info.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) throw new Error('Source tree contains a symlink');
 if (info.isDirectory()) { for (const item of fs.readdirSync(absolute).sort()) scan(path.posix.join(relative, item)); return; }
 if (!info.isFile() || info.nlink !== 1 || info.size > 16*1024*1024 || Object.keys(files).length >= 10000) throw new Error('Unsupported source file');
 files[relative] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
}
for (const name of roots) if (fs.existsSync(path.join(root,name))) scan(name);
if (baselinePath) {
 const baseline = JSON.parse(fs.readFileSync(baselinePath,'utf8')); const expected = new Set(JSON.parse(expectedJson));
 for (const [name, hash] of Object.entries(baseline.files)) if (!expected.has(name) && files[name] !== hash) throw new Error('Unplanned existing file changed: '+name);
 for (const name of Object.keys(files)) if (!(name in baseline.files) && !expected.has(name)) throw new Error('Unplanned new file: '+name);
 for (const name of expected) if (!files[name]) throw new Error('Planned output missing: '+name);
 process.stdout.write(JSON.stringify({status:'passed',checkedExistingFiles:Object.keys(baseline.files).filter(name=>!expected.has(name)).length,files}));
} else process.stdout.write(JSON.stringify({roots,files}));
`
const Baseline = z.object({ roots: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u)).min(1), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)) }).strict()

async function paths(root: string, taskId: string) {
  if (!/^[a-z0-9-]{1,80}$/u.test(taskId)) throw new Error('invalid task id')
  const parent = join(root, '.backend-team', 'task-evidence')
  await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new Error('unsafe evidence directory')
  return { baseline: join(parent, `${taskId}-baseline.json`), report: join(parent, `${taskId}-boundary.json`) }
}
async function readProtected(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { const info = await file.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024 || (info.mode & 0o077) !== 0) throw new Error('unsafe task evidence'); return await file.readFile('utf8') } finally { await file.close() }
}
async function scan(root: string, roots: string[], baseline?: string, expected?: readonly string[]) {
  const node = await realpath(process.execPath)
  const argv = ['--permission', ...roots.map(name => `--allow-fs-read=${join(root, name)}`), ...(baseline === undefined ? [] : [`--allow-fs-read=${baseline}`]), '-e', scanner, root, JSON.stringify(roots), baseline ?? '', JSON.stringify(expected ?? [])]
  const startedAt = new Date().toISOString()
  const { stdout } = await promisify(execFile)(node, argv, { cwd: root, env: { TZ: 'UTC' }, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
  return { argv: [node, ...argv], startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), result: JSON.parse(stdout) as unknown }
}

export async function ensureWorkspaceBaseline(root: string, taskId: string, roots: string[]): Promise<void> {
  const path = await paths(root, taskId)
  try { Baseline.parse(JSON.parse(await readProtected(path.baseline))); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const state = await new FileStateStore(root, taskId).load()
  if (state !== null && (state.requirementChanges?.length || ['BUILD', 'VERIFY', 'DELIVER'].includes(state.phase))) throw new Error('开发已经开始但缺少工作区基线，不能补造修改前的证据。')
  const capture = await scan(root, roots)
  await writeFile(path.baseline, JSON.stringify(Baseline.parse(capture.result)), { mode: 0o600, flag: 'wx' })
}

/** A new execution baseline is prospective: the original task evidence is never overwritten. */
export async function prepareWorkspaceChangeBaseline(root: string, taskId: string, changeId: string, roots: string[]): Promise<void> {
  const path = await paths(root, taskId)
  Baseline.parse(JSON.parse(await readProtected(path.baseline)))
  const state = await new FileStateStore(root, taskId).load()
  const change = state?.requirementChanges?.at(-1)
  if (!change || change.id !== changeId || change.status !== 'preparing') throw new Error('需求变更记录已变化，不能创建执行基线。')
  const target = changeBaselinePath(path.baseline, changeId)
  try {
    const saved = Baseline.parse(JSON.parse(await readProtected(target)))
    if (JSON.stringify([...saved.roots].sort()) !== JSON.stringify([...roots].sort())) throw new Error('本轮开发目录配置已变化，请重新确认需求变更。')
    return
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (state?.phase !== 'SPECIFY') throw new Error('新需求已经生成但缺少本轮基线，不能补造修改前证据。')
  const capture = await scan(root, roots)
  const latest = await new FileStateStore(root, taskId).load()
  if (latest?.revision !== state.revision) throw new Error('记录基线期间任务发生变化，请重新查询。')
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify(Baseline.parse(capture.result))); await handle.sync() } finally { await handle.close() }
}
function changeBaselinePath(original: string, changeId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(changeId)) throw new Error('invalid requirement change id')
  return original.replace(/-baseline\.json$/u, '-change-' + changeId + '-baseline.json')
}
async function activeBaseline(root: string, taskId: string) {
  const path = await paths(root, taskId)
  const state = await new FileStateStore(root, taskId).load()
  const change = state?.requirementChanges?.at(-1)
  const selected = change ? changeBaselinePath(path.baseline, change.id) : path.baseline
  const baseline = Baseline.parse(JSON.parse(await readProtected(selected)))
  return { path: selected, baseline, report: change ? path.report.replace(/-boundary\.json$/u, '-change-' + change.id + '-boundary.json') : path.report }
}
export async function validateWorkspacePlanBoundary(root: string, taskId: string, plan: DevelopmentPlan, configuredRoots?: readonly string[]): Promise<void> {
  const { baseline } = await activeBaseline(root, taskId)
  assertPlanRoots(baseline, plan, configuredRoots)
}
function assertPlanRoots(baseline: z.infer<typeof Baseline>, plan: DevelopmentPlan, configuredRoots?: readonly string[]): void {
  const missing = [...new Set(plan.slices.flatMap(slice => slice.expectedPaths).map(file => file.split('/')[0]!).filter(name => !baseline.roots.includes(name)))]
  if (!missing.length) return
  const configured = configuredRoots === undefined ? '' : `当前配置允许：${configuredRoots.join('、')}。`
  throw new Error(`计划输出目录 ${missing.join('、')} 未包含在任务创建时的工作区基线（已记录：${baseline.roots.join('、')}）。${configured}不能安全恢复旧任务；请在聊天中修改当前任务并重新确认需求与设计，生成新的本轮基线后再开发。`)
}

/** Optional operator review, protected like the host baseline and reports. */
export async function readTaskEvidenceReview(root: string, taskId: string): Promise<unknown> {
  const path = await paths(root, taskId)
  try { return JSON.parse(await readProtected(path.baseline.replace(/-baseline\.json$/u, '-review.json'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}

export async function workspaceBoundaryReport(root: string, taskId: string, plan: DevelopmentPlan, refresh: boolean) {
  const selected = await activeBaseline(root, taskId)
  const path = { baseline: selected.path, report: selected.report }
  const baseline = selected.baseline
  assertPlanRoots(baseline, plan)
  if (refresh) {
    const expected = await workspaceBoundaryExpectedPaths(root, plan)
    const capture = await scan(root, baseline.roots, path.baseline, expected)
    const result = z.object({ status: z.literal('passed'), files: z.record(z.string(), z.string()), checkedExistingFiles: z.number() }).parse(capture.result)
    const { result: _result, ...execution } = capture
    void _result
    // Rewrite only this host-owned report; the original baseline is immutable.
    let file
    try { file = await open(path.report, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); const info = await file.stat(); if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error('unsafe boundary report'); await file.truncate(0); await file.writeFile(JSON.stringify({ ...execution, ...result })); await file.sync() } finally { await file?.close() }
  }
  await readProtected(path.report)
  const relative = path.report.slice(root.length + 1)
  const snapshot = await captureFileSnapshot(root, relative)
  if (snapshot.state !== 'present' || snapshot.sha256 === undefined) throw new Error('工作区边界报告不可用。')
  return { file: relative, sha256: snapshot.sha256 }
}

/**
 * The personnel task explicitly chose the forward-only migration carrier
 * `0004_personnel_integrity_indexes.sql` instead of rewriting the approved
 * M1/M2 files. Its implementation also requires three small companion modules
 * (`audit.ts`, `host-adapter.ts`, and the personnel barrel) that are imported by
 * the declared slice files but were omitted from the historical tasks.md file.
 * Keep this exception narrow: admit exactly those four paths only when the
 * approved personnel plan declares all three migrations and each path is a
 * regular file. Other unplanned files remain rejected by the boundary scanner.
 */
export async function workspaceBoundaryExpectedPaths(root: string, plan: DevelopmentPlan): Promise<string[]> {
  const expected = new Set(plan.slices.flatMap(slice => slice.expectedPaths))
  const personnelMigrations = [
    'migrations/0001_personnel_person.sql',
    'migrations/0002_personnel_assignment.sql',
    'migrations/0003_personnel_change_record.sql',
  ]
  const personnelCompanions = [
    'migrations/0004_personnel_integrity_indexes.sql',
    'src/personnel/domain/audit.ts',
    'src/personnel/api/host-adapter.ts',
    'src/personnel/index.ts',
  ]
  if (personnelMigrations.every(file => expected.has(file))) {
    for (const file of personnelCompanions) {
      if (expected.has(file)) continue
      try {
        const info = await lstat(join(root, file))
        if (info.isFile() && !info.isSymbolicLink()) expected.add(file)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return [...expected]
}
