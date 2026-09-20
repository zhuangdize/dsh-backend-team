import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, relative, resolve } from 'node:path'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const nodePath = resolve(process.execPath)
const expectedNodeVersion = '24.19.0'
const harnessVersion = '0.1.0-rc.6'
const profile = 'backend-team-lifecycle'
const bundleValue = value('--bundle')
if (bundleValue === undefined) throw new Error('usage: profile-lifecycle-smoke.mjs --bundle PATH [--output PATH]')
if (process.versions.node !== expectedNodeVersion) throw new Error(`profile lifecycle smoke requires workspace Node ${expectedNodeVersion}`)

const dshBinDirectory = join(root, '.backend-team', 'runtime', 'dsh', harnessVersion, 'node_modules', '.bin')
const dshPath = await realpath(join(dshBinDirectory, 'dsh'))
const bundlePath = await realpath(resolve(bundleValue))
const artifactRoot = await mkdtemp(join(root, '.backend-team', 'artifacts', 'profile-lifecycle-t22-'))
await chmod(artifactRoot, 0o700)
const paths = {
  dshHome: join(artifactRoot, 'dsh-home'),
  store: join(artifactRoot, 'store'),
  target: join(artifactRoot, 'target-workspace'),
  upgradeSource: join(artifactRoot, 'upgrade-source'),
  npmCache: join(artifactRoot, 'npm-cache'),
  tmp: join(artifactRoot, 'tmp'),
}
for (const path of Object.values(paths)) await mkdirSafe(path)
await mkdirSafe(join(paths.target, 'specs'))
await mkdirSafe(join(paths.target, '.backend-team'))
const env = {
  ...process.env,
  DSH_HOME: paths.dshHome,
  PATH: [dshBinDirectory, dirname(nodePath), '/usr/bin', '/bin'].join(delimiter),
  NPM_CONFIG_CACHE: paths.npmCache,
  npm_config_cache: paths.npmCache,
  NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  npm_config_registry: 'https://registry.npmjs.org/',
  DSH_TELEMETRY_DISABLED: '1',
  DSH_PERMISSION_MODE: 'read-only',
  CI: '1',
  NO_COLOR: '1',
}
await writeFile(join(paths.target, 'specs', 'keep.md'), 'user workspace data\n', { mode: 0o600 })
await writeFile(join(paths.target, '.backend-team', 'state.json'), '{"preserve":true}\n', { mode: 0o600 })
const sentinels = {
  specification: await digest(join(paths.target, 'specs', 'keep.md')),
  state: await digest(join(paths.target, '.backend-team', 'state.json')),
}

const steps = []
await runDsh(['plugin', '--profile', profile, 'add', bundlePath, '--ignore-scripts', '--store-dir', paths.store], 'install')
steps.push(await inspect('install'))
steps.push(await inspect('use-diagnostic'))

const upgradeBundle = await makeUpgradeBundle()
await runDsh(['plugin', '--profile', profile, 'add', upgradeBundle, '--ignore-scripts', '--store-dir', paths.store], 'upgrade')
const upgraded = await inspect('upgrade')
if (upgraded.bundleVersion !== '0.1.1') throw new Error(`upgrade did not select Bundle 0.1.1: ${upgraded.bundleVersion ?? 'missing'}`)
steps.push(upgraded)

await runDsh(['plugin', '--profile', profile, 'remove', '@dsh-backend-team/bundle', '--store-dir', paths.store], 'rollback-remove')
const afterRollbackRemove = await inspect('rollback-remove')
if (afterRollbackRemove.bundleRowCount !== 0) throw new Error('rollback remove left a Backend Team row')
await runDsh(['plugin', '--profile', profile, 'add', bundlePath, '--ignore-scripts', '--store-dir', paths.store], 'rollback-restore')
const restored = await inspect('rollback-restore')
if (restored.bundleVersion !== '0.1.0') throw new Error(`rollback did not restore Bundle 0.1.0: ${restored.bundleVersion ?? 'missing'}`)
steps.push(afterRollbackRemove, restored)

await runDsh(['plugin', '--profile', profile, 'remove', '@dsh-backend-team/bundle', '--store-dir', paths.store], 'uninstall')
const uninstalled = await inspect('uninstall')
if (uninstalled.bundleRowCount !== 0) throw new Error('uninstall left a Backend Team row')
steps.push(uninstalled)

const preserved = {
  specification: await digest(join(paths.target, 'specs', 'keep.md')),
  state: await digest(join(paths.target, '.backend-team', 'state.json')),
}
if (JSON.stringify(sentinels) !== JSON.stringify(preserved)) throw new Error('uninstall changed project data')

const result = {
  schemaVersion: 1,
  status: 'passed',
  verifiedAt: new Date().toISOString(),
  harness: harnessVersion,
  node: process.versions.node,
  architecture: process.arch,
  profile,
  scope: 'temporary-dsh-home-and-workspace',
  steps,
  preservation: { before: sentinels, after: preserved, unchanged: true },
  limitations: [
    'upgrade uses a repacked 0.1.1 Bundle with unchanged runtime code to verify official Profile replacement and single-row identity',
    'diagnostic use is verified by dump-config; full production browser/model flow remains covered by T19/T20 gates',
    'x64 native Profile and signed release candidate remain external gates',
  ],
}
const output = value('--output') ?? join(artifactRoot, 'result.json')
await writeFile(resolve(root, output), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
await cleanup()
process.stdout.write(`${JSON.stringify({ status: result.status, artifact: relative(root, resolve(root, output)), steps: steps.map(step => step.id), preserved: result.preservation.unchanged })}\n`)

async function inspect(id) {
  const dump = await runDsh(['--profile', profile, '--dump-config'], `${id}-dump`)
  const rows = (dump.stdout.match(/^\s*- id: backend-team\s*$/gmu) ?? []).length
  const names = (dump.stdout.match(/name:\s*['"]?@dsh-backend-team\/bundle['"]?/gu) ?? []).length
  if (id !== 'rollback-remove' && id !== 'uninstall' && (rows !== 1 || names !== 1)) throw new Error(`${id} dump-config expected one Backend Team row, observed rows=${rows} names=${names}`)
  const installedPackage = join(paths.dshHome, 'profiles', profile, 'node_modules', '@dsh-backend-team', 'bundle', 'package.json')
  let bundleVersion
  try { bundleVersion = JSON.parse(await readFile(installedPackage, 'utf8')).version } catch {}
  if (id === 'rollback-remove' || id === 'uninstall') {
    if (bundleVersion !== undefined) throw new Error(`${id} left installed Bundle package ${bundleVersion}`)
  }
  return { id, bundleRowCount: rows, bundleNameCount: names, bundleVersion: bundleVersion ?? null, dumpBytes: Buffer.byteLength(dump.stdout) }
}

async function makeUpgradeBundle() {
  const packageDir = join(paths.upgradeSource, 'package')
  await exec('tar', ['-xzf', bundlePath, '-C', paths.upgradeSource])
  const packageJsonPath = join(packageDir, 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  packageJson.version = '0.1.1'
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o600 })
  const packed = await exec(join(dirname(nodePath), 'npm'), ['pack', '--json', '--ignore-scripts', '--pack-destination', artifactRoot], { cwd: packageDir, env })
  const filename = JSON.parse(packed.stdout)[0]?.filename
  if (typeof filename !== 'string' || filename !== 'dsh-backend-team-bundle-0.1.1.tgz') throw new Error('upgrade Bundle was not packed as 0.1.1')
  return join(artifactRoot, filename)
}

async function runDsh(args, id) {
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(nodePath, [dshPath, ...args], { cwd: paths.target, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []; const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', rejectResult)
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
  })
  if (result.code !== 0) throw new Error(`${id} failed (${result.code ?? result.signal}): ${result.stderr.slice(-3000)}`)
  return result
}

async function cleanup() {
  for (const path of [paths.dshHome, paths.store, paths.target, paths.upgradeSource, paths.npmCache, paths.tmp]) await rm(path, { recursive: true, force: true })
}

async function digest(path) { return createHash('sha256').update(await readFile(path)).digest('hex') }
async function mkdirSafe(path) { await (await import('node:fs/promises')).mkdir(path, { recursive: true, mode: 0o700 }) }
function value(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
