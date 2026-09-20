import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, copyFile, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DBGATE_DEPENDENCY_POLICY } from './dbgate-dependency-policy.js'

export const DBGATE_POSTGRES_LAUNCHER = `#!/usr/bin/env node\nconst path = require('node:path')\nglobal.API_PACKAGE = path.dirname(path.dirname(require.resolve('dbgate-api')))\nglobal.PLUGINS_DIR = path.join(__dirname, 'plugins')\nglobal.IS_NPM_DIST = true\nconst dbgateApi = require('dbgate-api')\ndbgateApi.getMainModule().start()\n`

export interface DbGateInstallRunner { run(args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<{ exitCode: number; stdout: string; stderr: string }> }
export interface DbGateInstallerOptions { readonly workspaceRoot: string; readonly runner: DbGateInstallRunner; readonly npmPath: string }
export interface DbGateInstallResult { readonly runtimeRoot: string; readonly executableRoot: string; readonly packages: readonly string[] }
export class DbGateInstaller {
  constructor(private readonly options: DbGateInstallerOptions) {}
  async ensureInstalled(approved: boolean, approvalToken?: string): Promise<DbGateInstallResult> {
    if (!approved || approvalToken === undefined || approvalToken.length < 16) throw new Error('DbGate installation requires explicit approval')
    const workspaceRoot = await realpath(this.options.workspaceRoot)
    const directories = ['.backend-team', '.backend-team/runtime', '.backend-team/runtime/dbgate'].map((path) => resolve(workspaceRoot, path))
    for (const directory of directories) {
      try { await mkdir(directory, { mode: 0o700 }) } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      }
      await assertRuntimeDirectory(directory)
    }
    for (const directory of directories) await assertRuntimeDirectory(directory)
    const runtimeRoot = resolve(workspaceRoot, '.backend-team/runtime/dbgate')
    await writeRuntimePackageManifest(runtimeRoot)
    // Remove stale entries from older `dbgate-serve` installs before npm runs.
    // The directory is workspace-owned, so this cannot touch user project data.
    await removeDisabledPackageEntries(resolve(runtimeRoot, 'node_modules'))
    const args = ['install', '--prefix', runtimeRoot, '--ignore-scripts', '--save-exact', ...DBGATE_DEPENDENCY_POLICY.packages]
    const result = await this.options.runner.run([this.options.npmPath, ...args], workspaceRoot, { npm_config_ignore_scripts: 'true', npm_config_prefix: runtimeRoot })
    if (result.exitCode !== 0) throw new Error(`DbGate installation failed: ${result.stderr || result.stdout}`)
    await assertNoDisabledPackageEntries(resolve(runtimeRoot, 'node_modules'))
    await materializePostgresOnlyProfile(runtimeRoot)
    for (const directory of directories) await assertRuntimeDirectory(directory)
    return { runtimeRoot, executableRoot: runtimeRoot, packages: DBGATE_DEPENDENCY_POLICY.packages }
  }
}

/**
 * DbGate 7.2.3's `dbgate-serve` package declares every connector as a hard
 * dependency.  The Backend Agent Team only grants PostgreSQL access, so the
 * installer builds a small, deterministic plugin profile instead of loading
 * the Excel connector and its vulnerable `xlsx` dependency.
 */
async function materializePostgresOnlyProfile(runtimeRoot: string): Promise<void> {
  const nodeModules = resolve(runtimeRoot, 'node_modules')
  await assertRuntimeDirectory(nodeModules)
  for (const name of ['dbgate-api', 'dbgate-web', 'dbgate-plugin-postgres']) {
    const packageRoot = resolve(nodeModules, name)
    await assertRuntimePackage(packageRoot, name)
  }

  const pluginsRoot = resolve(runtimeRoot, 'plugins')
  try { await mkdir(pluginsRoot, { recursive: true, mode: 0o700 }) } catch (error: unknown) {
    if (!isNodeError(error, 'EEXIST')) throw error
  }
  await assertRuntimeDirectory(pluginsRoot)
  const postgresPlugin = resolve(nodeModules, 'dbgate-plugin-postgres')
  const target = resolve(pluginsRoot, 'dbgate-plugin-postgres')
  await replaceOwnedDirectory(postgresPlugin, target)
  await writeLauncher(resolve(runtimeRoot, 'dbgate-postgres-serve.cjs'))
}

async function assertRuntimePackage(path: string, name: string): Promise<void> {
  await assertRuntimeDirectory(path)
  const manifestPath = resolve(path, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
  if (manifest.name !== name || manifest.version !== '7.2.3') throw new Error(`DbGate package ${name} must be version 7.2.3`)
}

async function replaceOwnedDirectory(source: string, target: string): Promise<void> {
  await assertRuntimeDirectory(source)
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`
  const backup = `${target}.${randomBytes(8).toString('hex')}.bak`
  // Build the replacement before touching the current profile. If copying a
  // package fails halfway through, the last known-good plugin remains usable.
  await copyOwnedDirectory(source, temporary)
  let backedUp = false
  try {
    try {
      const current = await lstat(target)
      if (current.isSymbolicLink() || !current.isDirectory() || await realpath(target) !== target) throw new Error('DbGate plugin profile contains an unsafe path')
      await rename(target, backup)
      backedUp = true
    } catch (error: unknown) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
    try {
      await rename(temporary, target)
    } catch (error) {
      if (backedUp) await rename(backup, target)
      throw error
    }
    if (backedUp) await rm(backup, { recursive: true, force: true })
  } finally {
    await rm(temporary, { recursive: true, force: true })
    if (backedUp) await rm(backup, { recursive: true, force: true })
  }
}

async function copyOwnedDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name)
    const targetPath = resolve(target, entry.name)
    if (entry.isSymbolicLink()) throw new Error('DbGate plugin profile cannot contain symlinks')
    if (entry.isDirectory()) await copyOwnedDirectory(sourcePath, targetPath)
    else if (entry.isFile()) await copyFile(sourcePath, targetPath)
    else throw new Error('DbGate plugin profile contains an unsupported file type')
  }
}

async function writeLauncher(path: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temporary, DBGATE_POSTGRES_LAUNCHER, { flag: 'wx', mode: 0o700 })
  try {
    await chmod(temporary, 0o700)
    await rename(temporary, path)
    await chmod(path, 0o700)
  } finally { await rm(temporary, { force: true }) }
}

async function assertRuntimeDirectory(path: string): Promise<void> {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) throw new Error('DbGate runtime must use real workspace directories without symlinks')
}

const DISABLED_PACKAGE_NAMES = new Set(['dbgate-serve', 'dbgate-plugin-excel', 'xlsx'])

async function removeDisabledPackageEntries(root: string): Promise<void> {
  let info
  try { info = await lstat(root) } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('DbGate node_modules must be a real workspace directory')
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = resolve(root, entry.name)
    if (DISABLED_PACKAGE_NAMES.has(entry.name)) await rm(entryPath, { recursive: true, force: true })
    else if (entry.isDirectory()) await removeDisabledPackageEntries(entryPath)
  }
}

async function assertNoDisabledPackageEntries(root: string): Promise<void> {
  await assertRuntimeDirectory(root)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = resolve(root, entry.name)
    if (DISABLED_PACKAGE_NAMES.has(entry.name)) throw new Error(`DbGate runtime contains disabled package ${entry.name}`)
    if (entry.isDirectory()) await assertNoDisabledPackageEntries(entryPath)
  }
}

type JsonObject = Record<string, unknown>

async function writeRuntimePackageManifest(runtimeRoot: string): Promise<void> {
  const path = resolve(runtimeRoot, 'package.json')
  const existing = await readExistingManifest(path)
  const manifest = mergeRuntimeManifest(existing?.value)
  const content = `${JSON.stringify(manifest, null, 2)}\n`
  await writeManifestSafely(path, content, existing)
}

async function readExistingManifest(path: string): Promise<{ readonly value: JsonObject; readonly content: string; readonly mode: number } | undefined> {
  let entry
  try { entry = await lstat(path) } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
  if (!entry.isFile() || entry.isSymbolicLink() || await realpath(path) !== path) throw new Error('DbGate package manifest must be a real file without symlinks')
  const content = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new Error('DbGate package manifest must contain valid JSON') }
  if (!isJsonObject(value)) throw new Error('DbGate package manifest must contain a JSON object')
  return { value, content, mode: entry.mode & 0o777 }
}

function mergeRuntimeManifest(existing: JsonObject | undefined): JsonObject {
  const manifest: JsonObject = { ...(existing ?? {}) }
  if (manifest.private !== undefined && manifest.private !== true) throw new Error('DbGate package manifest private setting conflicts with the pinned runtime policy')
  manifest.private = true
  const requiredDependencies: Record<string, string> = {}
  for (const packageSpec of DBGATE_DEPENDENCY_POLICY.packages) {
    const separator = packageSpec.lastIndexOf('@')
    if (separator <= 0) throw new Error(`DbGate package specification is invalid: ${packageSpec}`)
    requiredDependencies[packageSpec.slice(0, separator)] = packageSpec.slice(separator + 1)
  }
  const dependencies = mergeStringMap('dependencies', manifest.dependencies, requiredDependencies)
  // Remove the legacy umbrella package. Its dependency list reintroduces every
  // connector, including the vulnerable Excel path, on the next npm install.
  delete dependencies['dbgate-serve']
  delete dependencies['dbgate-plugin-excel']
  delete dependencies.xlsx
  manifest.dependencies = dependencies
  manifest.overrides = mergeOverrideMap(manifest.overrides)
  return manifest
}

function mergeStringMap(field: string, current: unknown, required: Readonly<Record<string, string>>): JsonObject {
  const merged = current === undefined ? {} : asJsonObject(current, field)
  for (const [name, version] of Object.entries(required)) {
    if (merged[name] !== undefined && merged[name] !== version) throw new Error(`DbGate package manifest ${field}.${name} conflicts with the pinned runtime policy`)
    merged[name] = version
  }
  return merged
}

function mergeOverrideMap(current: unknown): JsonObject {
  const merged = current === undefined ? {} : asJsonObject(current, 'overrides')
  for (const [parent, required] of Object.entries(DBGATE_DEPENDENCY_POLICY.overrides)) {
    if (typeof required === 'string') {
      if (merged[parent] !== undefined && merged[parent] !== required) throw new Error(`DbGate package manifest overrides.${parent} conflicts with the reviewed dependency policy`)
      merged[parent] = required
      continue
    }
    const parentOverrides = merged[parent] === undefined ? {} : asJsonObject(merged[parent], `overrides.${parent}`)
    for (const [name, version] of Object.entries(required)) {
      if (parentOverrides[name] !== undefined && parentOverrides[name] !== version) throw new Error(`DbGate package manifest overrides.${parent}.${name} conflicts with the reviewed dependency policy`)
      parentOverrides[name] = version
    }
    merged[parent] = parentOverrides
  }
  return merged
}

async function writeManifestSafely(path: string, content: string, existing: { readonly content: string; readonly mode: number } | undefined): Promise<void> {
  const parent = dirname(path)
  await assertRuntimeDirectory(parent)
  const temporary = resolve(parent, `.package-${randomUUID()}.json.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    if (existing !== undefined) await handle.chmod(existing.mode || 0o600)
    await handle.sync()
  } finally { await handle.close() }
  try {
    if (existing === undefined) {
      await link(temporary, path)
    } else {
      const current = await readExistingManifest(path)
      if (current === undefined || current.content !== existing.content) throw new Error('DbGate package manifest changed while preparing the install')
      await rename(temporary, path)
    }
  } finally { await rm(temporary, { force: true }) }
}

function asJsonObject(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`DbGate package manifest ${field} must be a JSON object`)
  return { ...value }
}

function isJsonObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isNodeError(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code }
