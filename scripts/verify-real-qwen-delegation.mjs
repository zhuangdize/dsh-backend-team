#!/usr/bin/env node
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const node = resolve(root, '.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node')
const npmCli = resolve(root, '.backend-team/runtime/nvm/versions/node/v24.19.0/lib/node_modules/npm/bin/npm-cli.js')
const dshRoot = resolve(root, '.backend-team/runtime/dsh/0.1.0-rc.6')
const dshBin = join(dshRoot, 'node_modules/.bin/dsh')
const dshHome = process.env.DSH_HOME ?? resolve(root, '.backend-team/runtime/dsh-home')
const profile = `qwen-real-delegation-${process.pid}`
const profileDir = join(dshHome, 'profiles', profile)
const artifactDir = resolve(root, '.backend-team/artifacts/qwen-real-delegation-20260917')
const workspace = join(artifactDir, 'workspace')
const observerDir = join(artifactDir, 'observer')
const observerPackDir = join(artifactDir, 'observer-pack')
const storeDir = join(artifactDir, 'store')
const evidencePath = join(artifactDir, 'evidence.json')
const observerName = '@dsh-backend-team/qwen-real-delegation'
const productionModule = pathToFileURL(join(root, 'packages/bundle/lib/production.js')).href
const requestPath = 'acceptance/qwen-real-delegation.txt'
const specText = 'QWEN_REAL_DELEGATION_SPEC\n'
const planText = 'QWEN_REAL_DELEGATION_PLAN\n'
const specHash = createHash('sha256').update(specText).digest('hex')
const planHash = createHash('sha256').update(planText).digest('hex')

function assert(condition, message) { if (!condition) throw new Error(`real Qwen delegation failed: ${message}`) }
async function run(file, args, options = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`${file} ${args.join(' ')} exited ${code}: ${stderr || stdout}`)))
  })
}
async function waitForEvidence(child, logs, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(evidencePath, 'utf8')) } catch { /* observer still running */ }
    if (child.exitCode !== null) throw new Error(`observer exited before evidence: ${logs.join('').slice(-6000)}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error(`observer timed out: ${logs.join('').slice(-6000)}`)
}
function dshEnv() {
  return { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1', CI: '1', NO_COLOR: '1', PATH: `${dirname(node)}:${join(dshRoot, 'node_modules/.bin')}:/usr/bin:/bin`, NPM_CONFIG_CACHE: join(artifactDir, 'npm-cache'), npm_config_cache: join(artifactDir, 'npm-cache') }
}
async function createObserver() {
  await mkdir(join(observerDir, 'lib'), { recursive: true, mode: 0o700 })
  const source = `import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createProductionActivation } from ${JSON.stringify(productionModule)}
const workspace = ${JSON.stringify(workspace)}
const evidencePath = ${JSON.stringify(evidencePath)}
const requestPath = ${JSON.stringify(requestPath)}
const target = workspace + '/' + requestPath
const marker = 'QWEN_REAL_DELEGATION_WORKER_OK\\n'
const specHash = ${JSON.stringify(specHash)}
const planHash = ${JSON.stringify(planHash)}
const workerId = 'qwen-real-delegation-worker'
const expertId = 'qwen-real-delegation-expert'
const policyEngine = { authorize: async action => {
  const allowed = (action?.kind === 'read' || action?.kind === 'write') && (action?.targetPath === target || action?.targetPath === requestPath)
  return { effect: allowed ? 'allow' : 'deny', ruleId: allowed ? 'qwen-real-delegation-owned-path' : 'qwen-real-delegation-denied-path', reason: allowed ? 'isolated delegation path' : 'only the marker file is in scope' }
} }
const artifactRegistry = { snapshot: async () => ({ featureDirectory: workspace, artifacts: [{ path: 'spec.md', sha256: specHash }, { path: 'plan.md', sha256: planHash }] }) }
const specification = { commandLoader: { load: async () => ({ id: 'qwen-real-delegation-command', prompt: 'isolated delegation probe', sourceRealPath: workspace + '/spec.md', sourceSha256: specHash }) }, artifactRegistry, artifactValidator: { validateForGate: async () => ({ valid: true, errors: [] }) } }
const activation = await createProductionActivation({ context: { agents: ctx.agents }, workspaceRoot: workspace, recoveryToken: 'qwen-real-delegation-recovery-token', policyEngine, provider: 'qwen-4399', model: 'qwen3.8-flash', pluginId: ${JSON.stringify(observerName)}, specification })
if (activation.mode !== 'supported') throw new Error('production activation was read-only: ' + JSON.stringify({ missing: activation.missing, reasons: activation.reasons }))
try {
  const current = await activation.composition.stateStore.load()
  if (current === null) throw new Error('production state is unavailable')
  await activation.composition.stateStore.transact(current.revision, state => ({ ...state, phase: 'BUILD', approvals: [
    { kind: 'requirements', artifactHashes: { 'spec.md': specHash }, approvedAt: new Date().toISOString(), tokenId: 'qwen-real-delegation-requirements' },
    { kind: 'design', artifactHashes: { 'spec.md': specHash, 'plan.md': planHash }, approvedAt: new Date().toISOString(), tokenId: 'qwen-real-delegation-design' },
  ] }))
  const handoff = await activation.composition.coordinator.dispatchExpert({
    id: expertId,
    role: 'developer',
    objective: 'In this isolated acceptance workspace, you are the direct expert. Before any file work, call backend_team_delegate_worker exactly once using a self-contained worker task with id qwen-real-delegation-worker, parentTaskId qwen-real-delegation-expert, depth 2, role worker, objective: use backend_team_write to create acceptance/qwen-real-delegation.txt with exactly QWEN_REAL_DELEGATION_WORKER_OK followed by one newline, then use backend_team_read to read it back and report the exact content and SHA-256. The worker must have nonGoals [Do not access any path outside acceptance/qwen-real-delegation.txt, Do not run commands, Do not call another Agent], inputArtifacts [], readPaths [acceptance/qwen-real-delegation.txt], writePaths [acceptance/qwen-real-delegation.txt], capabilities readProjectFiles=true/writeOwnedFiles=true/businessCodeWrite=true/canDelegate=false with every other capability false, budget maxTokens=65536/maxWallMs=120000/maxToolCalls=6/maxRetries=0/maxChildren=0, doneWhen [The marker bytes exist, The worker read the file], verification [{id: worker-marker-roundtrip, kind: inspection, instruction: Confirm the complete marker with backend_team_read, required: true}], returnSchema AgentResult. Wait for the worker handoff. Then read the file yourself and return one valid AgentResult JSON for this expert with childResultIds containing the exact handoffId from backend_team_delegate_worker. Do not use any other tool, run commands, or modify another path.',
    nonGoals: ['Do not access any path outside acceptance/qwen-real-delegation.txt', 'Do not run commands', 'Do not call another Agent except the required worker'], inputArtifacts: [], readPaths: [requestPath], writePaths: [requestPath], capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, testCodeWrite: false, configurationWrite: false, commandExecution: false, networkHosts: [], install: false, migration: false, canDelegate: true, canChangePhase: false, canApprove: false, canContactUser: false, canAnnounceCompletion: true }, budget: { maxTokens: 196608, maxWallMs: 300000, maxToolCalls: 12, maxRetries: 0, maxChildren: 1 }, doneWhen: ['The worker handoff is completed and acknowledged by the expert', 'The marker file is read back by the expert'], verification: [{ id: 'delegation-marker-roundtrip', kind: 'inspection', instruction: 'Confirm the worker handoff and complete marker using backend_team_read.', required: true }], returnSchema: 'AgentResult',
  })
  const output = await readFile(target, 'utf8')
  if (output !== marker) throw new Error('worker marker content mismatch: ' + JSON.stringify(output))
  const state = await activation.composition.stateStore.load()
  const workerRun = state?.runs.find(run => run.id === 'agent-' + workerId)
  if (workerRun?.status !== 'passed') throw new Error('worker run was not durably recorded as passed: ' + JSON.stringify(workerRun))
  await writeFile(evidencePath, JSON.stringify({ status: 'passed', provider: 'qwen-4399', model: 'qwen3.8-flash', api: 'openai-responses', activation: activation.mode, expertTaskId: expertId, expertHandoffStatus: handoff.status, expertChildResultIds: handoff.childResultIds, workerTaskId: workerId, workerRunStatus: workerRun.status, outputPath: requestPath, outputSha256: createHash('sha256').update(output).digest('hex'), outputBytes: Buffer.byteLength(output), verification: 'real Qwen expert delegated a depth-two worker through the production tool; ownership, capability narrowing and durable child acknowledgement passed', isolatedWorkspace: true }, null, 2) + '\\n', { mode: 0o600 })
} finally { await activation.dispose() }
`
  await writeFile(join(observerDir, 'package.json'), JSON.stringify({ name: observerName, version: '0.0.0-diagnostic.1', private: true, type: 'module', main: 'lib/index.js', files: ['lib', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n', { mode: 0o600 })
  const imports = source.split('\n').filter(line => line.startsWith('import ')).join('\n')
  const body = source.split('\n').filter(line => !line.startsWith('import ')).map(line => '  ' + line).join('\n')
  await writeFile(join(observerDir, 'lib/index.js'), `${imports}\nexport const name = ${JSON.stringify(observerName)}\nexport const inject = ['agents']\nexport async function apply(ctx) {\n${body}\n}\n`, { mode: 0o600 })
  await writeFile(join(observerDir, 'cordis.patch.yml'), `- insert:\n    - id: qwen-real-delegation\n      name: ${JSON.stringify(observerName)}\n`, { mode: 0o600 })
}

await rm(artifactDir, { recursive: true, force: true })
await mkdir(join(workspace, 'acceptance'), { recursive: true, mode: 0o700 })
await writeFile(join(workspace, 'spec.md'), specText, { mode: 0o600 })
await writeFile(join(workspace, 'plan.md'), planText, { mode: 0o600 })
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
  await mkdir(observerPackDir, { recursive: true, mode: 0o700 })
  await mkdir(storeDir, { recursive: true, mode: 0o700 })
  const packed = await run(node, [npmCli, 'pack', '--json', '--pack-destination', observerPackDir], { cwd: observerDir, env: dshEnv() })
  const filename = JSON.parse(packed.stdout)[0]?.filename
  assert(typeof filename === 'string' && !filename.includes('/') && !filename.includes('..'), 'observer package filename is unsafe')
  await run(dshBin, ['plugin', '--profile', profile, 'add', join(observerPackDir, filename), '--ignore-scripts', '--store-dir', storeDir], { cwd: root, env: dshEnv() })
  const child = spawn(node, [dshBin, '--profile', profile, 'Qwen real Agent Team delegation'], { cwd: root, env: dshEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  child.stdout.on('data', chunk => logs.push(chunk.toString()))
  child.stderr.on('data', chunk => logs.push(chunk.toString()))
  const result = await waitForEvidence(child, logs)
  if (child.exitCode === null) child.kill('SIGTERM')
  await new Promise(resolveClose => { const timer = setTimeout(resolveClose, 5000); child.once('close', () => { clearTimeout(timer); resolveClose() }) })
  assert(result.status === 'passed', JSON.stringify(result))
  process.stdout.write(JSON.stringify(result) + '\n')
} finally { await rm(profileDir, { recursive: true, force: true }) }
