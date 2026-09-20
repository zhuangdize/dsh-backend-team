#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeRoot = resolve(root, '.backend-team/runtime/nvm/versions/node/v24.19.0')
const harnessVersion = '0.1.0-rc.6'
const dshBin = resolve(root, `.backend-team/runtime/dsh/${harnessVersion}/node_modules/.bin/dsh`)
const localBin = dirname(dshBin)
const npmBin = resolve(nodeRoot, 'bin/npm')
const observerName = '@dsh-backend-team/t25-long-task-runtime-observer'

function assert(condition, message) {
  if (!condition) throw new Error(`long-task runtime verification failed: ${message}`)
}

async function run(file, args, options) {
  try {
    return await execFileAsync(file, args, { maxBuffer: 8 * 1024 * 1024, ...options })
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${file} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: error })
  }
}

function environment(temp, workspace, artifact, phase) {
  return {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${localBin}:/usr/bin:/bin`,
    DSH_HOME: join(temp, 'dsh-home'),
    XDG_CONFIG_HOME: join(temp, 'xdg-config'),
    XDG_CACHE_HOME: join(temp, 'xdg-cache'),
    NPM_CONFIG_CACHE: join(temp, 'npm-cache'),
    npm_config_cache: join(temp, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: join(temp, 'npmrc'),
    npm_config_userconfig: join(temp, 'npmrc'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    npm_config_registry: 'https://registry.npmjs.org/',
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_DISABLED: '1',
    CI: '1',
    NO_COLOR: '1',
    npm_config_ignore_scripts: 'true',
    T25_WORKSPACE: workspace,
    T25_ARTIFACT: artifact,
    T25_PHASE: phase,
    T25_RECOVERY_TOKEN: 't25-runtime-recovery-token-1234',
  }
}

async function pack(directory, destination, env) {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const result = await run(process.execPath, [npmBin, 'pack', '--json', '--pack-destination', destination], { cwd: directory, env })
  const record = JSON.parse(result.stdout)[0]
  const filename = record?.filename
  assert(typeof filename === 'string' && filename === filename.split('/').at(-1) && !filename.includes('..'), 'npm pack returned an unsafe filename')
  return join(destination, filename)
}

async function createObserver(temp, adapterUrl, contextUrl, longTaskUrl, developmentUrl, ownershipUrl) {
  const directory = join(temp, 'observer')
  await mkdir(join(directory, 'lib'), { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: observerName,
    version: '0.0.0-diagnostic.1',
    private: true,
    type: 'module',
    main: 'lib/index.js',
    files: ['lib', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`, { mode: 0o600 })
  const source = `import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { HarnessAgentRuntime } from ${JSON.stringify(adapterUrl)}
import { FileContextCheckpointStore } from ${JSON.stringify(contextUrl)}
import { LongTaskExecutionSession, ownershipPort } from ${JSON.stringify(longTaskUrl)}
import { FileDevelopmentCheckpointStore } from ${JSON.stringify(developmentUrl)}
import { OwnershipManager } from ${JSON.stringify(ownershipUrl)}

const artifact = process.env.T25_ARTIFACT
const taskId = 't25-runtime-slice'
const provider = 'dsh-agent-runtime-probe'
const recoveryToken = process.env.T25_RECOVERY_TOKEN
const contextOptions = { contextWindowTokens: 16384, outputLimitTokens: 256, toolBufferTokens: 256, safetyMarginTokens: 128, retainRecentMessages: 3, maxSummaryTokens: 256 }
const budget = { taskMaxTokens: 256, windowMaxTokens: 128, compactionMaxTokens: 64 }

export const name = ${JSON.stringify(observerName)}
export const inject = ['agents', 'agentLoop', 'llm']

export async function apply(ctx) {
  try {
    const workspace = process.env.T25_WORKSPACE
    const phase = process.env.T25_PHASE
    if (typeof workspace !== 'string' || typeof artifact !== 'string' || (phase !== 'first' && phase !== 'second')) throw new Error('probe environment is incomplete')
    await mkdir(join(workspace, 'src'), { recursive: true, mode: 0o700 })
    const unregister = ctx.llm.registerAdapter([provider], {
      providerInfo: (id) => ({ id, name: 'T25 official runtime probe' }),
      providerRetryPolicy: () => undefined,
      resolveModel: async (id, model) => ({ provider: id, id: model, name: model }),
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: 'probe result' }
        yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    })
    const ownership = new OwnershipManager({ workspaceRoot: workspace, recoveryToken })
    const heldLease = ownership.acquire(taskId, ['src'], 'write')
    const contextStore = new FileContextCheckpointStore(workspace)
    const developmentCheckpoints = new FileDevelopmentCheckpointStore(workspace, taskId)
    const before = await contextStore.load(taskId)
    let created
    const runtime = new HarnessAgentRuntime({
      context: { agents: { create: async (options) => { created = await ctx.agents.create(options); return created } } },
      setupAgent: async (agentCtx) => {
        const owner = agentCtx.agent
        if (!owner || typeof agentCtx.tools?.guard !== 'function') throw new Error('official Agent setup context is incomplete')
        if (ctx.agents.get(owner.id) !== undefined) throw new Error('Agent was published before setup')
        agentCtx.tools.guard((execution) => execution.agent === owner ? 'runtime probe does not execute tools' : 'Agent identity mismatch')
      },
      cwd: workspace,
      provider,
      model: 'probe-model',
      pluginId: ${JSON.stringify(observerName)},
      decodeResult: ({ hostUsage }) => ({ hostUsage }),
      executionSessionFactory: async () => LongTaskExecutionSession.open({
        taskId,
        readPaths: ['src'],
        writePaths: ['src'],
        runLease: { acquire: () => developmentCheckpoints.acquireRun() },
        ownership: ownershipPort(ownership),
        contextStore,
        contextOptions,
        budget,
      }),
    })
    const agentTask = {
      id: phase === 'first' ? 't25-runtime-first' : 't25-runtime-second',
      parentTaskId: 't25-runtime-parent',
      depth: 1,
      role: 'tester',
      objective: phase === 'first' ? 'Persist the first official Agent slice.' : 'Resume the persisted official Agent slice.',
      nonGoals: ['do not change files', 'do not run external commands'],
      inputArtifacts: [],
      readPaths: ['src'],
      writePaths: ['src'],
      capabilities: {
        readProjectFiles: true, writeOwnedFiles: false, businessCodeWrite: false, testCodeWrite: false,
        configurationWrite: false, commandExecution: false, networkHosts: [], install: false, migration: false,
        canDelegate: false, canChangePhase: false, canApprove: false, canContactUser: false,
        canAnnounceCompletion: true,
      },
      budget: { maxTokens: 128, maxWallMs: 10000, maxToolCalls: 4, maxRetries: 0, maxChildren: 0 },
      doneWhen: ['official runtime probe completes'],
      verification: [{ id: 't25-runtime-probe', kind: 'inspection', instruction: 'record official Agent runtime result', required: true }],
      returnSchema: 'AgentResult',
    }
    const application = await runtime.spawn({ task: phase === 'first' ? 'persist this official slice' : 'resume this official slice', role: 'tester', context: { phase }, agentTask })
    const result = await application.result()
    const checkpoint = await contextStore.load(taskId)
    if (checkpoint === null) throw new Error('context checkpoint was not persisted')
    if (created === undefined) throw new Error('official Agent was not created')
    ownership.release(heldLease)
    unregister()
    await writeFile(artifact, JSON.stringify({
      status: 'passed',
      phase,
      officialAgent: { id: created.agent.id, provider: created.agent.options.provider, model: created.agent.options.model, maxTokens: created.agent.options.maxTokens, disposed: ctx.agents.get(application.id) === undefined },
      resumedFromRevision: before?.revision ?? null,
      checkpoint: { revision: checkpoint.revision, transcriptMessages: checkpoint.transcript.length, lastRoles: checkpoint.transcript.slice(-3).map((message) => message.role), threadId: checkpoint.threadId },
      result: result.hostUsage,
    }))
  } catch (error) {
    await writeFile(artifact, JSON.stringify({ status: 'failed', phase: process.env.T25_PHASE, error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) } }))
  }
}
`
  await writeFile(join(directory, 'lib/index.js'), source, { mode: 0o600 })
  await writeFile(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: t25-long-task-runtime-observer\n      name: ${JSON.stringify(observerName)}\n`, { mode: 0o600 })
  return directory
}

async function waitForArtifact(path, child, output) {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch {
      if (child.exitCode !== null) throw new Error(`observer exited before publishing evidence: ${output.join('')}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  }
  throw new Error(`observer did not publish evidence within 45 seconds: ${output.join('')}`)
}

async function boot(env, artifact) {
  const child = spawn(process.execPath, [dshBin, '--profile', 'headless', 'diagnostic'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  const collect = (chunk) => output.push(chunk.toString())
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  try {
    const result = await waitForArtifact(artifact, child, output)
    assert(result.status === 'passed', JSON.stringify(result))
    return result
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await new Promise((resolveClose) => {
      const timer = setTimeout(resolveClose, 5000)
      child.once('close', () => { clearTimeout(timer); resolveClose() })
    })
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

const temp = await mkdtemp(join(tmpdir(), 'dsh-long-task-runtime-'))
try {
  assert(resolve(process.execPath).startsWith(nodeRoot), 'Node must come from workspace-local Node 24')
  await access(dshBin)
  const workspace = join(temp, 'workspace')
  const artifactDir = join(temp, 'artifacts')
  await mkdir(join(workspace, 'src'), { recursive: true, mode: 0o700 })
  await mkdir(artifactDir, { recursive: true, mode: 0o700 })
  const env = environment(temp, workspace, join(artifactDir, 'first.json'), 'first')
  await mkdir(join(temp, 'npm-cache'), { recursive: true, mode: 0o700 })
  await mkdir(join(temp, 'xdg-config'), { recursive: true, mode: 0o700 })
  await mkdir(join(temp, 'xdg-cache'), { recursive: true, mode: 0o700 })
  await writeFile(join(temp, 'npmrc'), 'registry=https://registry.npmjs.org/\nignore-scripts=true\n', { mode: 0o600 })
  const adapterUrl = pathToFileURL(resolve(root, 'packages/harness-adapter/dist/harness-agent-runtime.js')).href
  const contextUrl = pathToFileURL(resolve(root, 'packages/agent-team/dist/context-manager.js')).href
  const longTaskUrl = pathToFileURL(resolve(root, 'packages/agent-team/dist/long-task-execution-session.js')).href
  const developmentUrl = pathToFileURL(resolve(root, 'packages/development/dist/file-development-checkpoint-store.js')).href
  const ownershipUrl = pathToFileURL(resolve(root, 'packages/agent-team/dist/ownership-manager.js')).href
  const observerDirectory = await createObserver(temp, adapterUrl, contextUrl, longTaskUrl, developmentUrl, ownershipUrl)
  const observer = await pack(observerDirectory, join(temp, 'observer-pack'), env)
  await mkdir(join(temp, 'store'), { recursive: true, mode: 0o700 })
  await run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'add', observer, '--ignore-scripts', '--store-dir', join(temp, 'store')], { cwd: root, env })
  const first = await boot(env, env.T25_ARTIFACT)
  const secondArtifact = join(artifactDir, 'second.json')
  const secondEnv = { ...env, T25_PHASE: 'second', T25_ARTIFACT: secondArtifact }
  const second = await boot(secondEnv, secondArtifact)
  assert(first.checkpoint.transcriptMessages >= 1, 'first phase did not persist the user transcript')
  assert(second.resumedFromRevision === first.checkpoint.revision, 'second phase did not load the first checkpoint revision')
  assert(second.checkpoint.transcriptMessages > first.checkpoint.transcriptMessages, 'second phase did not append a resumed user transcript')
  assert(first.result.tokens === 12 && second.result.tokens === 12, 'official runtime token accounting is incorrect')
  const result = { status: 'passed', harness: harnessVersion, first, second, recovery: 'new DSH process loaded the same ContextManager checkpoint and appended a second slice' }
  await mkdir(join(root, '.backend-team', 'artifacts'), { recursive: true })
  await writeFile(join(root, '.backend-team', 'artifacts', 't25-official-runtime-long-task-20260916.json'), JSON.stringify({
    status: result.status,
    harness: result.harness,
    scope: 'official DSH Agent lifecycle with deterministic adapter; isolated workspace; no Qwen request or business task mutation',
    first: {
      phase: first.phase,
      officialAgent: { provider: first.officialAgent.provider, model: first.officialAgent.model, maxTokens: first.officialAgent.maxTokens, disposed: first.officialAgent.disposed },
      checkpoint: first.checkpoint,
      result: first.result,
    },
    second: {
      phase: second.phase,
      officialAgent: { provider: second.officialAgent.provider, model: second.officialAgent.model, maxTokens: second.officialAgent.maxTokens, disposed: second.officialAgent.disposed },
      resumedFromRevision: second.resumedFromRevision,
      checkpoint: second.checkpoint,
      result: second.result,
    },
    recovery: result.recovery,
  }, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
