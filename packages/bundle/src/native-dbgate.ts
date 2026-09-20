import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DBGATE_POSTGRES_LAUNCHER, DbGateLauncher, SchemaDesignSession, assertDatabaseId } from '@dsh-backend-team/database'
import type { CredentialStore, DatabaseDesignSessionPort, LocalDatabaseEndpoint } from '@dsh-backend-team/database'
import { ProcessSupervisor, WorkspaceDbGateProcessAdapter, createWorkspaceLayout, initializeWorkspaceLayout } from '@dsh-backend-team/platform-macos'

export interface NativeDbGateConfig { readonly runtimeRoot: string; readonly port: number }
export async function createNativeDbGate(root: string, config: NativeDbGateConfig, preloadPath: string, credentials: CredentialStore, endpoint: () => LocalDatabaseEndpoint, command: (program: string, args: readonly string[], endpoint: LocalDatabaseEndpoint) => Promise<string>): Promise<{ dbgate: DbGateLauncher; designSession: DatabaseDesignSessionPort; guiPort: number }> {
  const runtime = await realpath(config.runtimeRoot)
  if (runtime !== config.runtimeRoot || !runtime.startsWith(join(root, '.backend-team/runtime') + '/')) throw new Error('DbGate runtime must be a canonical workspace runtime')
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('DbGate port must be high and local')
  for (const name of ['dbgate-api', 'dbgate-web', 'dbgate-plugin-postgres']) {
    const manifest = JSON.parse(await readFile(join(runtime, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }
    if (manifest.version !== '7.2.3') throw new Error('DbGate runtime version must be 7.2.3')
  }
  await assertNoDisabledPackages(join(runtime, 'node_modules'))
  const pluginsRoot = join(runtime, 'plugins')
  if ((await lstat(pluginsRoot)).isSymbolicLink() || await realpath(pluginsRoot) !== pluginsRoot) throw new Error('DbGate plugin profile is unsafe')
  const plugins = await readdir(pluginsRoot)
  if (plugins.length !== 1 || plugins[0] !== 'dbgate-plugin-postgres') throw new Error('DbGate plugin profile must contain only PostgreSQL')
  const postgresPlugin = join(pluginsRoot, 'dbgate-plugin-postgres')
  const postgresPluginInfo = await lstat(postgresPlugin)
  if (!postgresPluginInfo.isDirectory() || postgresPluginInfo.isSymbolicLink() || await realpath(postgresPlugin) !== postgresPlugin) throw new Error('DbGate PostgreSQL plugin profile is unsafe')
  const entrypointPath = join(runtime, 'dbgate-postgres-serve.cjs')
  const entrypointInfo = await lstat(entrypointPath)
  if (!entrypointInfo.isFile() || entrypointInfo.isSymbolicLink() || await realpath(entrypointPath) !== entrypointPath || await readFile(entrypointPath, 'utf8') !== DBGATE_POSTGRES_LAUNCHER) throw new Error('DbGate PostgreSQL launcher is not the reviewed profile')
  const entrypoint = await realpath(entrypointPath)
  const nodeExecutable = await realpath(process.execPath)
  const preload = await realpath(preloadPath)
  const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
  let expected: { args: readonly string[]; env: Readonly<Record<string, string>> } | undefined
  const supervisor = new ProcessSupervisor(layout, { capability: {
    executeApprovedProcess: async (scope, signal, operation) => {
      const grant = expected; expected = undefined
      if (grant === undefined || signal.aborted || scope.executable !== nodeExecutable || scope.cwd !== runtime || scope.purpose !== 'workspace-local-dbgate' || JSON.stringify(scope.args) !== JSON.stringify(grant.args) || JSON.stringify(scope.env) !== JSON.stringify(grant.env)) throw new Error('DbGate process does not match its configured launch scope')
      return operation()
    },
  } })
  const adapter = new WorkspaceDbGateProcessAdapter({ workspaceRoot: root, runtimeRoot: runtime, nodeExecutable, preloadPath: preload, supervisor: {
    start: async request => { const result = await supervisor.start(request); if (result.child.pid === undefined) { await supervisor.stop(result.record.id, new AbortController().signal); throw new Error('DbGate process has no PID') }; return { record: result.record, child: { pid: result.child.pid } } },
    stop: (id, signal) => supervisor.stop(id, signal),
  } })
  const dbgate = new DbGateLauncher({ workspaceRoot: root, runtimeRoot: runtime, executable: entrypoint, credentials, process: {
    start: async (file, args, cwd, env) => {
      expected = { args: ['--require', preload, entrypoint, ...args], env: { ...env, PATH: dirname(nodeExecutable), HOME: join(runtime, 'home'), TMPDIR: join(runtime, 'tmp'), WORKSPACE_DIR: join(runtime, 'user-data') } }
      try { return await adapter.start(file, args, cwd, env) } finally { expected = undefined }
    },
    stop: child => adapter.stop(child), inspectListeners: child => adapter.inspectListeners(child), isReady: url => adapter.isReady(url),
  } })
  const sessions = (): SchemaDesignSession => new SchemaDesignSession(endpoint(), {
    createDesignDatabase: async (name, source, value) => { assertDatabaseId(name); assertDatabaseId(source); await command('createdb', ['--maintenance-db', value.database, '--template', source, name], value) },
    captureSchema: async (name, value) => { assertDatabaseId(name); return command('pg_dump', ['--dbname', name, '--schema-only', '--no-owner', '--no-privileges'], value) },
    dropDatabase: async (name, value) => { if (!/^design_[a-f0-9]{16}$/u.test(name)) throw new Error('Only owned design databases may be discarded'); await command('dropdb', ['--maintenance-db', value.database, name], value) },
  })
  return { dbgate, guiPort: config.port, designSession: { open: source => sessions().open(source), discard: session => sessions().discard(session) } }
}

async function assertNoDisabledPackages(root: string): Promise<void> {
  const disabled = new Set(['dbgate-serve', 'dbgate-plugin-excel', 'xlsx'])
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      if (disabled.has(entry.name)) throw new Error(`DbGate runtime contains disabled package ${entry.name}`)
      if (entry.isDirectory()) await visit(entryPath)
    }
  }
  await visit(root)
}
