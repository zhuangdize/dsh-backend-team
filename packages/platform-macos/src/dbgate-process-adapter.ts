import { execFile as execFileCallback } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ManagedProcessRecord, ProcessStartRequest } from './process-supervisor.js'

const execFile = promisify(execFileCallback)
const PROCESS_ID = 'dbgate-process'

export interface DbGateSupervisor {
  start(request: ProcessStartRequest): Promise<{ readonly record: ManagedProcessRecord; readonly child: { readonly pid: number } }>
  stop(id: string, signal: AbortSignal): Promise<void>
}

export interface DbGateListenerInspector {
  inspect(pid: number, signal: AbortSignal): Promise<readonly string[]>
}

export interface WorkspaceDbGateProcessAdapterOptions {
  readonly workspaceRoot: string
  readonly runtimeRoot: string
  readonly nodeExecutable: string
  readonly preloadPath: string
  readonly supervisor: DbGateSupervisor
  readonly listenerInspector?: DbGateListenerInspector
  readonly readyProbe?: (url: string) => Promise<boolean>
}

export interface WorkspaceDbGateProcess {
  readonly pid: number
  readonly executable: string
}

/**
 * Bridges the database package's DbGate lifecycle to the macOS policy-owned
 * ProcessSupervisor. The adapter never spawns an ambient `node`: it runs the
 * entrypoint through the exact workspace Node executable and keeps HOME/TMPDIR
 * inside the DbGate runtime.
 */
export class WorkspaceDbGateProcessAdapter {
  private active: { readonly id: string; readonly process: WorkspaceDbGateProcess } | undefined

  constructor(private readonly options: WorkspaceDbGateProcessAdapterOptions) {
    if (typeof options.supervisor?.start !== 'function' || typeof options.supervisor.stop !== 'function') throw new TypeError('DbGate supervisor is required')
  }

  async start(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<WorkspaceDbGateProcess> {
    if (this.active !== undefined) throw new Error('DbGate process is already running')
    const roots = await this.resolveRoots()
    const entrypoint = await canonicalInside(executable, roots.runtimeRoot, 'DbGate executable')
    const workingDirectory = await canonicalInside(cwd, roots.runtimeRoot, 'DbGate cwd')
    const preload = await canonicalInside(this.options.preloadPath, roots.workspaceRoot, 'DbGate preload')
    const homeDirectory = resolve(roots.runtimeRoot, 'home')
    const tempDirectory = resolve(roots.runtimeRoot, 'tmp')
    const userDataDirectory = resolve(roots.runtimeRoot, 'user-data')
    for (const directory of [homeDirectory, tempDirectory, userDataDirectory]) {
      try { await mkdir(directory, { mode: 0o700 }) } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      }
      const entry = await lstat(directory)
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('DbGate data directory must remain inside runtime without symlinks')
    }
    const childEnv: Record<string, string> = {
      ...env,
      PATH: dirname(roots.nodeExecutable),
      HOME: homeDirectory,
      TMPDIR: tempDirectory,
      WORKSPACE_DIR: userDataDirectory,
    }
    const nodeArgs = ['--require', preload]
    const signal = new AbortController().signal
    const started = await this.options.supervisor.start({
      id: PROCESS_ID,
      executable: roots.nodeExecutable,
      args: [...nodeArgs, entrypoint, ...args],
      cwd: workingDirectory,
      env: childEnv,
      purpose: 'workspace-local-dbgate',
      signal,
    })
    if (started.record.pid !== started.child.pid || started.record.executableRealPath !== roots.nodeExecutable || started.record.workspaceRoot !== roots.workspaceRoot) {
      await this.options.supervisor.stop(PROCESS_ID, new AbortController().signal).catch(() => undefined)
      throw new Error('DbGate process identity is invalid')
    }
    const process = Object.freeze({ pid: started.record.pid, executable: started.record.executableRealPath })
    this.active = { id: PROCESS_ID, process }
    return process
  }

  async stop(process: WorkspaceDbGateProcess): Promise<void> {
    if (this.active === undefined || this.active.process.pid !== process.pid || this.active.process.executable !== process.executable) throw new Error('DbGate process identity mismatch')
    await this.options.supervisor.stop(this.active.id, new AbortController().signal)
    this.active = undefined
  }

  async inspectListeners(process: WorkspaceDbGateProcess): Promise<readonly string[]> {
    this.assertActive(process)
    return this.options.listenerInspector?.inspect(process.pid, new AbortController().signal) ?? inspectMacOsListeners(process.pid)
  }

  async isReady(url: string): Promise<boolean> {
    assertLoopbackUrl(url)
    if (this.options.readyProbe !== undefined) return this.options.readyProbe(url)
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1_500) })
      return response.status >= 200 && response.status < 400
    } catch {
      return false
    }
  }

  private assertActive(process: WorkspaceDbGateProcess): void {
    if (this.active === undefined || this.active.process.pid !== process.pid || this.active.process.executable !== process.executable) throw new Error('DbGate process identity mismatch')
  }

  private async resolveRoots(): Promise<{ readonly workspaceRoot: string; readonly runtimeRoot: string; readonly nodeExecutable: string }> {
    const workspaceRoot = await realpath(this.options.workspaceRoot)
    const runtimeRoot = await canonicalInside(this.options.runtimeRoot, workspaceRoot, 'DbGate runtime')
    const nodeExecutable = await canonicalInside(this.options.nodeExecutable, workspaceRoot, 'workspace Node executable')
    if (runtimeRoot === workspaceRoot) throw new Error('DbGate runtime must be below the workspace')
    await assertRuntimeDirectories(this.options.runtimeRoot, this.options.workspaceRoot, workspaceRoot)
    return { workspaceRoot, runtimeRoot, nodeExecutable }
  }
}

async function assertRuntimeDirectories(runtimePath: string, workspacePath: string, workspaceRoot: string): Promise<void> {
  let directory = resolve(runtimePath)
  while (true) {
    const canonical = await realpath(directory)
    const entry = await lstat(directory)
    // The selected workspace itself may have an alias, including macOS /var.
    // Aliases below that boundary are never managed runtime directories.
    if (canonical === workspaceRoot && (directory === resolve(workspacePath) || !entry.isSymbolicLink())) return
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isInside(workspaceRoot, canonical)) throw new Error('DbGate runtime directories must remain inside workspace without symlinks')
    const parent = dirname(directory)
    if (parent === directory) throw new Error('DbGate runtime is outside workspace')
    directory = parent
  }
}

async function canonicalInside(candidate: string, root: string, label: string): Promise<string> {
  if (!isAbsolute(candidate) || !isAbsolute(root)) throw new Error(`${label} must be absolute`)
  const target = await realpath(candidate)
  if (!isInside(root, target)) throw new Error(`${label} escapes the workspace runtime`)
  return target
}

function isInside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

async function inspectMacOsListeners(pid: number): Promise<readonly string[]> {
  const result = await execFile('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { cwd: process.cwd(), env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 5_000 }).catch((error: unknown) => {
    // lsof exits 1 when the child has not opened a listener yet. Preserve real
    // execution/permission failures instead of treating all errors as readiness.
    if (error instanceof Error && 'code' in error && error.code === 1 && 'stderr' in error && error.stderr === '' && 'stdout' in error && error.stdout === '') return { stdout: '', stderr: '' }
    throw error
  })
  return result.stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1)).filter((line) => line.length > 0)
}

function assertLoopbackUrl(value: string): void {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('DbGate readiness URL is invalid') }
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]')) throw new Error('DbGate readiness URL must be loopback-only')
}
