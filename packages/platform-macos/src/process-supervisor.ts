import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { WorkspaceLayout } from '@dsh-backend-team/contracts'
import { assertManagedPath, syncManagedDirectory, updateManagedMetadata, writeManagedMetadata } from './workspace-layout.js'

const execFile = promisify(execFileCallback)
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/u
const FINGERPRINT = /^.+\0\/.+$/u

export interface ManagedProcessRecord { readonly id: string; readonly pid: number; readonly executableRealPath: string; readonly startFingerprint: string; readonly workspaceRoot: string; readonly startedAt: string; readonly purpose: string }
export interface ProcessIdentity { readonly executableRealPath: string; readonly startFingerprint: string }
export interface ProcessStartRequest { readonly id: string; readonly executable: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly purpose: string; readonly signal: AbortSignal }
export interface ProcessStartResult { readonly record: ManagedProcessRecord; readonly child: ChildProcess }
export interface ProcessExecutionScope { readonly executable: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly purpose: string }
/** Policy-engine-owned, single-use capability. The supervisor never creates a permissive default. */
export interface ProcessExecutionCapability { executeApprovedProcess<T>(scope: ProcessExecutionScope, signal: AbortSignal, operation: () => Promise<T>): Promise<T> }
export interface ProcessSupervisorOptions {
  readonly inspect?: (pid: number, executable: string, signal: AbortSignal, env: Readonly<Record<string, string>>) => Promise<ProcessIdentity>
  readonly pidExists?: (pid: number, signal: AbortSignal, env: Readonly<Record<string, string>>) => boolean | Promise<boolean>
  readonly sendSignal?: (pid: number, signal: NodeJS.Signals) => void
  readonly waitMs?: (milliseconds: number) => Promise<void>
  readonly spawnProcess?: (request: ProcessStartRequest) => ChildProcess
  readonly persistRecord?: (layout: WorkspaceLayout, record: ManagedProcessRecord) => Promise<void>
  readonly stopTimeoutMs?: number
  readonly now?: () => Date
  readonly capability: ProcessExecutionCapability
}

export class ProcessSupervisor {
  private readonly timeoutMs: number
  constructor(private readonly layout: WorkspaceLayout, private readonly options: ProcessSupervisorOptions) {
    if (options.capability === undefined || typeof options.capability.executeApprovedProcess !== 'function') throw new Error('policy execution capability is required')
    this.timeoutMs = Math.min(5_000, Math.max(0, options.stopTimeoutMs ?? 5_000))
  }

  async start(request: ProcessStartRequest): Promise<ProcessStartResult> {
    assertSafeId(request.id)
    throwIfAborted(request.signal)
    const executable = await realpath(request.executable)
    const cwd = await realpath(request.cwd)
    if (!isInside(this.layout.root, cwd)) throw new Error('process cwd escapes workspace')
    const env = validateProcessEnvironment(request.env)
    const effectiveRequest = Object.freeze({ ...request, executable, cwd, env: Object.freeze({ ...env }), args: Object.freeze([...request.args]) })
    const reservationPath = assertManagedPath(this.layout, join(this.layout.runtimeDir, `${request.id}.pid.reserve`))
    await writeManagedMetadata(this.layout, `runtime/${request.id}.pid.reserve`, `${JSON.stringify({ schemaVersion: 1, id: request.id, workspaceRoot: this.layout.root, state: 'reserved' })}\n`)
    let child: ChildProcess | undefined
    let identity: ProcessIdentity | undefined
    let record: ManagedProcessRecord | undefined
    let recordPersistenceAttempted = false
    try {
      throwIfAborted(request.signal)
      child = await this.options.capability.executeApprovedProcess(effectiveRequest, request.signal, async () => this.spawn(effectiveRequest))
      if (child.pid === undefined) throw new Error('spawn did not return a PID')
      const startedAt = (this.options.now ?? (() => new Date()))().toISOString()
      await updateManagedMetadata(this.layout, `runtime/${request.id}.pid.reserve`, `${JSON.stringify({ schemaVersion: 1, id: request.id, workspaceRoot: this.layout.root, state: 'pending', pid: child.pid, executableRealPath: executable, startedAt, lifecycle: 'running' })}\n`)
      throwIfAborted(request.signal)
      identity = await this.inspect(child.pid, executable, request.signal, env)
      if (identity.executableRealPath !== executable) throw new Error('spawned process executable identity mismatch')
      record = { id: request.id, pid: child.pid, executableRealPath: executable, startFingerprint: identity.startFingerprint, workspaceRoot: this.layout.root, startedAt, purpose: request.purpose }
      await validateRecord(record, request.id, this.layout.root)
      recordPersistenceAttempted = true
      if (this.options.persistRecord !== undefined) await this.options.persistRecord(this.layout, record)
      else await writeManagedMetadata(this.layout, `runtime/${record.id}.pid.json`, `${JSON.stringify(record)}\n`)
      return { record, child }
    } catch (error: unknown) {
      const cleanupErrors: unknown[] = []
      let cleanupConfirmed = child === undefined
      if (child !== undefined) {
        await this.cleanupChild(child, identity, env).then(() => { cleanupConfirmed = true }).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError))
      }
      let recordCleanupConfirmed = !recordPersistenceAttempted || record === undefined
      if (cleanupConfirmed && recordPersistenceAttempted && record !== undefined) await removeRecordIfOwned(this.layout, record).then(() => { recordCleanupConfirmed = true }).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError))
      if (cleanupConfirmed && recordCleanupConfirmed) await removeAndSync(reservationPath, this.layout.runtimeDir).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError))
      if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], `process start and cleanup failed: ${[error, ...cleanupErrors].map((item) => item instanceof Error ? item.message : String(item)).join('; ')}`)
      throw error
    }
  }

  async stop(id: string, signal: AbortSignal): Promise<void> {
    assertSafeId(id)
    throwIfAborted(signal)
    const record = await this.load(id)
    if (!(await this.isAlive(record.pid, signal))) { await this.remove(record); await this.removeReservation(record.id); return }
    await this.assertIdentity(record, signal)
    const send = this.options.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
    try { send(record.pid, 'SIGTERM') } catch (error: unknown) { if (!isNoSuchProcess(error)) throw error }
    const wait = this.options.waitMs ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    const deadline = Date.now() + this.timeoutMs
    while (await this.isAlive(record.pid, signal) && Date.now() < deadline) await wait(Math.min(100, Math.max(1, deadline - Date.now())))
    if (await this.isAlive(record.pid, signal)) {
      await this.assertIdentity(record, signal)
      try { send(record.pid, 'SIGKILL') } catch (error: unknown) { if (!isNoSuchProcess(error)) throw error }
      const killDeadline = Date.now() + this.timeoutMs
      while (await this.isAlive(record.pid, signal) && Date.now() < killDeadline) await wait(Math.min(100, Math.max(1, killDeadline - Date.now())))
      if (await this.isAlive(record.pid, signal)) throw new Error('managed process remained alive after SIGKILL; record retained')
    }
    await this.remove(record)
    await this.removeReservation(record.id)
  }

  async load(id: string): Promise<ManagedProcessRecord> {
    assertSafeId(id)
    const path = assertManagedPath(this.layout, join(this.layout.runtimeDir, `${id}.pid.json`))
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat(); const current = await lstat(path)
      if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600 || !current.isFile() || current.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('managed process record identity or permissions invalid')
      const parsed: unknown = JSON.parse(await handle.readFile('utf8'))
      return await validateRecord(parsed, id, this.layout.root)
    } finally { await handle.close() }
  }

  private async remove(record: ManagedProcessRecord): Promise<void> { await removeAndSync(assertManagedPath(this.layout, join(this.layout.runtimeDir, `${record.id}.pid.json`)), this.layout.runtimeDir) }
  private async removeReservation(id: string): Promise<void> { await removeAndSync(assertManagedPath(this.layout, join(this.layout.runtimeDir, `${id}.pid.reserve`)), this.layout.runtimeDir) }
  private async isAlive(pid: number, signal = new AbortController().signal, env: Readonly<Record<string, string>> = {}): Promise<boolean> { return await (this.options.pidExists ?? ((value: number, childSignal: AbortSignal, childEnv: Readonly<Record<string, string>>) => defaultPidExists(value, this.layout.root, childSignal, childEnv)))(pid, signal, env) }
  private async assertIdentity(record: ManagedProcessRecord, signal: AbortSignal): Promise<void> { const current = await this.inspect(record.pid, record.executableRealPath, signal, {}); if (current.executableRealPath !== record.executableRealPath || current.startFingerprint !== record.startFingerprint) throw new Error('process identity mismatch') }
  private async cleanupChild(child: ChildProcess, identity: ProcessIdentity | undefined, env: Readonly<Record<string, string>>): Promise<void> {
    if (child.pid === undefined) return
    const send = this.options.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
    const wait = this.options.waitMs ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    const hasExited = () => child.exitCode !== null || child.signalCode !== null
    const cleanupSignal = new AbortController().signal
    const alive = async () => !hasExited() && await this.isAlive(child.pid as number, cleanupSignal, env)
    if (hasExited() || !(await this.isAlive(child.pid, cleanupSignal, env))) return
    if (identity !== undefined) {
      const current = await this.inspect(child.pid, identity.executableRealPath, new AbortController().signal, env)
      if (current.executableRealPath !== identity.executableRealPath || current.startFingerprint !== identity.startFingerprint) throw new Error('cleanup process identity mismatch')
      try { send(child.pid, 'SIGTERM') } catch (error: unknown) { if (!isNoSuchProcess(error)) throw error }
    } else {
      if (typeof child.kill !== 'function') throw new Error('cannot safely terminate unverified child without a child handle')
      try {
        if (!child.kill('SIGTERM')) throw new Error('child handle rejected SIGTERM')
      } catch (error: unknown) { throw error }
    }
    const deadline = Date.now() + this.timeoutMs
    while (await alive() && Date.now() < deadline) await wait(Math.min(100, Math.max(1, deadline - Date.now())))
    if (await alive()) {
      if (identity === undefined) throw new Error('unverified spawned process remained alive after SIGTERM')
      const current = await this.inspect(child.pid, identity.executableRealPath, new AbortController().signal, env)
      if (current.executableRealPath !== identity.executableRealPath || current.startFingerprint !== identity.startFingerprint) throw new Error('cleanup process identity mismatch')
      try { send(child.pid, 'SIGKILL') } catch (error: unknown) { if (!isNoSuchProcess(error)) throw error }
      const killDeadline = Date.now() + this.timeoutMs
      while (await alive() && Date.now() < killDeadline) await wait(Math.min(100, Math.max(1, killDeadline - Date.now())))
      if (await alive()) throw new Error('spawned process remained alive after cleanup SIGKILL')
    }
  }
  private async inspect(pid: number, executable: string, signal: AbortSignal, env: Readonly<Record<string, string>>): Promise<ProcessIdentity> {
    if (this.options.inspect !== undefined) return this.options.inspect(pid, executable, signal, env)
    const inspectionOptions = { signal, cwd: this.layout.root, env: inspectionEnvironment(env) }
    const start = await execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], inspectionOptions)
    const startText = start.stdout.trim(); if (startText === '') throw new Error('process is not running')
    const command = await execFile('/bin/ps', ['-o', 'comm=', '-p', String(pid)], inspectionOptions)
    const commandText = command.stdout.trim(); const actual = await realpath(executable)
    let osExecutable: string | undefined = commandText.startsWith('/') ? commandText : undefined
    if (osExecutable === undefined) {
      const lsof = await execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], inspectionOptions)
      osExecutable = lsof.stdout.split('\n').find((line) => line.startsWith('n/'))?.slice(1)
    }
    if (osExecutable === undefined || await realpath(osExecutable) !== actual) throw new Error('process executable identity mismatch')
    return { executableRealPath: actual, startFingerprint: `${startText}\0${actual}` }
  }
  private async spawn(request: ProcessStartRequest): Promise<ChildProcess> {
    const child = this.options.spawnProcess?.(request) ?? spawn(request.executable, [...request.args], { cwd: request.cwd, env: { ...request.env }, shell: false, signal: request.signal, stdio: 'ignore' })
    if (typeof child.once === 'function') child.once('error', () => undefined)
    return child
  }
}

async function removeAndSync(path: string, directoryPath: string): Promise<void> { await rm(path, { force: true }); const directory = await open(directoryPath, constants.O_RDONLY); try { await directory.sync() } finally { await directory.close() } }
async function removeRecordIfOwned(layout: WorkspaceLayout, expected: ManagedProcessRecord): Promise<void> {
  const path = assertManagedPath(layout, join(layout.runtimeDir, `${expected.id}.pid.json`))
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error: unknown) {
    if (isNoSuchFile(error)) return
    throw error
  }
  let identity: { readonly dev: number; readonly ino: number }
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600 || !current.isFile() || current.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('managed process record identity or permissions invalid during rollback')
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'))
    const actual = await validateRecord(parsed, expected.id, layout.root)
    if (!sameRecord(actual, expected)) throw new Error('managed process record ownership changed during rollback')
    identity = { dev: opened.dev, ino: opened.ino }
  } finally { await handle.close() }
  const current = await lstat(path)
  if (!current.isFile() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('managed process record ownership changed during rollback')
  await rm(path)
  await syncManagedDirectory(layout.runtimeDir)
}
async function defaultPidExists(pid: number, cwd: string, signal: AbortSignal, env: Readonly<Record<string, string>>): Promise<boolean> { try { const result = await execFile('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { cwd, env: inspectionEnvironment(env), signal, shell: false }); return result.stdout.trim() !== '' && !result.stdout.includes('Z') } catch (error: unknown) { if (signal.aborted) throw error; return false } }
function assertSafeId(id: string): void { if (!SAFE_ID.test(id)) throw new Error('process id must be a safe opaque identifier') }
function isNoSuchProcess(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ESRCH' }
function isNoSuchFile(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT' }
function sameRecord(left: ManagedProcessRecord, right: ManagedProcessRecord): boolean { return left.id === right.id && left.pid === right.pid && left.executableRealPath === right.executableRealPath && left.startFingerprint === right.startFingerprint && left.workspaceRoot === right.workspaceRoot && left.startedAt === right.startedAt && left.purpose === right.purpose }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) { if (signal.reason instanceof Error) throw signal.reason; const error = new Error('process start aborted'); error.name = 'AbortError'; throw error } }
function isInside(root: string, target: string): boolean { const path = relative(root, target); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../')) }
function validateProcessEnvironment(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('process environment must be an explicit record')
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key.length === 0 || key.includes('=') || key.includes('\0') || value.includes('\0') || /^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|LD_PRELOAD|DYLD_|BASH_ENV|ENV|CDPATH)$/u.test(key)) throw new Error('process environment contains an unsafe ambient control')
    result[key] = value
  }
  return result
}
function inspectionEnvironment(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const safe = validateProcessEnvironment(env)
  return { ...safe, PATH: '/usr/bin:/bin', LC_ALL: 'C' }
}
async function validateRecord(input: unknown, id: string, workspaceRoot: string): Promise<ManagedProcessRecord> {
  if (typeof input !== 'object' || input === null) throw new Error('invalid managed process record')
  const record = input as Record<string, unknown>
  if (record.id !== id || typeof record.id !== 'string' || !SAFE_ID.test(record.id) || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.executableRealPath !== 'string' || !record.executableRealPath.startsWith('/') || typeof record.startFingerprint !== 'string' || !FINGERPRINT.test(record.startFingerprint) || !record.startFingerprint.endsWith(`\0${record.executableRealPath}`) || record.workspaceRoot !== workspaceRoot || typeof record.startedAt !== 'string' || new Date(record.startedAt).toISOString() !== record.startedAt || typeof record.purpose !== 'string' || record.purpose.length === 0 || await realpath(record.executableRealPath).catch(() => null) !== record.executableRealPath) throw new Error('invalid managed process record')
  return record as unknown as ManagedProcessRecord
}
