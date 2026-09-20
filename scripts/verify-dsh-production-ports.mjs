import { execFile, spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessVersion = '0.1.0-rc.6'
const observerName = '@dsh-backend-team/production-port-observer'
const workspaceNvmRoot = resolve(root, '.backend-team/runtime/nvm/versions/node/v24.19.0')
const dshRoot = resolve(root, `.backend-team/runtime/dsh/${harnessVersion}`)
const dshBin = join(dshRoot, 'node_modules/.bin/dsh')
const localBin = join(dshRoot, 'node_modules/.bin')
const npmBin = join(dirname(process.execPath), 'npm')

function fail(message) { throw new Error(`DSH production-port verification failed: ${message}`) }
function assert(condition, message) { if (!condition) fail(message) }
async function run(file, args, options) {
  try { return await execFileAsync(file, args, { maxBuffer: 8 * 1024 * 1024, ...options }) } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${file} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: error })
  }
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
async function pack(directory, destination, env) {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const result = await run(process.execPath, [npmBin, 'pack', '--json', '--pack-destination', destination], { cwd: directory, env })
  const filename = JSON.parse(result.stdout)[0]?.filename
  assert(typeof filename === 'string' && filename === filename.split('/').at(-1) && !filename.includes('..'), 'unsafe npm pack filename')
  return join(destination, filename)
}
async function observerPackage(temp, artifact) {
  const directory = join(temp, 'observer')
  await mkdir(join(directory, 'lib'), { recursive: true, mode: 0o700 })
  const productionUrl = pathToFileURL(resolve(root, 'packages/bundle/lib/production.js')).href
  const source = `import { writeFile } from 'node:fs/promises'\nimport { createVerifiedDshAgentPort, createVerifiedDshHostPort, createVerifiedDshSessionPort } from ${JSON.stringify(productionUrl)}\nconst artifact = ${JSON.stringify(artifact)}\nexport const name = ${JSON.stringify(observerName)}\nexport const inject = ['webServer', 'sessions', 'agents']\nexport async function apply(ctx) {\n  try {\n    const host = createVerifiedDshHostPort(ctx)\n    const session = createVerifiedDshSessionPort({ context: ctx, workspaceId: process.cwd(), workspaceRoot: process.cwd() })\n    const agent = createVerifiedDshAgentPort({ context: ctx, cwd: process.cwd(), pluginId: ${JSON.stringify(observerName)}, decodeResult: (input) => input })\n    if (host.host !== '127.0.0.1' || host.server.verifiedProvenance !== true || session.verifiedProvenance !== true || agent.verifiedProvenance !== true) throw new Error('verified DSH ports were not produced')\n    await writeFile(artifact, JSON.stringify({ status: 'passed', host: { host: host.host, port: host.port, verifiedProvenance: host.server.verifiedProvenance }, session: { verifiedProvenance: session.verifiedProvenance }, agent: { verifiedProvenance: agent.verifiedProvenance } }))\n  } catch (error) {\n    await writeFile(artifact, JSON.stringify({ status: 'failed', error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) } }))\n  }\n}\n`
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: observerName, version: '0.0.0-diagnostic.1', private: true, type: 'module', main: 'lib/index.js', files: ['lib', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(directory, 'lib/index.js'), source, { mode: 0o600 })
  await writeFile(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: production-port-observer\n      name: ${JSON.stringify(observerName)}\n`, { mode: 0o600 })
  return pack(directory, join(temp, 'observer-pack'), process.env)
}
async function waitForArtifact(path, child, output) {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch {
      if (child.exitCode !== null) fail(`Harness exited before evidence: ${output.join('')}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  }
  fail(`Harness did not publish evidence: ${output.join('')}`)
}
const temp = await mkdtemp(join(tmpdir(), 'dsh-production-ports-verify-'))
try {
  assert(resolve(process.execPath).startsWith(`${workspaceNvmRoot}${sep}`), 'Node must come from workspace-local NVM')
  assert(resolve(npmBin).startsWith(`${workspaceNvmRoot}${sep}`), 'npm must come from workspace-local NVM')
  await access(dshBin)
  await mkdir(join(temp, 'npm-cache'), { recursive: true, mode: 0o700 })
  await mkdir(join(temp, 'xdg-config'), { recursive: true, mode: 0o700 })
  await mkdir(join(temp, 'xdg-cache'), { recursive: true, mode: 0o700 })
  await writeFile(join(temp, 'npmrc'), 'registry=https://registry.npmjs.org/\nignore-scripts=true\n', { mode: 0o600 })
  const env = environment(temp)
  const artifact = join(temp, 'ports.json')
  const observer = await observerPackage(temp, artifact)
  await mkdir(join(temp, 'store'), { recursive: true, mode: 0o700 })
  await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', observer, '--ignore-scripts', '--store-dir', join(temp, 'store')], { cwd: root, env })
  const child = spawn(process.execPath, [dshBin, 'web', '--host', '127.0.0.1', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))
  try {
    const result = await waitForArtifact(artifact, child, output)
    assert(result.status === 'passed', JSON.stringify(result))
    assert(result.host?.host === '127.0.0.1' && result.host?.verifiedProvenance === true, 'Host port evidence is incomplete')
    assert(result.session?.verifiedProvenance === true && result.agent?.verifiedProvenance === true, 'Session/Agent port evidence is incomplete')
    process.stdout.write(`${JSON.stringify({ ...result, harness: harnessVersion })}\n`)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await new Promise((resolveClose) => { const timer = setTimeout(resolveClose, 5_000); child.once('close', () => { clearTimeout(timer); resolveClose() }) })
    if (child.exitCode === null) child.kill('SIGKILL')
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
