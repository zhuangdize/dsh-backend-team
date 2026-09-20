#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { HARNESS_VERSION, NODE_VERSION, resolveDshHome, resolveDshPath, resolveProfileName, resolveWorkspaceNodeExecutable, resolveWorkspaceRoot } from './backend-team-profile-options.mjs'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index]
  if (key?.startsWith('--')) args.set(key.slice(2), process.argv[index + 1] ?? '')
}
const workspace = resolveWorkspaceRoot(args.get('workspace'))
const profile = resolveProfileName(args.get('profile'))
const dshHome = resolveDshHome(workspace, args.get('dsh-home'))
const result = {
  workspace: '<workspace>',
  profile,
  dshHomeScope: isWithin(workspace, dshHome) ? 'workspace' : 'user',
  harness: 'not-installed',
  harnessVersion: HARNESS_VERSION,
  node: 'not-installed',
  nodeVersion: process.version.replace(/^v/u, ''),
  nodeExpectedVersion: NODE_VERSION,
  nodeArchitecture: process.arch,
  bundle: 'unknown',
  bundleRows: 0,
  stateSource: 'workspace-root',
  activeTaskId: null,
  tasks: [],
  dependencies: { manifest: 'unknown', lockfile: 'unknown', nodeModules: 'unknown' },
  state: 'unknown',
  stateSchema: 'unknown',
  stateRevision: null,
  approvals: 0,
  runs: 0,
  budget: { status: 'unknown', records: 0, blockedRecords: 0, blockedDimensions: [] },
  checkpoint: { status: 'unknown', passedSlices: 0, source: 'workspace-root' },
  recovery: { action: 'inspect-state', reason: '状态尚未完成检查' },
  runtime: { uv: 'not-installed', python: 'not-installed', specKit: 'not-installed' },
  postgresql: 'unknown',
  dbgate: 'unknown',
  notes: [],
}
function applyState(state, source) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false
  result.state = typeof state.phase === 'string' ? state.phase : 'unknown'
  result.stateSchema = state.schemaVersion ?? 'unknown'
  result.stateRevision = Number.isSafeInteger(state.revision) ? state.revision : null
  result.approvals = Array.isArray(state.approvals) ? state.approvals.length : 0
  result.runs = Array.isArray(state.runs) ? state.runs.length : 0
  result.stateSource = source
  if (typeof state.workflowError === 'string' && state.workflowError.length > 0) result.notes.push('workflow has a persisted failure; inspect the task and use continue only after the stated cause is addressed')
  return true
}
try { await resolveDshPath(undefined, workspace); result.harness = 'present' } catch { result.notes.push('workspace-local DSH is missing or invalid') }
try { await access(resolveWorkspaceNodeExecutable(workspace), constants.X_OK); result.node = 'present' } catch { result.notes.push('workspace-local Node 24.19.0 is missing') }
if (result.nodeVersion !== result.nodeExpectedVersion) result.notes.push(`doctor is running on Node ${result.nodeVersion}; expected workspace Node ${result.nodeExpectedVersion}`)
try {
  await access(resolve(workspace, 'package.json'), constants.R_OK)
  result.dependencies.manifest = 'present'
} catch { result.dependencies.manifest = 'missing'; result.notes.push('project package manifest is missing') }
try {
  await access(resolve(workspace, 'package-lock.json'), constants.R_OK)
  result.dependencies.lockfile = 'present'
} catch {
  try { await access(resolve(workspace, 'pnpm-lock.yaml'), constants.R_OK); result.dependencies.lockfile = 'present' }
  catch { result.dependencies.lockfile = 'missing'; result.notes.push('project dependency lockfile is missing') }
}
try { await access(resolve(workspace, 'node_modules'), constants.R_OK); result.dependencies.nodeModules = 'present' }
catch { result.dependencies.nodeModules = 'missing'; result.notes.push('project dependencies are not installed') }
try {
  applyState(JSON.parse(await readFile(resolve(workspace, '.backend-team/state/current.json'), 'utf8')), 'workspace-root')
} catch { result.notes.push('state is missing or unreadable') }
let unfinishedTaskCount = 0
let activeTaskStateMissing = false
try {
  const registry = JSON.parse(await readFile(resolve(workspace, '.backend-team/conversation-tasks.json'), 'utf8'))
  if (!Array.isArray(registry?.tasks)) throw new Error('invalid task registry')
  result.tasks = []
  for (const task of registry.tasks) {
    if (task === null || typeof task !== 'object' || typeof task.id !== 'string' || task.id.length === 0) continue
    let taskState
    try { taskState = JSON.parse(await readFile(resolve(workspace, `.backend-team/state-${task.id}/current.json`), 'utf8')) } catch { taskState = undefined }
    const phase = typeof taskState?.phase === 'string' ? taskState.phase : 'unknown'
    const arrangement = typeof task.shelvedAt === 'string' ? 'shelved' : typeof task.queuedAt === 'string' ? 'queued' : phase === 'DELIVER' ? 'completed' : 'unfinished'
    result.tasks.push({ id: task.id, title: cleanTitle(task.title), phase, arrangement, revision: Number.isSafeInteger(taskState?.revision) ? taskState.revision : null })
    if (arrangement === 'unfinished') unfinishedTaskCount++
  }
  const active = result.tasks.filter(task => task.arrangement === 'unfinished')
  if (active.length === 1) {
    result.activeTaskId = active[0].id
    try {
      applyState(JSON.parse(await readFile(resolve(workspace, `.backend-team/state-${active[0].id}/current.json`), 'utf8')), 'conversation-task')
    } catch {
      result.stateSource = 'conversation-task'
      activeTaskStateMissing = true
      result.notes.push('active task state is missing or unreadable')
    }
  } else if (active.length > 1) {
    result.notes.push('multiple unfinished conversation tasks found; resolve the task conflict before recovery')
  } else if (result.tasks.length > 0 && result.state !== 'unknown') {
    result.stateSource = 'workspace-root-legacy'
    result.notes.push('no unfinished conversation task is selected; workspace-root state is legacy or unassigned')
  }
} catch { result.notes.push('conversation task registry is missing or unreadable') }
try {
  const profilePackage = JSON.parse(await readFile(resolve(dshHome, 'profiles', profile, 'package.json'), 'utf8'))
  const dependencies = profilePackage.dependencies ?? {}
  const declaredBundles = profilePackage.dsh?.profile?.bundles
  result.bundleRows = Object.prototype.hasOwnProperty.call(dependencies, '@dsh-backend-team/bundle')
    ? 1
    : Array.isArray(declaredBundles) ? declaredBundles.filter((name) => name === '@dsh-backend-team/bundle').length : 0
  result.bundle = result.bundleRows === 0 ? 'not-installed' : 'installed'
} catch { result.bundle = 'not-installed' }
for (const [name, relative] of [['postgresql', '.backend-team/runtime/postgresql'], ['dbgate', '.backend-team/runtime/dbgate']]) { try { await access(resolve(workspace, relative), constants.R_OK); result[name] = 'present' } catch { result[name] = 'not-installed' } }
for (const [name, relative] of [['uv', '.backend-team/runtime/bin/uv'], ['python', '.backend-team/runtime/python'], ['specKit', '.backend-team/runtime/spec-kit/provenance.json']]) { try { await access(resolve(workspace, relative), constants.R_OK); result.runtime[name] = 'present' } catch { result.runtime[name] = 'not-installed' } }
try {
  const ledger = JSON.parse(await readFile(resolve(workspace, '.backend-team/state/budget-ledger.json'), 'utf8'))
  if (ledger?.schemaVersion !== 2 || !Array.isArray(ledger.records)) throw new Error('invalid budget ledger')
  const blocked = ledger.records.filter(record => record?.status === 'blocked:budget-exhausted')
  const blockedRecords = blocked.length
  const dimensions = [...new Set(blocked.flatMap(record => Array.isArray(record?.overrun?.exceeded) ? record.overrun.exceeded : []))]
    .filter(dimension => ['tokens', 'wallMs', 'toolCalls', 'retries', 'children'].includes(dimension))
    .sort()
  result.budget = { status: blockedRecords > 0 ? 'blocked' : 'ready', records: ledger.records.length, blockedRecords, blockedDimensions: dimensions }
  if (blockedRecords > 0) result.notes.push(dimensions.length > 0
    ? `one or more task budgets are exhausted (${dimensions.join(', ')}); inspect the recorded dimension before retrying`
    : 'one or more task budgets are exhausted; inspect the recorded dimension before retrying')
} catch (error) {
  if (error?.code === 'ENOENT') result.budget = { status: 'absent', records: 0, blockedRecords: 0, blockedDimensions: [] }
  else { result.budget = { status: 'invalid', records: 0, blockedRecords: 0, blockedDimensions: [] }; result.notes.push('budget ledger is missing or invalid') }
}
try {
  const checkpointPath = result.activeTaskId === null ? '.backend-team/development/checkpoint.json' : `.backend-team/development-${result.activeTaskId}/checkpoint.json`
  result.checkpoint.source = result.activeTaskId === null ? 'workspace-root' : 'conversation-task'
  const checkpoint = JSON.parse(await readFile(resolve(workspace, checkpointPath), 'utf8'))
  if (typeof checkpoint?.planHash !== 'string' || !Array.isArray(checkpoint.slices)) throw new Error('invalid checkpoint')
  const passedSlices = checkpoint.slices.filter(slice => slice?.status === 'passed').length
  result.checkpoint = { status: 'present', passedSlices, source: result.activeTaskId === null ? 'workspace-root' : 'conversation-task' }
} catch (error) {
  if (error?.code === 'ENOENT') result.checkpoint = { status: 'absent', passedSlices: 0 }
  else { result.checkpoint = { status: 'invalid', passedSlices: 0 }; result.notes.push('development checkpoint is missing or invalid; do not skip slices during recovery') }
}
const phase = result.state
if (unfinishedTaskCount > 1) result.recovery = { action: 'inspect-state', reason: '存在多个未完成会话任务，先在当前对话处理任务冲突后再恢复' }
else if (activeTaskStateMissing) result.recovery = { action: 'inspect-state', reason: '当前任务状态缺失或不可读，先核对任务记录后再恢复' }
else if (unfinishedTaskCount === 0 && result.stateSource === 'workspace-root-legacy') result.recovery = { action: 'inspect-state', reason: '当前没有可安全恢复的会话任务，先查看历史任务状态' }
else if (phase === 'AWAIT_REQUIREMENTS_APPROVAL' || phase === 'AWAIT_DESIGN_APPROVAL') result.recovery = { action: 'preview-and-confirm', reason: '当前阶段需要先查看并确认方案' }
else if (phase === 'BUILD' || phase === 'VERIFY') result.recovery = result.budget.status === 'blocked'
  ? { action: 'inspect-state', reason: '预算账本存在耗尽记录，先核对耗尽维度和对应任务后再决定恢复' }
  : result.checkpoint.passedSlices > 0 ? { action: 'continue', reason: '已保存通过切片，继续前会复核审批和交接证据' } : { action: 'inspect-state', reason: '开发阶段没有可跳过的检查点' }
else if (phase === 'DELIVER') result.recovery = { action: 'none', reason: '任务已交付，无需恢复开发' }
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function cleanTitle(value) {
  if (typeof value !== 'string') return '未命名任务'
  const title = value.replace(workspace, '<workspace>').replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|private|var|tmp|home)\/)[^\s]+/gu, '<path>').replace(/[\r\n\t]+/gu, ' ').trim()
  return title.length > 120 ? title.slice(0, 117) + '…' : title
}

function isWithin(parent, child) {
  const root = resolve(parent)
  const target = resolve(child)
  return target === root || target.startsWith(`${root}/`)
}
