import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeBin = dirname(process.execPath)
const npmBin = join(nodeBin, 'npm')
const expectedNodeVersion = '24.19.0'
const expectedHarnessVersion = '0.1.0-rc.6'
const expectedPnpmVersion = '11.7.0'
const expectedNpmVersion = '11.17.0'
const rc6Cutoff = '2026-08-14T00:00:00.000Z'
const privateRegistryPattern = /192\.168\.62\.203|http:\/\//iu
const bearerPattern = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/giu
const sensitiveValuePattern = /["']?(?:api[_-]?key|access[_-]?token|password|secret|credential|authorization|token)["']?\s*(?::|=)\s*(?!(?:"<[^>]+>"|'<[^>]+>'|<[^>]+>))(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/iu
const packageNamePattern = /^@deepseek-ai\/dsh(?:$|-)/u

const MAX_FAILURE_REASON_BYTES = 4_096

export class SmokeBlockedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SmokeBlockedError'
  }
}

export class SmokeVerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SmokeVerificationError'
  }
}

function assert(condition, message) {
  if (!condition) throw new SmokeVerificationError(message)
}

function safeBasename(value) {
  return typeof value === 'string' && value.length > 0 && value === value.split(/[\\/]/u).at(-1) && !value.includes('..')
}

function within(parent, child) {
  const parentPath = resolve(parent)
  const childPath = resolve(child)
  return childPath === parentPath || childPath.startsWith(`${parentPath}${sep}`)
}

async function assertOwnPath(path, label, { directory = false } = {}) {
  assert(isAbsolute(path), `${label} must be absolute`)
  const resolvedPath = resolve(await realpath(path))
  const stat = await lstat(resolvedPath)
  assert(directory ? stat.isDirectory() : stat.isFile(), `${label} has an unexpected type`)
  assert(within(root, resolvedPath), `${label} resolves outside the workspace`)
  return resolvedPath
}

function redact(value, replacements) {
  let text = String(value)
  for (const [needle, replacement] of replacements) text = text.split(needle).join(replacement)
  text = text.replace(/^.*(?:api[_-]?key|access[_-]?token|password|secret|credential|authorization|token)\s*[:=].*$/gimu, '<secret-line-redacted>')
  return text.replace(bearerPattern, '<authorization-redacted>').replace(privateRegistryPattern, '<private-registry-redacted>')
}

function assertRedactedText(text, label, forbiddenPaths) {
  assert(!forbiddenPaths.some((path) => path.length > 0 && text.includes(path)), `${label} contains an absolute workspace or home path`)
  assert(!privateRegistryPattern.test(text), `${label} contains a private or insecure registry`)
  bearerPattern.lastIndex = 0
  assert(!bearerPattern.test(text), `${label} contains an authorization value`)
  assert(!sensitiveValuePattern.test(text), `${label} contains a sensitive assignment value`)
}

function redactionTable(paths) {
  return paths
    .filter((path) => typeof path === 'string' && path.length > 0)
    .sort((left, right) => right.length - left.length)
    .map((path, index) => [path, `<workspace-path-${index + 1}>`])
}

function failureStatus(error) {
  return error instanceof SmokeBlockedError ? 'blocked' : 'failed'
}

function truncateUtf8(value, maxBytes) {
  const input = Buffer.from(String(value), 'utf8')
  if (input.length <= maxBytes) return input.toString('utf8')
  for (let end = maxBytes; end >= 0; end -= 1) {
    const candidate = input.subarray(0, end).toString('utf8')
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) return candidate
  }
  return ''
}

export async function writeFailureArtifact(artifactRoot, error, category = 'verification') {
  const toolResultPath = join(artifactRoot, 'tool-result.json')
  const resultPath = join(artifactRoot, 'result.json')
  await rm(toolResultPath, { force: true })
  await rm(resultPath, { force: true })
  const replacements = redactionTable([root, artifactRoot, process.env.HOME ?? ''])
  const rawReason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const reason = truncateUtf8(redact(rawReason, replacements), MAX_FAILURE_REASON_BYTES)
  await writeAtomic(resultPath, { status: failureStatus(error), category, reason })
}

export function assertNvmProvenance(nodeVersion, nodeTarget, configuredNodeRoot) {
  assert(nodeVersion === expectedNodeVersion, `Node version must be ${expectedNodeVersion}`)
  assert(typeof nodeTarget === 'string' && typeof configuredNodeRoot === 'string' && isAbsolute(nodeTarget) && isAbsolute(configuredNodeRoot), 'NVM Node path and root must be absolute')
  assert(resolve(nodeTarget) === resolve(join(configuredNodeRoot, 'bin', 'node')), 'NVM Node path is not the configured workspace NVM bin/node')
}

export function assertPublicPackageLock(lockText) {
  let lock
  try {
    lock = JSON.parse(lockText)
  } catch {
    throw new SmokeVerificationError('runtime package-lock is not valid JSON')
  }
  const packages = lock?.packages
  assert(packages && typeof packages === 'object' && !Array.isArray(packages), 'runtime package-lock has no packages map')
  for (const [location, entry] of Object.entries(packages)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('resolved' in entry)) continue
    const resolved = entry.resolved
    assert(typeof resolved === 'string', `runtime package-lock resolved value is invalid for ${location}`)
    let parsed
    try {
      parsed = new URL(resolved)
    } catch {
      throw new SmokeVerificationError(`runtime package-lock resolved URL is invalid for ${location}`)
    }
    assert(parsed.username === '' && parsed.password === '', `runtime package-lock resolved URL contains credentials for ${location}`)
    assert(parsed.protocol === 'https:' && parsed.host === 'registry.npmjs.org', `runtime package-lock resolved URL is not the public npm registry for ${location}`)
  }
}

export function parseAuditSummary(audit) {
  assert(audit && (audit.code === 0 || audit.code === 1), 'npm audit exited unexpectedly')
  assert(!audit.timedOut && !audit.stdoutTruncated && !audit.stderrTruncated, 'npm audit output was timed out or truncated')
  let auditJson
  try {
    auditJson = JSON.parse(audit.stdout)
  } catch {
    throw new SmokeVerificationError('npm audit returned malformed JSON')
  }
  const vulnerabilities = auditJson?.metadata?.vulnerabilities
  assert(vulnerabilities && typeof vulnerabilities === 'object', 'npm audit JSON has no vulnerability metadata')
  for (const key of ['total', 'high', 'critical']) assert(Number.isInteger(vulnerabilities[key]) && vulnerabilities[key] >= 0, `npm audit vulnerability metadata is invalid: ${key}`)
  return { exitCode: audit.code, total: vulnerabilities.total, high: vulnerabilities.high, critical: vulnerabilities.critical }
}

async function hashFile(path) {
  const content = await readFile(path)
  return createHash('sha256').update(content).digest('hex')
}

async function writeAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

function commandEnvironment(paths) {
  const env = {
    PATH: `${nodeBin}${delimiter}${paths.localBin}${delimiter}/usr/bin${delimiter}/bin`,
    TMPDIR: paths.tmp,
    DSH_HOME: paths.dshHome,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_CACHE_HOME: paths.xdgCache,
    NPM_CONFIG_CACHE: paths.npmCache,
    npm_config_cache: paths.npmCache,
    NPM_CONFIG_USERCONFIG: paths.npmrc,
    npm_config_userconfig: paths.npmrc,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    npm_config_registry: 'https://registry.npmjs.org/',
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_DISABLED: '1',
    CI: '1',
    NO_COLOR: '1',
    npm_config_ignore_scripts: 'true',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  }
  return env
}

export async function capture(file, args, options, { timeoutMs = 60_000, maxOutputBytes = 1_048_576, signal, onReapTimeout = () => {} } = {}) {
  assert(signal instanceof AbortSignal, 'every subprocess must receive an explicit AbortSignal')
  const started = Date.now()
  const result = await new Promise((resolveResult) => {
    const child = spawn(file, args, { ...options, signal, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    let terminating = false
    let timer
    let forceKillTimer
    let reapTimer
    let aborted = false
    let spawnError
    let reapTimedOut = false
    const append = (target, chunk, currentBytes) => {
      const input = Buffer.from(chunk)
      const remaining = Math.max(0, maxOutputBytes - currentBytes)
      if (remaining > 0) target.push(input.subarray(0, remaining))
      return currentBytes + input.length
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      if (reapTimer !== undefined) clearTimeout(reapTimer)
      signal.removeEventListener('abort', onAbort)
      resolveResult(value)
    }
    const terminate = () => {
      if (child.exitCode !== null || terminating) return
      terminating = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        if (settled) return
        reapTimer = setTimeout(() => {
          reapTimedOut = true
          try {
            markActiveRunUnreaped()
            onReapTimeout()
          } catch (error) {
            spawnError = String(error)
          } finally {
            detachUnreapedChild(child)
            finish(makeResult(child.exitCode, child.signalCode))
          }
        }, 5_000)
      }, 5_000)
    }
    const onAbort = () => {
      aborted = true
      terminate()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    const makeResult = (code, signalValue) => ({
      code,
      signal: signalValue,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      durationMs: Date.now() - started,
      timedOut,
      aborted,
      error: spawnError,
      reapTimedOut,
      stdoutTruncated: stdoutBytes > maxOutputBytes,
      stderrTruncated: stderrBytes > maxOutputBytes,
    })
    timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdoutBytes = append(stdout, chunk, stdoutBytes) })
    child.stderr.on('data', (chunk) => { stderrBytes = append(stderr, chunk, stderrBytes) })
    child.on('error', (error) => { spawnError = String(error) })
    child.on('close', (code, signal) => {
      finish(makeResult(code, signal))
    })
  })
  return result
}

export function validateChildResult(result, label) {
  assert(result?.timedOut !== true, `${label} timed out`)
  assert(result?.aborted !== true, `${label} was aborted`)
  assert(result?.error === undefined, `${label} emitted a child error`)
  assert(result?.reapTimedOut !== true, `${label} close could not be confirmed`)
}

export function shouldCleanupAfterChild(result) {
  return result?.reapTimedOut !== true
}

export function shouldMutateFailureArtifact(paths) {
  return paths?.cleanupSafe !== false
}

export function markChildUnreaped(state) {
  state.cleanupSafe = false
  return state
}

export function detachUnreapedChild(child) {
  child?.stdout?.destroy?.()
  child?.stderr?.destroy?.()
  child?.unref?.()
  return child
}

function markActiveRunUnreaped() {
  if (activePaths !== undefined) markChildUnreaped(activePaths)
}

export async function writeBootLogsIfReaped(closeResult, stdout, stderr, redactions, logPaths) {
  if (!shouldCleanupAfterChild(closeResult)) return false
  await writeFile(logPaths.stdout, redact(Buffer.concat(stdout), redactions), { mode: 0o600, flag: 'wx' })
  await writeFile(logPaths.stderr, redact(Buffer.concat(stderr), redactions), { mode: 0o600, flag: 'wx' })
  return true
}

async function assertNvmRuntime() {
  const nodePath = resolve(await realpath(process.execPath))
  let configuredNodeRoot
  try {
    configuredNodeRoot = resolve(await realpath(join(root, '.backend-team', 'runtime', 'nvm', 'versions', 'node', `v${expectedNodeVersion}`)))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') throw new SmokeBlockedError('workspace-local NVM Node 24.19.0 is unavailable')
    throw error
  }
  assertNvmProvenance(process.versions.node, nodePath, configuredNodeRoot)
  await assertOwnPath(nodePath, 'NVM Node')
  await assertOwnPath(npmBin, 'NVM npm')
  const nodeTarget = resolve(await realpath(process.execPath))
  const npmTarget = await realpath(npmBin)
  assert(within(configuredNodeRoot, npmTarget), 'NVM npm path is outside the configured workspace NVM root')
  await assertOwnPath(nodeTarget, 'NVM Node target')
  await assertOwnPath(npmTarget, 'NVM npm target')
  const probeController = new AbortController()
  const npmProbe = await capture(nodeTarget, [npmTarget, '--version'], {
    cwd: root,
    env: { PATH: nodeBin, NPM_CONFIG_USERCONFIG: join(root, '.backend-team', 'runtime', 'empty-npmrc') },
  }, { signal: probeController.signal })
  validateChildResult(npmProbe, 'NVM npm probe')
  assert(npmProbe.code === 0, `NVM npm probe failed: ${npmProbe.stderr}`)
  assert(npmProbe.stdout.trim() === expectedNpmVersion, `unexpected NVM npm version: ${npmProbe.stdout.trim()}`)
  return { node: process.versions.node, npm: npmProbe.stdout.trim(), nodeTarget, npmTarget }
}

async function walkPackageManifests(directory, output = []) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const current = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || current.endsWith(`${sep}node_modules`)) await walkPackageManifests(current, output)
      else await walkPackageManifests(current, output)
    } else if (entry.isFile() && entry.name === 'package.json') {
      try {
        const manifest = JSON.parse(await readFile(current, 'utf8'))
        if (typeof manifest.name === 'string' && packageNamePattern.test(manifest.name)) output.push({ path: current, manifest })
      } catch {
        // Ignore non-package JSON files; package manifests are validated below.
      }
    }
  }
  return output
}

export async function assertPinnedDshAvailable(dshPath) {
  try {
    await access(dshPath)
    return resolve(await assertOwnPath(await realpath(dshPath), 'workspace-local dsh'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') throw new SmokeBlockedError('pinned workspace-local DSH executable is unavailable')
    throw error
  }
}

async function ensureRc6Runtime(runtimeDir, paths) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  const packagePath = join(runtimeDir, 'package.json')
  try {
    await access(packagePath)
  } catch {
    await writeFile(packagePath, `${JSON.stringify({
      name: 'dsh-backend-team-rc6-runtime',
      private: true,
      type: 'module',
      dependencies: { '@deepseek-ai/dsh': expectedHarnessVersion, pnpm: expectedPnpmVersion },
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  }
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  assert(manifest.dependencies?.['@deepseek-ai/dsh'] === expectedHarnessVersion, 'runtime DSH dependency is not exact rc.6')
  assert(manifest.dependencies?.pnpm === expectedPnpmVersion, 'runtime pnpm dependency is not exact 11.7.0')
  const dshManifestPath = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  let installed = false
  try {
    const current = JSON.parse(await readFile(dshManifestPath, 'utf8'))
    installed = current.version === expectedHarnessVersion
  } catch {
    installed = false
  }
  if (!installed) {
    const npmResult = await capture(paths.nodeTarget, [paths.npmTarget,
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
      `--before=${rc6Cutoff}`, '--registry=https://registry.npmjs.org/',
      `--cache=${paths.npmCache}`,
    ], { cwd: runtimeDir, env: paths.env }, { timeoutMs: 300_000, maxOutputBytes: 4_194_304, signal: paths.signal })
    validateChildResult(npmResult, 'rc.6 install')
    assert(npmResult.code === 0, `rc.6 install failed: ${redact(npmResult.stderr, paths.redactions)}`)
  }
  const lockPath = join(runtimeDir, 'package-lock.json')
  const lockText = await readFile(lockPath, 'utf8')
  assertPublicPackageLock(lockText)
  const restore = await capture(paths.nodeTarget, [paths.npmTarget, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', paths.npmCache], { cwd: runtimeDir, env: paths.env }, { timeoutMs: 300_000, maxOutputBytes: 4_194_304, signal: paths.signal })
  validateChildResult(restore, 'rc.6 npm ci')
  assert(restore.code === 0, `rc.6 npm ci restore failed: ${redact(restore.stderr, paths.redactions)}`)
  const tree = await capture(paths.nodeTarget, [paths.npmTarget, 'ls', '--all', '--json'], { cwd: runtimeDir, env: paths.env }, { timeoutMs: 60_000, maxOutputBytes: 4_194_304, signal: paths.signal })
  validateChildResult(tree, 'rc.6 npm ls')
  assert(tree.code === 0, `rc.6 npm ls failed: ${redact(tree.stderr, paths.redactions)}`)
  const manifests = await walkPackageManifests(join(runtimeDir, 'node_modules'))
  assert(manifests.length > 0, 'rc.6 runtime has no DeepSeek Harness packages')
  const mismatched = manifests.filter(({ manifest: item }) => item.version !== expectedHarnessVersion)
  assert(mismatched.length === 0, `rc.6 runtime contains non-rc.6 DSH packages: ${mismatched.map(({ manifest: item }) => `${item.name}@${item.version}`).join(', ')}`)
  const dshPath = join(runtimeDir, 'node_modules', '.bin', 'dsh')
  const pnpmPath = join(runtimeDir, 'node_modules', '.bin', 'pnpm')
  const dshTarget = await assertPinnedDshAvailable(dshPath)
  await assertOwnPath(await realpath(pnpmPath), 'workspace-local pnpm')
  const pnpmVersion = await capture(paths.nodeTarget, [await realpath(pnpmPath), '--version'], { cwd: runtimeDir, env: paths.env, }, { signal: paths.signal })
  validateChildResult(pnpmVersion, 'workspace-local pnpm')
  assert(pnpmVersion.code === 0 && pnpmVersion.stdout.trim() === expectedPnpmVersion, `unexpected workspace pnpm version: ${pnpmVersion.stdout.trim()}`)
  const dshVersion = await capture(paths.nodeTarget, [dshTarget, '--version'], { cwd: runtimeDir, env: paths.env }, { signal: paths.signal })
  validateChildResult(dshVersion, 'workspace-local dsh')
  assert(dshVersion.code === 0 && dshVersion.stdout.trim() === expectedHarnessVersion, `unexpected workspace dsh version: ${dshVersion.stdout.trim()}`)
  const audit = await capture(paths.nodeTarget, [paths.npmTarget, 'audit', '--json', '--ignore-scripts', '--cache', paths.npmCache], { cwd: runtimeDir, env: paths.env }, { timeoutMs: 120_000, maxOutputBytes: 4_194_304, signal: paths.signal })
  validateChildResult(audit, 'npm audit')
  const auditSummary = parseAuditSummary(audit)
  return { dshTarget, dshVersion: dshVersion.stdout.trim(), pnpmVersion: pnpmVersion.stdout.trim(), packageCount: manifests.length, npmRestoreExitCode: restore.code, npmLsExitCode: tree.code, audit: auditSummary }
}

async function packWorkspacePackage(packageDir, destination, env, nodePath, npmPath, signal) {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const result = await capture(nodePath, [npmPath, 'pack', '--json', '--pack-destination', destination], { cwd: packageDir, env }, { signal })
  validateChildResult(result, 'npm pack')
  assert(result.code === 0, `npm pack failed: ${result.stderr}`)
  const records = JSON.parse(result.stdout)
  assert(Array.isArray(records) && records.length === 1, 'npm pack did not return exactly one result')
  const filename = records[0]?.filename
  assert(safeBasename(filename), 'npm pack returned an unsafe filename')
  const tarball = join(destination, filename)
  await assertOwnPath(tarball, 'packed package')
  return { tarball, sha256: await hashFile(tarball), exitCode: result.code, durationMs: result.durationMs }
}

async function createObserverPackage(observerDir, artifactPath, env, nodePath, npmPath, signal) {
  const packageName = '@dsh-backend-team/rc6-smoke-observer'
  await mkdir(join(observerDir, 'lib'), { recursive: true, mode: 0o700 })
  const packageJson = {
    name: packageName,
    version: '0.0.0-smoke.1',
    private: true,
    type: 'module',
    main: 'lib/index.js',
    files: ['lib', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  const observerSource = `import { writeFile, rename } from 'node:fs/promises'\nimport { resolve } from 'node:path'\n\nconst artifact = resolve(process.env.DSH_SMOKE_RESULT ?? '')\nconst sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))\nconst publish = async (value) => {\n  const temporary = artifact + '.tmp-' + process.pid\n  await writeFile(temporary, JSON.stringify(value) + '\\n', { mode: 0o600, flag: 'wx' })\n  await rename(temporary, artifact)\n}\nconst safeError = (error) => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error) })\n\nexport const name = ${JSON.stringify(packageName)}\nexport const inject = ['tools']\nexport async function apply(ctx) {\n  try {\n    let definition\n    for (let attempt = 0; attempt < 100 && definition === undefined; attempt += 1) {\n      definition = ctx.tools?.get?.('backend_team_status')\n      if (definition === undefined) await sleep(25)\n    }\n    if (definition === undefined) throw new Error('backend_team_status was not visible through ctx.tools.get')\n    const controller = new AbortController()\n    const result = await ctx.tools.execute({ callId: 'stage01-smoke-call', name: 'backend_team_status', arguments: {}, signal: controller.signal })\n    await publish({ status: 'passed', toolName: definition.name, result })\n  } catch (error) {\n    await publish({ status: 'failed', error: safeError(error) })\n  }\n}\n`
  await writeFile(join(observerDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await writeFile(join(observerDir, 'lib', 'index.js'), observerSource, { mode: 0o600, flag: 'wx' })
  await writeFile(join(observerDir, 'cordis.patch.yml'), `- insert:\n    - id: stage01-smoke-observer\n      name: ${JSON.stringify(packageName)}\n`, { mode: 0o600, flag: 'wx' })
  const packed = await packWorkspacePackage(observerDir, join(observerDir, 'pack'), env, nodePath, npmPath, signal)
  return { ...packed, packageName }
}

async function bootAndObserve(dshTarget, paths, resultPath, logPaths) {
  paths.cleanupSafe = false
  const child = spawn(paths.nodeTarget, [dshTarget, '--profile', 'backend-team-test'], {
    cwd: paths.targetWorkspace,
    env: { ...paths.env, DSH_SMOKE_RESULT: resultPath },
    signal: paths.signal,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  const maxOutputBytes = 1_048_576
  let stdoutBytes = 0
  let stderrBytes = 0
  let outputOverflow = false
  const append = (target, chunk, currentBytes) => {
    const input = Buffer.from(chunk)
    const remaining = Math.max(0, maxOutputBytes - currentBytes)
    if (remaining > 0) target.push(input.subarray(0, remaining))
    if (currentBytes + input.length > maxOutputBytes) {
      outputOverflow = true
      if (child.exitCode === null) child.kill('SIGTERM')
    }
    return currentBytes + input.length
  }
  const closed = new Promise((resolveClosed) => {
    let spawnError
    child.once('close', (code, signal) => resolveClosed({ code, signal, error: spawnError }))
    child.once('error', (error) => { spawnError = String(error) })
  })
  child.stdout.on('data', (chunk) => { stdoutBytes = append(stdout, chunk, stdoutBytes) })
  child.stderr.on('data', (chunk) => { stderrBytes = append(stderr, chunk, stderrBytes) })
  const started = Date.now()
  let timedOut = false
  const abortHandler = () => {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  paths.signal.addEventListener('abort', abortHandler, { once: true })
  while (Date.now() - started < 45_000) {
    try {
      await access(resultPath)
      break
    } catch {
      if (child.exitCode !== null) break
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
    }
  }
  try {
    await access(resultPath)
  } catch {
    timedOut = true
  }
  if (child.exitCode === null) child.kill('SIGTERM')
  let killTimer
  const deadline = new Promise((resolveTimeout) => {
    killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
      resolveTimeout(undefined)
    }, 5_000)
  })
  let closeResult = await Promise.race([closed, deadline])
  if (closeResult === undefined) {
    closeResult = await Promise.race([
      closed,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ code: child.exitCode, signal: child.signalCode, error: 'child close event timed out', reapTimedOut: true }), 5_000)),
    ])
  }
  if (!shouldCleanupAfterChild(closeResult)) detachUnreapedChild(child)
  if (killTimer !== undefined) clearTimeout(killTimer)
  paths.signal.removeEventListener('abort', abortHandler)
  if (shouldCleanupAfterChild(closeResult)) paths.cleanupSafe = true
  const logsWritten = await writeBootLogsIfReaped(closeResult, stdout, stderr, paths.redactions, logPaths)
  return { timedOut, outputOverflow, stdoutTruncated: stdoutBytes > maxOutputBytes, stderrTruncated: stderrBytes > maxOutputBytes, logsWritten, ...closeResult }
}

async function cleanupEphemeral(paths) {
  assert(paths.cleanupSafe !== false, 'child close was not confirmed; artifact/profile is quarantined')
  const disposable = [
    paths.dshHome,
    paths.targetWorkspace,
    paths.xdgConfig,
    paths.xdgCache,
    paths.npmCache,
    paths.pnpmStore,
    paths.tmp,
    join(paths.artifactRoot, 'bundle-pack'),
    join(paths.artifactRoot, 'observer'),
    paths.npmrc,
  ]
  for (const path of disposable) {
    assert(within(paths.artifactRoot, path), 'cleanup target escaped the smoke artifact root')
    await rm(path, { recursive: true, force: true })
  }
}

async function scanRetainedArtifacts(artifactRoot) {
  const retained = [
    'dump-config.redacted.txt',
    'boot.stdout.redacted.log',
    'boot.stderr.redacted.log',
    'tool-result.json',
  ]
  for (const name of retained) {
    const content = await readFile(join(artifactRoot, name), 'utf8')
    assertRedactedText(content, name, [root, artifactRoot, process.env.HOME ?? ''])
  }
  const compatibilityFiles = ['docs/compatibility/deepseek-harness.json', 'docs/compatibility/0.1.0-rc.6-foundation.md']
  for (const name of compatibilityFiles) {
    const content = await readFile(join(root, name), 'utf8')
    assertRedactedText(content, name, [root, process.env.HOME ?? ''])
  }
  const evidencePath = join(root, 'docs/compatibility/0.1.0-rc.6-foundation.md')
  const matrix = JSON.parse(await readFile(join(root, 'docs/compatibility/deepseek-harness.json'), 'utf8'))
  assert(matrix.entries?.[0]?.status === 'verified', 'compatibility matrix is not promoted to verified')
  assert(matrix.entries[0]?.evidence?.sha256 === await hashFile(evidencePath), 'compatibility evidence hash does not match the committed document')
}

let activeArtifactRoot
let activePaths
async function main() {
  const versions = await assertNvmRuntime()
  await mkdir(join(root, '.backend-team', 'artifacts'), { recursive: true, mode: 0o700 })
  const artifactRoot = await mkdtemp(join(root, '.backend-team', 'artifacts', 'stage01-rc6-smoke-'))
  await chmod(artifactRoot, 0o700)
  activeArtifactRoot = artifactRoot
  const paths = {
    artifactRoot,
    dshHome: join(artifactRoot, 'dsh-home'),
    targetWorkspace: join(artifactRoot, 'target-workspace'),
    xdgConfig: join(artifactRoot, 'xdg-config'),
    xdgCache: join(artifactRoot, 'xdg-cache'),
    npmCache: join(artifactRoot, 'npm-cache'),
    pnpmStore: join(artifactRoot, 'pnpm-store'),
    tmp: join(artifactRoot, 'tmp'),
    npmrc: join(artifactRoot, 'npmrc'),
    cleanupSafe: true,
  }
  const runController = new AbortController()
  paths.signal = runController.signal
  activePaths = paths
  paths.nodeTarget = versions.nodeTarget
  paths.npmTarget = versions.npmTarget
  paths.localBin = join(root, '.backend-team', 'runtime', 'dsh', expectedHarnessVersion, 'node_modules', '.bin')
  for (const path of [paths.dshHome, paths.targetWorkspace, paths.xdgConfig, paths.xdgCache, paths.npmCache, paths.pnpmStore, paths.tmp]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  await writeFile(paths.npmrc, 'registry=https://registry.npmjs.org/\nignore-scripts=true\n', { mode: 0o600, flag: 'wx' })
  paths.redactions = redactionTable([root, artifactRoot, paths.dshHome, paths.targetWorkspace, paths.npmCache, paths.pnpmStore])
  paths.env = commandEnvironment(paths)
  const runtime = await ensureRc6Runtime(join(root, '.backend-team', 'runtime', 'dsh', expectedHarnessVersion), paths)
  const bundle = await packWorkspacePackage(join(root, 'packages', 'bundle'), join(artifactRoot, 'bundle-pack'), paths.env, paths.nodeTarget, paths.npmTarget, paths.signal)
  const observer = await createObserverPackage(join(artifactRoot, 'observer'), join(artifactRoot, 'observer-pack'), paths.env, paths.nodeTarget, paths.npmTarget, paths.signal)
  const dshEnv = paths.env
  const bundleInstall = await capture(paths.nodeTarget, [runtime.dshTarget, 'plugin', '--profile', 'backend-team-test', 'add', bundle.tarball, '--ignore-scripts', '--store-dir', paths.pnpmStore], { cwd: root, env: dshEnv }, { signal: paths.signal })
  validateChildResult(bundleInstall, 'Bundle install')
  assert(bundleInstall.code === 0, `Bundle install failed: ${redact(bundleInstall.stderr, paths.redactions)}`)
  const observerInstall = await capture(paths.nodeTarget, [runtime.dshTarget, 'plugin', '--profile', 'backend-team-test', 'add', observer.tarball, '--ignore-scripts', '--store-dir', paths.pnpmStore], { cwd: root, env: dshEnv }, { signal: paths.signal })
  validateChildResult(observerInstall, 'observer install')
  assert(observerInstall.code === 0, `observer install failed: ${redact(observerInstall.stderr, paths.redactions)}`)
  const dump = await capture(paths.nodeTarget, [runtime.dshTarget, '--profile', 'backend-team-test', '--dump-config'], { cwd: root, env: dshEnv }, { signal: paths.signal })
  validateChildResult(dump, 'dump-config')
  assert(dump.code === 0, `dump-config failed: ${redact(dump.stderr, paths.redactions)}`)
  const dumpText = redact(dump.stdout, paths.redactions)
  assert((dumpText.match(/^\s*- id: backend-team\s*$/gmu) ?? []).length === 1, 'dump-config must contain exactly one backend-team root row')
  assert((dumpText.match(/name:\s*['"]?@dsh-backend-team\/bundle['"]?/gu) ?? []).length === 1, 'dump-config must contain exactly one Bundle name')
  await writeFile(join(artifactRoot, 'dump-config.redacted.txt'), dumpText, { mode: 0o600, flag: 'wx' })
  const resultPath = join(artifactRoot, 'tool-result.json')
  const boot = await bootAndObserve(runtime.dshTarget, paths, resultPath, {
    stdout: join(artifactRoot, 'boot.stdout.redacted.log'),
    stderr: join(artifactRoot, 'boot.stderr.redacted.log'),
  })
  validateChildResult(boot, 'real DSH boot')
  const toolResultRaw = await readFile(resultPath, 'utf8')
  const toolResultSafe = redact(toolResultRaw, paths.redactions)
  await writeFile(resultPath, toolResultSafe, { mode: 0o600, flag: 'w' })
  assert(boot.reapTimedOut !== true && boot.error === undefined, 'real DSH child did not close cleanly')
  assert(!boot.outputOverflow, 'real DSH boot output exceeded the bounded capture limit')
  const result = JSON.parse(toolResultSafe)
  assert(result.status === 'passed', `real backend_team_status invocation failed: ${JSON.stringify(result)}`)
  assert(result.toolName === 'backend_team_status', 'real observer saw an unexpected tool')
  const evidence = {
    status: 'passed',
    verifiedAt: new Date().toISOString(),
    node: versions.node,
    npm: versions.npm,
    dsh: runtime.dshVersion,
    pnpm: runtime.pnpmVersion,
    dshPackageCount: runtime.packageCount,
    runtimeChecks: {
      npmCiExitCode: runtime.npmRestoreExitCode,
      npmLsExitCode: runtime.npmLsExitCode,
      audit: runtime.audit,
    },
    rc6Cutoff,
    bundleSha256: bundle.sha256,
    observerSha256: observer.sha256,
    profile: 'backend-team-test',
    dumpConfig: 'dump-config.redacted.txt',
    bootStdout: 'boot.stdout.redacted.log',
    bootStderr: 'boot.stderr.redacted.log',
    toolResult: 'tool-result.json',
    commands: {
      bundlePackExitCode: bundle.exitCode,
      observerPackExitCode: observer.exitCode,
      bundleInstallExitCode: bundleInstall.code,
      observerInstallExitCode: observerInstall.code,
      dumpConfigExitCode: dump.code,
      bootExitCode: boot.code,
      toolExecutionStatus: result.status,
    },
    boot,
    result,
  }
  assertRedactedText(JSON.stringify(evidence), 'result.json', [root, artifactRoot, process.env.HOME ?? ''])
  await scanRetainedArtifacts(artifactRoot)
  await cleanupEphemeral(paths)
  await writeAtomic(join(artifactRoot, 'result.json'), evidence)
  process.stdout.write(`${JSON.stringify({ status: evidence.status, artifact: '<workspace-artifact>/result.json', bundleSha256: bundle.sha256, dsh: runtime.dshVersion, pnpm: runtime.pnpmVersion })}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main()
  } catch (error) {
    const classifiedError = error
    let cleanupError
    const canMutateFailureArtifact = shouldMutateFailureArtifact(activePaths)
    const quarantined = !canMutateFailureArtifact
    if (activeArtifactRoot !== undefined && canMutateFailureArtifact) {
      try {
        await rm(join(activeArtifactRoot, 'tool-result.json'), { force: true })
        if (activePaths !== undefined) await cleanupEphemeral(activePaths)
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure
      }
      try {
        const failureCategory = cleanupError === undefined
          ? (classifiedError instanceof SmokeBlockedError ? 'prerequisite' : 'verification')
          : 'cleanup'
        await writeFailureArtifact(activeArtifactRoot, cleanupError ?? classifiedError, failureCategory)
      } catch (writeFailure) {
        const replacements = redactionTable([root, activeArtifactRoot, process.env.HOME ?? ''])
        const fallbackReason = truncateUtf8(redact(`failure artifact write failed: ${String(writeFailure)}`, replacements), MAX_FAILURE_REASON_BYTES)
        await rm(join(activeArtifactRoot, 'tool-result.json'), { force: true }).catch(() => {})
        await writeFile(join(activeArtifactRoot, 'result.json'), `${JSON.stringify({ status: 'failed', category: 'security', reason: fallbackReason })}\n`, { mode: 0o600 }).catch(() => {})
      }
    }
    const replacements = redactionTable([root, activeArtifactRoot ?? '', process.env.HOME ?? ''])
    const reason = truncateUtf8(redact(String(classifiedError), replacements), MAX_FAILURE_REASON_BYTES)
    const status = quarantined ? 'failed' : failureStatus(classifiedError)
    process.stderr.write(`${JSON.stringify({ status, reason })}\n`)
    process.exitCode = status === 'blocked' ? 2 : 1
  }
}
