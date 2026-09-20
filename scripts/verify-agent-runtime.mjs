import { execFile, spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessVersion = '0.1.0-rc.6'
const observerName = '@dsh-backend-team/agent-runtime-observer'
const workspaceNvmRoot = resolve(root, '.backend-team/runtime/nvm/versions/node/v24.19.0')
const dshRoot = resolve(root, `.backend-team/runtime/dsh/${harnessVersion}`)
const dshBin = join(dshRoot, 'node_modules/.bin/dsh')
const localBin = join(dshRoot, 'node_modules/.bin')
const npmBin = join(dirname(process.execPath), 'npm')

function fail(message) {
  throw new Error(`Agent runtime verification failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function environment(temp) {
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
  }
}

async function run(file, args, options) {
  try {
    return await execFileAsync(file, args, { maxBuffer: 8 * 1024 * 1024, ...options })
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${file} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: error })
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

async function createObserver(temp, artifact, adapterModuleUrl) {
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
  const source = `import { writeFile } from 'node:fs/promises'\nimport { HarnessAgentRuntime } from ${JSON.stringify(adapterModuleUrl)}\nconst artifact = ${JSON.stringify(artifact)}\nconst provider = 'dsh-agent-runtime-probe'\nexport const name = ${JSON.stringify(observerName)}\nexport const inject = ['agents', 'agentLoop', 'llm']\nexport async function apply(ctx) {\n  const registration = ctx.llm.registerAdapter([provider], {\n    providerInfo: (id) => ({ id, name: 'Agent runtime probe' }),\n    resolveModel: async (id, model) => ({ provider: id, id: model, name: model }),\n    stream: () => (async function* () {\n      yield { type: 'text-delta', index: 0, text: 'probe result' }\n      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }\n      yield { type: 'finish', reason: { kind: 'stop' } }\n    })(),\n  })\n  let created\n  const runtime = new HarnessAgentRuntime({\n    context: { agents: { create: async (options) => { created = await ctx.agents.create(options); return created } } },\n    cwd: process.cwd(),\n    provider,\n    model: 'probe-model',\n    pluginId: ${JSON.stringify(observerName)},\n    decodeResult: ({ assistant, hostUsage }) => ({\n      text: assistant.content[0]?.type === 'text' ? assistant.content[0].text : undefined,\n      hostUsage,\n    }),\n  })\n  const applicationHandle = await runtime.spawn({ task: 'probe request', role: 'tester', context: {}, agentTask: { id: 'runtime-probe-task', parentTaskId: 'runtime-probe-parent', depth: 1, role: 'tester', objective: 'verify official Agent runtime', nonGoals: ['do not change files'], inputArtifacts: [], readPaths: ['packages'], writePaths: ['packages'], capabilities: { readProjectFiles: true, writeOwnedFiles: false, businessCodeWrite: false, testCodeWrite: false, configurationWrite: false, commandExecution: false, networkHosts: [], install: false, migration: false, canDelegate: false, canChangePhase: false, canApprove: false, canContactUser: false, canAnnounceCompletion: false }, budget: { maxTokens: 64, maxWallMs: 10_000, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 }, doneWhen: ['probe completes'], verification: [{ id: 'runtime-probe', kind: 'test', instruction: 'record official Agent result', required: true }], returnSchema: 'AgentResult' } })\n  if (created === undefined) throw new Error('HarnessAgentRuntime did not create an official Agent handle')\n  const before = { id: created.agent.id, status: created.agent.status, provider: created.agent.options.provider, model: created.agent.options.model, maxTokens: created.agent.options.maxTokens, hasDispose: typeof created.dispose === 'function', hasCancel: typeof created.agent.cancel === 'function', hasWhenIdle: typeof created.agent.whenIdle === 'function' }\n  const decoded = await applicationHandle.result()\n  const assistantEvent = [...created.agent.session.events].reverse().find((event) => event.type === 'assistant/message')\n  const usage = assistantEvent?.type === 'assistant/message' ? assistantEvent.data.usage : undefined\n  if (before.maxTokens !== 64 || decoded?.text !== 'probe result' || decoded.hostUsage?.tokens !== 4 || usage?.inputTokens !== 2 || usage?.outputTokens !== 2) throw new Error('HarnessAgentRuntime did not publish the expected result, budget, and usage')\n  registration()\n  await writeFile(artifact, JSON.stringify({ status: 'passed', before, result: { eventType: assistantEvent?.type, text: decoded.text, usage, hostUsage: decoded.hostUsage }, disposed: ctx.agents.get(applicationHandle.id) === undefined }))\n}\n`
  const patchedSource = source.replace(
    "    providerInfo: (id) => ({ id, name: 'Agent runtime probe' }),",
    [
      "    providerInfo: (id) => ({ id, name: 'Agent runtime probe' }),",
      '    providerRetryPolicy: () => undefined,',
    ].join(String.fromCharCode(10)),
  ).replace('  let created\n', '  let created\n  let setupBeforePublication = false\n')
    .replace('    cwd: process.cwd(),', `    setupAgent: async (agentCtx) => {
      const owner = agentCtx.agent
      if (!owner || typeof agentCtx.tools?.guard !== 'function') throw new Error('official Agent setup context is incomplete')
      setupBeforePublication = ctx.agents.get(owner.id) === undefined
      if (!setupBeforePublication) throw new Error('Agent was published before setup')
      agentCtx.tools.guard((execution) => execution.agent === owner ? 'runtime probe does not execute tools' : 'Agent identity mismatch')
    },
    cwd: process.cwd(),`)
    .replace('const before = { id:', 'const before = { setupBeforePublication, id:')
  await writeFile(join(directory, 'lib/index.js'), patchedSource, { mode: 0o600 })
  await writeFile(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: agent-runtime-observer\n      name: ${JSON.stringify(observerName)}\n`, { mode: 0o600 })
  return pack(directory, join(temp, 'observer-pack'), process.env)
}

async function waitForArtifact(path, child, output) {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      if (child.exitCode !== null) fail(`Harness exited before publishing evidence: ${output.join('')}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  }
  fail(`Harness did not publish Agent evidence within 45 seconds: ${output.join('')}`)
}

async function boot(env, artifact) {
  const child = spawn(process.execPath, [dshBin, '--profile', 'headless', 'diagnostic'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  const collect = (chunk) => output.push(chunk.toString())
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  try {
    const result = await waitForArtifact(artifact, child, output)
    assert(result.status === 'passed', `observer reported ${JSON.stringify(result)}`)
    return result
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await new Promise((resolveClose) => {
      const timer = setTimeout(resolveClose, 5_000)
      child.once('close', () => { clearTimeout(timer); resolveClose() })
    })
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

const temp = await mkdtemp(join(tmpdir(), 'dsh-agent-runtime-verify-'))
try {
  assert(resolve(process.execPath).startsWith(`${workspaceNvmRoot}${sep}`), 'Node must come from the workspace-local NVM runtime')
  assert(resolve(npmBin).startsWith(`${workspaceNvmRoot}${sep}`), 'npm must come from the workspace-local NVM runtime')
  await access(dshBin)
  const env = environment(temp)
  await mkdir(join(temp, 'npm-cache'), { recursive: true, mode: 0o700 })
  await mkdir(join(temp, 'xdg-config'), { recursive: true, mode: 0o700 })
  await mkdir(join(temp, 'xdg-cache'), { recursive: true, mode: 0o700 })
  await writeFile(join(temp, 'npmrc'), 'registry=https://registry.npmjs.org/\nignore-scripts=true\n', { mode: 0o600 })
  const artifact = join(temp, 'agent.json')
  await run(process.execPath, [npmBin, 'run', 'build', '--workspace', '@dsh-backend-team/harness-adapter'], { cwd: root, env })
  const adapterModuleUrl = pathToFileURL(resolve(root, 'packages/harness-adapter/dist/harness-agent-runtime.js')).href
  const observer = await createObserver(temp, artifact, adapterModuleUrl)
  const bundle = await pack(join(root, 'packages/bundle'), join(temp, 'bundle-pack'), env)
  await mkdir(join(temp, 'store'), { recursive: true, mode: 0o700 })
  for (const tarball of [bundle, observer]) {
    await run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'add', tarball, '--ignore-scripts', '--store-dir', join(temp, 'store')], { cwd: root, env })
  }
  const result = await boot(env, artifact)
  process.stdout.write(`${JSON.stringify({ ...result, harness: harnessVersion })}\n`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
