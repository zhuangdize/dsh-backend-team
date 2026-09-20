#!/usr/bin/env node
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const node = resolve(root, '.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node')
const npmCli = resolve(root, '.backend-team/runtime/nvm/versions/node/v24.19.0/lib/node_modules/npm/bin/npm-cli.js')
const dshRoot = resolve(root, '.backend-team/runtime/dsh/0.1.0-rc.6')
const dshBin = join(dshRoot, 'node_modules/.bin/dsh')
const dshHome = process.env.DSH_HOME ?? resolve(root, '.backend-team/runtime/dsh-home')
const profile = `qwen-real-team-slice-${process.pid}`
const profileDir = join(dshHome, 'profiles', profile)
const artifactDir = resolve(root, '.backend-team/artifacts/qwen-real-team-slice-20260917')
const workspace = join(artifactDir, 'workspace')
const observerDir = join(artifactDir, 'observer')
const observerPackDir = join(artifactDir, 'observer-pack')
const storeDir = join(artifactDir, 'store')
const evidencePath = join(artifactDir, 'evidence.json')
const firstEvidencePath = join(artifactDir, 'first.json')
const secondEvidencePath = join(artifactDir, 'second.json')
const observerName = '@dsh-backend-team/qwen-real-team-slice'
const productionModule = pathToFileURL(join(root, 'packages/bundle/lib/production.js')).href
const contextModule = pathToFileURL(join(root, 'packages/agent-team/dist/context-manager.js')).href
const developmentModule = pathToFileURL(join(root, 'packages/development/dist/file-development-checkpoint-store.js')).href

function assert(condition, message) { if (!condition) throw new Error(`real Qwen Team slice failed: ${message}`) }

async function run(file, args, options = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`${file} ${args.join(' ')} exited ${code}: ${stderr || stdout}`)))
  })
}

async function waitForEvidence(path, child, logs, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch { /* wait for the observer */ }
    if (child.exitCode !== null) throw new Error(`real Qwen observer exited before evidence: ${logs.join('').slice(-6000)}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error(`real Qwen observer timed out: ${logs.join('').slice(-6000)}`)
}

async function createObserver() {
  await mkdir(join(observerDir, 'lib'), { recursive: true, mode: 0o700 })
  const source = `import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { FileContextCheckpointStore } from ${JSON.stringify(contextModule)}
import { FileDevelopmentCheckpointStore } from ${JSON.stringify(developmentModule)}
import { createProductionActivation } from ${JSON.stringify(productionModule)}

const workspace = ${JSON.stringify(workspace)}
const phase = process.env.QWEN_TEAM_SLICE_PHASE
const evidencePath = ${JSON.stringify(firstEvidencePath)}
const secondEvidencePath = ${JSON.stringify(secondEvidencePath)}
const requestPath = 'acceptance/qwen-real-team-slice.txt'
const target = workspace + '/' + requestPath
const firstMarker = 'QWEN_REAL_TEAM_SLICE_OK\\n'
const secondMarker = 'QWEN_REAL_TEAM_SLICE_RESUMED_OK\\n'
const spec = 'QWEN_REAL_TEAM_SLICE_SPEC\\n'
const plan = 'QWEN_REAL_TEAM_SLICE_PLAN\\n'
const specHash = createHash('sha256').update(spec).digest('hex')
const planHash = createHash('sha256').update(plan).digest('hex')
const stableThreadId = 'qwen-real-team-slice-thread'
const baseContextStore = new FileContextCheckpointStore(workspace)
const contextStore = {
  load: async () => {
    const checkpoint = await baseContextStore.load(stableThreadId)
    return checkpoint === null ? null : { ...checkpoint, threadId: phase === 'first' ? 'qwen-real-team-slice-first' : 'qwen-real-team-slice-second' }
  },
  save: async checkpoint => baseContextStore.save({ ...checkpoint, threadId: stableThreadId }),
}
const developmentCheckpoints = new FileDevelopmentCheckpointStore(workspace)
const policyEngine = { authorize: async action => {
  const allowed = (action?.kind === 'read' || action?.kind === 'write') && (action?.targetPath === target || action?.targetPath === requestPath)
  return { effect: allowed ? 'allow' : 'deny', ruleId: allowed ? 'qwen-real-team-slice-owned-path' : 'qwen-real-team-slice-denied-path', reason: allowed ? 'isolated acceptance path' : 'only the marker file is in scope' }
} }
const artifactRegistry = { snapshot: async () => ({ featureDirectory: workspace, artifacts: [{ path: 'spec.md', sha256: specHash }, { path: 'plan.md', sha256: planHash }] }) }
const specification = { commandLoader: { load: async () => ({ id: 'qwen-real-team-slice-command', prompt: 'isolated probe', sourceRealPath: workspace + '/spec.md', sourceSha256: specHash }) }, artifactRegistry, artifactValidator: { validateForGate: async () => ({ valid: true, errors: [] }) } }

if (phase !== 'first' && phase !== 'second') throw new Error('QWEN_TEAM_SLICE_PHASE must be first or second')
const activation = await createProductionActivation({
  context: { agents: ctx.agents },
  workspaceRoot: workspace,
  recoveryToken: 'qwen-real-team-slice-recovery-token',
  policyEngine,
  provider: 'qwen-4399',
  model: 'qwen3.8-flash',
  pluginId: ${JSON.stringify(observerName)},
  specification,
  longTask: {
    runLease: { acquire: () => developmentCheckpoints.acquireRun() },
    contextStore,
    contextOptions: { contextWindowTokens: 131072, outputLimitTokens: 8192, toolBufferTokens: 8192, safetyMarginTokens: 4096, retainRecentMessages: 12, maxSummaryTokens: 2048 },
    budget: () => ({ taskMaxTokens: 131072, windowMaxTokens: 131072, compactionMaxTokens: 8192 }),
    renderPrompt: ({ prompt, projection }) => {
      const prior = projection.messages.slice(-6).map(message => message.role + ': ' + message.content.slice(0, 4000)).join('\\n')
      return prompt + '\\n\\nRESUMED CONTEXT (use only as prior task evidence):\\n' + (prior || '(none)')
    },
  },
})
if (activation.mode !== 'supported') throw new Error('production activation was read-only: ' + JSON.stringify({ missing: activation.missing, reasons: activation.reasons }))
try {
  const current = await activation.composition.stateStore.load()
  if (current === null) throw new Error('production state is unavailable')
  const approvals = [
    { kind: 'requirements', artifactHashes: { 'spec.md': specHash }, approvedAt: new Date().toISOString(), tokenId: 'qwen-real-team-slice-requirements' },
    { kind: 'design', artifactHashes: { 'spec.md': specHash, 'plan.md': planHash }, approvedAt: new Date().toISOString(), tokenId: 'qwen-real-team-slice-design' },
  ]
  if (phase === 'first') await activation.composition.stateStore.transact(current.revision, state => ({ ...state, phase: 'BUILD', approvals }))
  const before = await contextStore.load()
  const marker = phase === 'first' ? firstMarker : secondMarker
  const taskId = phase === 'first' ? 'qwen-real-team-slice-first' : 'qwen-real-team-slice-second'
  const task = await activation.composition.coordinator.dispatchExpert({
    id: taskId,
    role: 'developer',
    objective: phase === 'first'
      ? 'In the isolated acceptance workspace, use backend_team_write to create acceptance/qwen-real-team-slice.txt with exactly QWEN_REAL_TEAM_SLICE_OK followed by one newline. Then use backend_team_read to read it back and report the exact content and SHA-256. Do not access any other path, do not run commands, and do not call another Agent.'
      : 'This is the resumed second slice of the same isolated task. Use the resumed context and backend_team_read to verify acceptance/qwen-real-team-slice.txt contains QWEN_REAL_TEAM_SLICE_OK. Then use backend_team_write to append exactly QWEN_REAL_TEAM_SLICE_RESUMED_OK followed by one newline, read the complete file back, and report the exact content and SHA-256. Do not access any other path, do not run commands, and do not call another Agent.',
    nonGoals: ['Do not access any path outside acceptance/qwen-real-team-slice.txt', 'Do not run commands', 'Do not modify spec.md or plan.md', 'Do not claim test or command verification'],
    inputArtifacts: [{ path: 'spec.md', sha256: specHash }, { path: 'plan.md', sha256: planHash }],
    readPaths: [requestPath],
    writePaths: [requestPath],
    capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, testCodeWrite: false, configurationWrite: false, commandExecution: false, networkHosts: [], install: false, migration: false, canDelegate: false, canChangePhase: false, canApprove: false, canContactUser: false, canAnnounceCompletion: true },
    budget: { maxTokens: 131072, maxWallMs: 180000, maxToolCalls: 8, maxRetries: 0, maxChildren: 0 },
    doneWhen: ['The requested marker bytes exist in the owned file', 'The file was read back with backend_team_read'],
    verification: [{ id: 'marker-roundtrip', kind: 'inspection', instruction: 'Confirm the complete marker file content and SHA-256 using backend_team_read.', required: true }],
    returnSchema: 'AgentResult',
  })
  const output = await readFile(target, 'utf8')
  const expected = phase === 'first' ? firstMarker : firstMarker + secondMarker
  if (output !== expected) throw new Error('marker content mismatch: expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(output))
  const evidence = { status: 'passed', phase, provider: 'qwen-4399', model: 'qwen3.8-flash', api: 'openai-responses', activation: activation.mode, taskId, handoffStatus: task.status, changedPaths: task.changedPaths, consumedBudget: task.consumedBudget, checkpoint: { beforeRevision: before?.revision ?? 0, afterRevision: (await contextStore.load())?.revision ?? 0, transcriptMessages: (await contextStore.load())?.transcript.length ?? 0, threadId: stableThreadId }, outputPath: requestPath, outputSha256: createHash('sha256').update(output).digest('hex'), outputBytes: Buffer.byteLength(output), verification: 'inspection-only; no command or database execution', isolatedWorkspace: true }
  await writeFile(phase === 'first' ? evidencePath : secondEvidencePath, JSON.stringify(evidence, null, 2) + '\\n', { mode: 0o600 })
} finally {
  await activation.dispose()
}
`
  await writeFile(join(observerDir, 'package.json'), JSON.stringify({ name: observerName, version: '0.0.0-diagnostic.1', private: true, type: 'module', main: 'lib/index.js', files: ['lib', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n', { mode: 0o600 })
  const imports = source.split('\n').filter(line => line.startsWith('import ')).join('\n')
  const body = source.split('\n').filter(line => !line.startsWith('import ')).map(line => '  ' + line).join('\n')
  await writeFile(join(observerDir, 'lib/index.js'), `${imports}\nexport const name = ${JSON.stringify(observerName)}\nexport const inject = ['agents']\nexport async function apply(ctx) {\n${body}\n}\n`, { mode: 0o600 })
  await writeFile(join(observerDir, 'cordis.patch.yml'), `- insert:\n    - id: qwen-real-team-slice\n      name: ${JSON.stringify(observerName)}\n`, { mode: 0o600 })
}

async function packAndInstall() {
  await mkdir(observerPackDir, { recursive: true, mode: 0o700 })
  await mkdir(storeDir, { recursive: true, mode: 0o700 })
  const result = await run(node, [npmCli, 'pack', '--json', '--pack-destination', observerPackDir], { cwd: observerDir, env: { ...process.env, NPM_CONFIG_CACHE: join(artifactDir, 'npm-cache'), npm_config_cache: join(artifactDir, 'npm-cache') } })
  const filename = JSON.parse(result.stdout)[0]?.filename
  assert(typeof filename === 'string' && !filename.includes('/') && !filename.includes('..'), 'observer package filename is unsafe')
  const tarball = join(observerPackDir, filename)
  await run(join(dshRoot, 'node_modules/.bin/dsh'), ['plugin', '--profile', profile, 'add', tarball, '--ignore-scripts', '--store-dir', storeDir], { cwd: root, env: dshEnv() })
}

function dshEnv() {
  return { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1', CI: '1', NO_COLOR: '1', PATH: `${dirname(node)}:${join(dshRoot, 'node_modules/.bin')}:/usr/bin:/bin`, NPM_CONFIG_CACHE: join(artifactDir, 'npm-cache'), npm_config_cache: join(artifactDir, 'npm-cache') }
}

async function runPhase(phase, evidence) {
  const env = { ...dshEnv(), QWEN_TEAM_SLICE_PHASE: phase }
  const child = spawn(node, [dshBin, '--profile', profile, 'Qwen real Agent Team slice ' + phase], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  child.stdout.on('data', chunk => logs.push(chunk.toString()))
  child.stderr.on('data', chunk => logs.push(chunk.toString()))
  const result = await waitForEvidence(evidence, child, logs)
  if (child.exitCode === null) child.kill('SIGTERM')
  await new Promise(resolveClose => { const timer = setTimeout(resolveClose, 5000); child.once('close', () => { clearTimeout(timer); resolveClose() }) })
  assert(result.status === 'passed', JSON.stringify(result))
  return result
}

await rm(artifactDir, { recursive: true, force: true })
await mkdir(join(workspace, 'acceptance'), { recursive: true, mode: 0o700 })
await writeFile(join(workspace, 'spec.md'), 'QWEN_REAL_TEAM_SLICE_SPEC\n', { mode: 0o600 })
await writeFile(join(workspace, 'plan.md'), 'QWEN_REAL_TEAM_SLICE_PLAN\n', { mode: 0o600 })
await rm(profileDir, { recursive: true, force: true })
await mkdir(profileDir, { recursive: true, mode: 0o700 })
await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', observerName] } } }, null, 2) + '\n', { mode: 0o600 })
await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', { mode: 0o600 })
await writeFile(join(profileDir, 'cordis.yml'), '[]\n', { mode: 0o600 })
await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
try {
  assert(resolve(process.execPath) === node, 'verification must run with workspace-local Node 24')
  await access(dshBin)
  await createObserver()
  await packAndInstall()
  const first = await runPhase('first', firstEvidencePath)
  const second = await runPhase('second', secondEvidencePath)
  const checkpoint = JSON.parse(await readFile(join(workspace, '.backend-team', 'context', 'qwen-real-team-slice-thread.json'), 'utf8'))
  assert(checkpoint.revision >= first.checkpoint.afterRevision && checkpoint.revision > first.checkpoint.afterRevision, 'second phase did not advance the shared checkpoint')
  assert(second.checkpoint.beforeRevision === first.checkpoint.afterRevision, 'second phase did not resume the first checkpoint')
  const result = { status: 'passed', provider: 'qwen-4399', model: 'qwen3.8-flash', api: 'openai-responses', scope: 'one developer Agent, one owned marker file, two independent DSH processes', first, second, recovery: 'second official DSH process loaded the shared ContextManager checkpoint and completed the resumed slice', secretHandling: 'DSH UI configured credentials were used by the profile; no API key was recorded' }
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify(result) + '\n')
} finally {
  await rm(profileDir, { recursive: true, force: true })
}
