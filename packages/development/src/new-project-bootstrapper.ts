import { constants } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rm, link, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'

export interface NewProjectStrategy { readonly kind: string; readonly nodeRuntime: { readonly exactVersion: string; readonly source: string } }
export interface NewProjectApprovals { readonly design?: boolean | { effect?: string }; readonly dependency?: boolean | { effect?: string }; readonly install?: boolean | { effect?: string }; readonly installToken?: string }
export interface NewProjectRuntime { resolve(input: { selection: NewProjectStrategy['nodeRuntime']; projectKind: string; architecture: 'darwin-arm64' | 'darwin-x64'; installApproval: { approved: boolean; token?: string } }): Promise<{ nodeRealPath: string; npmRealPath: string; npxRealPath: string }> }
export interface NewProjectCommandRunner { run(request: { executable: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; purpose: string; risk: 'install'; networkPolicy: 'allow' | 'deny'; executionFingerprint: string; approvalToken?: string }): Promise<unknown> }
export interface NewProjectBootstrapperOptions { readonly workspaceRoot: string; readonly runtime?: NewProjectRuntime; readonly commandRunner: NewProjectCommandRunner; readonly architecture?: 'darwin-arm64' | 'darwin-x64' }
export interface NewProjectFile { readonly path: string; readonly bytes: number; readonly sha256: string; readonly realPath?: string }
export interface NewProjectManifest { readonly files: readonly NewProjectFile[]; readonly dependencies: Readonly<Record<string, string>>; readonly devDependencies: Readonly<Record<string, string>>; readonly commands: readonly string[]; readonly nodeRuntime: NewProjectStrategy['nodeRuntime']; readonly conflicts: readonly string[] }
const dependencies = { '@nestjs/common': '11.2.2', '@nestjs/core': '11.2.2', '@nestjs/platform-fastify': '11.2.2', '@nestjs/swagger': '11.4.7', 'drizzle-orm': '0.45.2', fastify: '5.12.1', pg: '8.23.0', 'reflect-metadata': '0.2.2', rxjs: '7.8.2' }
const devDependencies = { '@types/node': '24.13.3', '@types/pg': '8.23.1', 'drizzle-kit': '0.31.10', eslint: '10.9.1', typescript: '6.0.3', vitest: '4.1.11' }
const templateFiles = ['.nvmrc', 'package.json.json', 'tsconfig.json', 'tsconfig.build.json', 'drizzle.config.ts', 'src/main.ts', 'src/app.module.ts', 'src/health/health.controller.ts', 'src/database/database.module.ts', 'src/database/schema.ts', 'test/health.integration.test.ts']
export class NewProjectBootstrapper {
  constructor(private readonly options: NewProjectBootstrapperOptions) {}
  async preview(strategy: NewProjectStrategy): Promise<NewProjectManifest> {
    this.assertNewProject(strategy)
    const files: NewProjectFile[] = []
    for (const source of templateFiles) { const bytes = await readFile(this.template(source)); files.push({ path: source === 'package.json.json' ? 'package.json' : source, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }) }
    return { files, dependencies, devDependencies, commands: ['npm install --ignore-scripts', 'npm run typecheck', 'npm run build'], nodeRuntime: strategy.nodeRuntime, conflicts: await this.rootConflicts() }
  }
  async apply(strategy: NewProjectStrategy, approvals: NewProjectApprovals): Promise<NewProjectManifest> {
    this.assertNewProject(strategy); if (!approved(approvals.design)) throw new Error('design approval is required'); if (!approved(approvals.dependency)) throw new Error('dependency approval is required'); if (!approved(approvals.install)) throw new Error('install approval is required')
    const requestedRoot = resolve(this.options.workspaceRoot); await mkdir(requestedRoot, { recursive: true }); const root = await realpath(requestedRoot); const preview = await this.preview(strategy); if (preview.conflicts.length > 0) throw new Error(`new-project root conflicts: ${preview.conflicts.join(', ')}`)
    const runtime = this.options.runtime
    if (runtime === undefined) throw new Error('workspace node runtime is required')
    if (approvals.installToken === undefined || approvals.installToken.length === 0) throw new Error('install approval token is required')
    const resolved = await runtime.resolve({ selection: strategy.nodeRuntime, projectKind: strategy.kind, architecture: this.options.architecture ?? 'darwin-arm64', installApproval: { approved: true, token: approvals.installToken } })
    const appliedFiles: NewProjectFile[] = []
    for (const source of templateFiles) {
      const destination = join(root, source === 'package.json.json' ? 'package.json' : source); const data = await readFile(this.template(source));
      await atomicOwnedWrite(root, destination, data)
      const actualPath = await realpath(destination); const actual = await readFile(actualPath); const file = preview.files.find((entry) => entry.path === (source === 'package.json.json' ? 'package.json' : source))
      if (file === undefined || actual.byteLength !== file.bytes || createHash('sha256').update(actual).digest('hex') !== file.sha256) throw new Error(`written template verification failed: ${destination}`)
      appliedFiles.push({ ...file, realPath: actualPath })
    }
    const installEnv = { PATH: dirname(resolved.nodeRealPath), NPM_CONFIG_CACHE: join(root, '.backend-team/cache/npm') }
    const executionFingerprint = createHash('sha256').update(JSON.stringify({ executable: resolved.npmRealPath, args: ['install', '--ignore-scripts'], cwd: root, env: installEnv, networkPolicy: 'allow' })).digest('hex')
    const result = await this.options.commandRunner.run({ executable: resolved.npmRealPath, args: ['install', '--ignore-scripts'], cwd: root, env: installEnv, purpose: 'install approved new project dependencies', risk: 'install', networkPolicy: 'allow', executionFingerprint, approvalToken: approvals.installToken })
    if (typeof result === 'object' && result !== null && 'exitCode' in result && (result as { exitCode?: unknown }).exitCode !== 0) throw new Error('new-project dependency install failed')
    return { ...preview, files: appliedFiles }
  }
  private assertNewProject(strategy: NewProjectStrategy): void { if (!/new-project/i.test(strategy.kind)) throw new Error('new-project bootstrap is not applicable') }
  private async rootConflicts(): Promise<string[]> {
    const root = resolve(this.options.workspaceRoot); const conflicts: string[] = []; const allowedManaged = new Set(['state', 'runtime', 'cache', 'logs', 'locks', 'handoff'])
    try { if ((await lstat(root)).isSymbolicLink()) conflicts.push('workspace root is a symlink') } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let entries: string[]
    try { entries = await readdir(root) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return conflicts; throw error }
    for (const entry of entries) {
      const path = join(root, entry); const details = await lstat(path)
      if (entry !== '.backend-team') { conflicts.push(entry); continue }
      if (!details.isDirectory() || details.isSymbolicLink()) { conflicts.push(entry); continue }
      for (const managed of await readdir(path)) {
        const managedPath = join(path, managed); const managedDetails = await lstat(managedPath)
        if (!allowedManaged.has(managed) || managedDetails.isSymbolicLink() || !managedDetails.isDirectory()) conflicts.push(`.backend-team/${managed}`)
      }
    }
    return conflicts
  }
  private template(name: string): string { return resolve(dirname(new URL(import.meta.url).pathname), '../../../templates/new-project/node-postgresql', name) }
}
async function atomicOwnedWrite(root: string, path: string, data: Uint8Array): Promise<void> {
  const canonicalRoot = await realpath(root); const target = resolve(path); const targetRelative = relative(canonicalRoot, target)
  if (targetRelative === '' || targetRelative.startsWith('..') || isAbsolute(targetRelative)) throw new Error('template target escapes workspace')
  const parent = await ensureParent(canonicalRoot, dirname(target));
  const canonicalTarget = join(parent, target.slice(dirname(target).length + 1))
  try { const existing = await lstat(canonicalTarget); if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('owned target is unsafe'); throw new Error('owned target already exists') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = join(parent, `.backend-team-tmp-${randomBytes(16).toString('hex')}`); const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); let closed = false
  try { await handle.writeFile(data); await handle.sync(); await handle.close(); closed = true; await link(temporary, canonicalTarget); await rm(temporary); const final = await lstat(canonicalTarget); if (!final.isFile() || final.nlink !== 1 || final.size !== data.byteLength) throw new Error('owned target verification failed'); const parentHandle = await open(parent, constants.O_RDONLY); try { await parentHandle.sync() } finally { await parentHandle.close() } } catch (error) { if (!closed) await handle.close().catch(() => undefined); await rm(temporary, { force: true }); throw error }
}
async function ensureParent(root: string, requested: string): Promise<string> {
  const relativeParent = relative(root, requested); if (relativeParent.startsWith('..') || isAbsolute(relativeParent)) throw new Error('template parent escapes workspace')
  let current = root
  for (const segment of relativeParent.split('/').filter(Boolean)) { current = join(current, segment); try { const details = await lstat(current); if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('template parent is unsafe') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(current, { mode: 0o700 }) } }
  return current
}
function approved(value: unknown): boolean { return value === true || (typeof value === 'object' && value !== null && (value as { effect?: unknown }).effect === 'approve') }
