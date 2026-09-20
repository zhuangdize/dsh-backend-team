import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessVersion = '0.1.0-rc.6'
const bundleName = '@dsh-backend-team/bundle'
const workspaceNvmRoot = resolve(root, '.backend-team/runtime/nvm/versions/node/v24.19.0')
const dshRoot = resolve(root, `.backend-team/runtime/dsh/${harnessVersion}`)
const dshBin = join(dshRoot, 'node_modules/.bin/dsh')
const localBin = join(dshRoot, 'node_modules/.bin')
const npmBin = join(dirname(process.execPath), 'npm')

function fail(message) {
  throw new Error(`web client verification failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function assertWorkspaceNode() {
  assert(resolve(process.execPath).startsWith(`${workspaceNvmRoot}${sep}`), 'Node must come from the workspace-local NVM runtime')
  assert(resolve(npmBin).startsWith(`${workspaceNvmRoot}${sep}`), 'npm must come from the workspace-local NVM runtime')
}

async function run(file, args, options) {
  try {
    return await execFileAsync(file, args, { maxBuffer: 8 * 1024 * 1024, ...options })
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${file} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: error })
  }
}

function environment(temp) {
  const env = {
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
  return env
}

async function packBundle(temp, env) {
  const destination = join(temp, 'bundle-pack')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const result = await run(process.execPath, [npmBin, 'pack', '--workspace', bundleName, '--json', '--pack-destination', destination], { cwd: root, env })
  const records = JSON.parse(result.stdout)
  assert(Array.isArray(records) && records.length === 1, 'npm pack did not return exactly one Bundle')
  const filename = records[0]?.filename
  assert(typeof filename === 'string' && filename === filename.split('/').at(-1) && !filename.includes('..'), 'npm pack returned an unsafe filename')
  return join(destination, filename)
}

async function installBundle(temp, env, tarball) {
  await mkdir(join(temp, 'store'), { recursive: true, mode: 0o700 })
  await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', tarball, '--ignore-scripts', '--store-dir', join(temp, 'store')], { cwd: root, env })
  const dump = await run(process.execPath, [dshBin, '--profile', 'web', '--dump-config'], { cwd: root, env })
  const rows = dump.stdout.match(/^\s*- id: backend-team\s*$/gmu) ?? []
  const names = dump.stdout.match(/name:\s*['"]?@dsh-backend-team\/bundle['"]?/gu) ?? []
  assert(rows.length === 1, 'Profile must contain exactly one backend-team row')
  assert(names.length === 1, 'Profile must contain exactly one Bundle name')
}

async function launchWeb(env) {
  const child = spawn(process.execPath, [dshBin, 'web', '--host', '127.0.0.1', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  let settled = false
  const collect = (chunk) => output.push(chunk.toString())
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const close = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })))
  try {
    let url
    for (let attempt = 0; attempt < 450 && url === undefined; attempt += 1) {
      const text = output.join('')
      url = text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/u)?.[1]
      if (url !== undefined) break
      const result = await Promise.race([close, new Promise((resolveWait) => setTimeout(() => resolveWait(undefined), 100))])
      if (result !== undefined) fail(`Web process exited before binding (${JSON.stringify(result)})`)
    }
    assert(url !== undefined, `Web process did not print a loopback URL: ${output.join('')}`)
    const rootResponse = await fetch(url)
    const html = await rootResponse.text()
    assert(rootResponse.status === 200, `Web root returned HTTP ${rootResponse.status}`)
    const marker = 'window.__DSH_BOOT__ = '
    const markerStart = html.indexOf(marker)
    assert(markerStart >= 0, 'Web root did not contain the DSH boot manifest')
    const jsonStart = markerStart + marker.length
    const scriptEnd = html.indexOf('</script>', jsonStart)
    assert(scriptEnd > jsonStart, 'DSH boot manifest script was truncated')
    const manifest = JSON.parse(html.slice(jsonStart, scriptEnd))
    const entry = manifest.entries?.find((candidate) => candidate.id === bundleName)
    assert(entry?.url === `/plugins/${bundleName}/client.js?rev=${entry.rev}`, 'Bundle client entry is missing or malformed')
    const clientResponse = await fetch(new URL(entry.url, url))
    const clientText = await clientResponse.text()
    assert(clientResponse.status === 200, `Bundle client asset returned HTTP ${clientResponse.status}`)
    assert(clientText.includes('backendTeamConversationDefinition'), 'Bundle client asset does not contain the conversation definition')
    assert(!clientText.includes(root), 'Bundle client asset leaked the workspace path')
    const result = {
      status: 'passed',
      harness: harnessVersion,
      httpStatus: rootResponse.status,
      clientAssetStatus: clientResponse.status,
      clientEntry: entry.id,
      clientRevision: entry.rev,
      htmlSha256: createHash('sha256').update(html).digest('hex'),
    }
    settled = true
    return result
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([close, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))])
    if (!settled && child.exitCode === null) child.kill('SIGKILL')
  }
}

const temp = await mkdtemp(join(tmpdir(), 'dsh-web-client-verify-'))
try {
  assertWorkspaceNode()
  await access(dshBin)
  await mkdir(join(temp, 'npm-cache'), { recursive: true, mode: 0o700 })
  await mkdir(join(temp, 'xdg-config'), { recursive: true, mode: 0o700 })
  await mkdir(join(temp, 'xdg-cache'), { recursive: true, mode: 0o700 })
  await writeFile(join(temp, 'npmrc'), 'registry=https://registry.npmjs.org/\nignore-scripts=true\n', { mode: 0o600 })
  const env = environment(temp)
  const tarball = await packBundle(temp, env)
  const result = await installBundle(temp, env, tarball).then(() => launchWeb(env))
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
