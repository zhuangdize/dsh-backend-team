import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { dirname, join, relative } from 'node:path'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { ConcurrentChangeGuard } from './concurrent-change-guard.js'
import { resolveWorkspacePath, type FileSnapshot } from './file-snapshot.js'

export interface AgentFileEdit {
  readonly path: string
  readonly bytes: string | Uint8Array
  readonly mode?: number
}

export interface AgentEditWriterInput {
  readonly path: string
  readonly bytes: Uint8Array
  readonly before: FileSnapshot
  readonly mode?: number
}

export type AgentEditWriter = (input: AgentEditWriterInput) => Promise<void>

export interface OwnedPatch {
  readonly path: string
  readonly before: FileSnapshot
  readonly after: FileSnapshot
  readonly beforeSha256?: string
  readonly afterSha256?: string
  readonly unifiedPatch: string
  status: 'applied' | 'rolled-back' | 'rollback-refused'
  rollback: { status: 'not-attempted' | 'rolled-back' | 'refused'; reason?: string }
}

export interface RollbackEvidence {
  readonly path: string
  readonly status: 'rolled-back' | 'refused'
  readonly afterSha256?: string
  readonly restoredSha256?: string
  readonly reason?: string
}

export interface PatchTrackerOptions {
  readonly workspaceRoot: string
  readonly runId: string
  readonly maxPatchBytes?: number
  readonly gitStatus?: string
}

export class PatchTracker {
  private readonly options: PatchTrackerOptions

  constructor(options: PatchTrackerOptions) {
    if (!/^[A-Za-z0-9._-]+$/u.test(options.runId)) throw new Error('patch run id is unsafe')
    this.options = options
  }

  async begin(paths: readonly string[]): Promise<PatchSession> {
    if (paths.length === 0) throw new Error('patch ownership requires at least one path')
    const guard = new ConcurrentChangeGuard(this.options)
    const snapshots = new Map<string, FileSnapshot>()
    for (const path of paths) {
      const snapshot = await guard.capture(path)
      if (snapshots.has(snapshot.path)) throw new Error(`duplicate patch path: ${snapshot.path}`)
      snapshots.set(snapshot.path, snapshot)
    }
    const workspaceRoot = await realpath(this.options.workspaceRoot)
    return new PatchSession(workspaceRoot, this.options, guard, snapshots)
  }
}

export class PatchSession {
  private readonly accepted = new Map<string, FileSnapshot>()
  private readonly patches: OwnedPatch[] = []
  private readonly maxPatchBytes: number
  private nextAttempt = 1

  constructor(private readonly workspaceRoot: string, private readonly options: PatchTrackerOptions, private readonly guard: ConcurrentChangeGuard, snapshots: Map<string, FileSnapshot>) {
    this.accepted = new Map(snapshots)
    this.maxPatchBytes = options.maxPatchBytes ?? 10 * 1024 * 1024
  }

  async captureAgentEdit(edit: AgentFileEdit): Promise<OwnedPatch> {
    return this.captureAgentEditWithWriter(edit, async ({ path, bytes, before, mode }) => {
      await writeOwnedFile(this.workspaceRoot, path, bytes, before, mode, before.state === 'present' ? snapshotBytes(before) : undefined)
    })
  }

  async captureAgentEditWithWriter(edit: AgentFileEdit, writer: AgentEditWriter): Promise<OwnedPatch> {
    const path = relative(this.workspaceRoot, resolveWorkspacePath(this.workspaceRoot, edit.path)).replaceAll('\\', '/')
    const expected = this.accepted.get(path)
    if (expected === undefined) throw new Error(`file is not owned by this patch session: ${path}`)
    const bytes = typeof edit.bytes === 'string' ? Buffer.from(edit.bytes) : Buffer.from(edit.bytes)
    if (bytes.byteLength > this.maxPatchBytes) throw new Error(`agent edit exceeds patch limit: ${path}`)
    await this.guard.assertUnchanged(expected)
    const before = await this.guard.capture(path)
    if (!sameSnapshot(expected, before)) throw new Error(`concurrent change detected for ${path}`)
    const sequence = this.nextAttempt++
    await preparePatchEvidence(this.workspaceRoot, this.options.runId, sequence, path, before)
    let writeAttempted = false
    try {
      writeAttempted = true
      await writer({ path, bytes: bytes.slice(), before: cloneSnapshot(before), ...(edit.mode === undefined ? {} : { mode: edit.mode }) })
      const after = await this.guard.capture(path)
      if (after.state !== 'present' || after.sha256 !== createHash('sha256').update(bytes).digest('hex') || (before.state === 'present' && !sameIdentity(before.identity, after.identity))) throw new Error(`agent write verification failed: ${path}`)
      const patch: OwnedPatch = {
        path, before, after, ...(before.sha256 === undefined ? {} : { beforeSha256: before.sha256 }), ...(after.sha256 === undefined ? {} : { afterSha256: after.sha256 }),
        unifiedPatch: unifiedPatch(path, snapshotBytes(before), bytes), status: 'applied', rollback: { status: 'not-attempted' },
      }
      await finalizePatchEvidence(this.workspaceRoot, this.options.runId, sequence, patch)
      this.patches.push(patch)
      this.accepted.set(path, after)
      return clonePatch(patch)
    } catch (error: unknown) {
      if (writeAttempted) {
        try {
          await rollbackFailedAgentWrite(this.workspaceRoot, path, before, this.guard)
        } catch (rollbackError: unknown) {
          throw new AggregateError([error, rollbackError], `agent edit failed and rollback was refused: ${path}`)
        }
      }
      throw error
    }
  }

  async capture(path: string, bytes: string | Uint8Array, mode?: number): Promise<OwnedPatch> {
    return this.captureAgentEdit({ path, bytes, ...(mode === undefined ? {} : { mode }) })
  }

  async rollbackOwnChanges(): Promise<readonly RollbackEvidence[]> {
    const evidence: RollbackEvidence[] = []
    for (const patch of [...this.patches].reverse()) {
      if (patch.status !== 'applied') continue
      try {
        await this.guard.assertUnchanged(patch.after)
        const beforeBytes = snapshotBytes(patch.before)
        if (patch.before.state === 'missing') await removeOwnedFile(this.workspaceRoot, patch.path, patch.after)
        else await writeOwnedFile(this.workspaceRoot, patch.path, beforeBytes, patch.after, patch.before.mode)
        const restored = await this.guard.capture(patch.path)
        if (!sameSnapshot(patch.before, restored)) throw new Error('restored file does not match before-state')
        patch.status = 'rolled-back'; patch.rollback = { status: 'rolled-back' }
        evidence.push({ path: patch.path, status: 'rolled-back', ...(patch.after.sha256 === undefined ? {} : { afterSha256: patch.after.sha256 }), ...(restored.sha256 === undefined ? {} : { restoredSha256: restored.sha256 }) })
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        patch.status = 'rollback-refused'; patch.rollback = { status: 'refused', reason }
        evidence.push({ path: patch.path, status: 'refused', ...(patch.after.sha256 === undefined ? {} : { afterSha256: patch.after.sha256 }), reason })
      }
    }
    return evidence
  }

  snapshot(): readonly FileSnapshot[] { return Object.freeze([...this.accepted.values()].map(cloneSnapshot)) }
  patchesSnapshot(): readonly OwnedPatch[] { return Object.freeze(this.patches.map(clonePatch)) }
}

async function rollbackFailedAgentWrite(root: string, path: string, before: FileSnapshot, guard: ConcurrentChangeGuard): Promise<void> {
  const current = await guard.capture(path)
  if (sameSnapshot(before, current)) return
  if (before.state === 'missing') {
    if (current.state === 'present') await removeOwnedFile(root, path, current)
    return
  }
  if (current.state !== 'present' || !sameIdentity(before.identity, current.identity)) throw new Error(`concurrent change detected for ${path}`)
  await writeOwnedFile(root, path, snapshotBytes(before), current, before.mode)
  const restored = await guard.capture(path)
  if (!sameSnapshot(before, restored)) throw new Error(`restored file does not match before-state: ${path}`)
}

async function writeOwnedFile(root: string, path: string, data: Uint8Array, expected: FileSnapshot, mode?: number, restoreData?: Uint8Array): Promise<void> {
  const target = resolveWorkspacePath(root, path)
  const parent = await ensureParent(root, dirname(target))
  await assertStableParent(root, parent)
  const flags = constants.O_NOFOLLOW ?? 0
  if (expected.state === 'missing') {
    let handle
    let openedIdentity: { readonly dev: number; readonly ino: number } | undefined
    try {
      handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | flags, mode ?? 0o644)
      const opened = await handle.stat()
      openedIdentity = { dev: opened.dev, ino: opened.ino }
      if (!opened.isFile() || opened.nlink !== 1 || await realpath(target) !== target || await realpath(parent) !== parent) throw new Error(`concurrent parent replacement detected for ${path}`)
      await handle.writeFile(data); await handle.sync(); await assertStableParent(root, parent)
    } catch (error: unknown) {
      if (handle !== undefined && openedIdentity !== undefined) {
        let cleanupError: unknown
        try { await removeCreatedIfOwned(target, openedIdentity) } catch (error) { cleanupError = error }
        try {
          const afterCleanup = await handle.stat()
          if (afterCleanup.nlink !== 0 && cleanupError === undefined) cleanupError = new Error(`created inode remains linked for ${path}`)
          if (afterCleanup.nlink === 0) cleanupError = undefined
        } catch (verificationError: unknown) {
          cleanupError ??= verificationError
        }
        if (cleanupError !== undefined) throw new AggregateError([error, cleanupError], `new file write failed; cleanup-refused: ${path}`)
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`concurrent change detected for ${path}`)
      throw error
    } finally { await handle?.close().catch(() => undefined) }
    return
  }
  if (expected.realPath === undefined || expected.identity === undefined) throw new Error(`present snapshot is incomplete: ${path}`)
  let handle
  try {
    handle = await open(target, constants.O_RDWR | flags)
    const current = await handle.stat()
    if (!current.isFile() || current.nlink !== 1 || current.dev !== expected.identity.dev || current.ino !== expected.identity.ino || await realpath(target) !== target) throw new Error(`concurrent change detected for ${path}`)
    await handle.truncate(0); await handle.writeFile(data); await handle.sync()
  } catch (error: unknown) {
    if (handle !== undefined && restoreData !== undefined) {
      try {
        const current = await handle.stat()
        if (current.isFile() && current.nlink === 1 && current.dev === expected.identity.dev && current.ino === expected.identity.ino) { await handle.truncate(0); await handle.writeFile(restoreData); await handle.sync() }
      } catch { /* preserve the original write error; the durable before snapshot remains available */ }
    }
    if (['ELOOP', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error(`concurrent change detected for ${path}`)
    throw error
  } finally { await handle?.close().catch(() => undefined) }
  await assertStableParent(root, parent)
}

async function removeOwnedFile(root: string, path: string, expected: FileSnapshot): Promise<void> {
  if (expected.state !== 'present' || expected.identity === undefined) throw new Error(`owned after-state is incomplete: ${path}`)
  const target = resolveWorkspacePath(root, path)
  let details
  try { details = await lstat(target) } catch (error: unknown) { throw new Error(`concurrent change detected for ${path}`, { cause: error }) }
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || details.dev !== expected.identity.dev || details.ino !== expected.identity.ino || await realpath(target) !== target) throw new Error(`concurrent change detected for ${path}`)
  await unlink(target)
}

async function removeCreatedIfOwned(path: string, identity: { readonly dev: number; readonly ino: number }): Promise<void> {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink() || details.dev !== identity.dev || details.ino !== identity.ino) return
  await unlink(path)
}

async function ensureParent(root: string, requested: string): Promise<string> {
  const rest = relative(root, requested)
  if (rest === '..' || rest.startsWith('../') || rest.startsWith('..\\')) throw new Error('patch parent escapes workspace')
  let current = root
  for (const segment of rest.split('/').filter(Boolean)) {
    current = join(current, segment)
    try { const details = await lstat(current); if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('patch parent is unsafe') }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(current, { mode: 0o755 }); const details = await lstat(current); if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('patch parent is unsafe') }
  }
  return current
}

async function preparePatchEvidence(root: string, runId: string, sequence: number, path: string, before: FileSnapshot): Promise<void> {
  const directory = join(root, '.backend-team', 'runs', runId, 'patches')
  await ensureParent(root, directory)
  await assertStableParent(root, directory)
  const stem = evidenceStem(sequence, path)
  const metadata = JSON.stringify({ status: 'prepared', path, before: serializableSnapshot(before) })
  await writeExclusive(join(directory, `${stem}.json`), Buffer.from(`${metadata}\n`))
  if (before.state === 'present') await writeExclusive(join(directory, `${stem}.before.gz`), before.compressedBytes)
}

async function finalizePatchEvidence(root: string, runId: string, sequence: number, patch: OwnedPatch): Promise<void> {
  const directory = join(root, '.backend-team', 'runs', runId, 'patches')
  await assertStableParent(root, directory)
  const stem = evidenceStem(sequence, patch.path)
  await writeExclusive(join(directory, `${stem}.after.gz`), patch.after.compressedBytes)
  await writeExclusive(join(directory, `${stem}.complete`), Buffer.from(`${JSON.stringify({ status: 'applied', path: patch.path, after: serializableSnapshot(patch.after), unifiedPatch: patch.unifiedPatch })}\n`))
}

function evidenceStem(sequence: number, path: string): string {
  const encoded = Buffer.from(path).toString('base64url')
  if (encoded.length > 512) throw new Error('patch evidence path is too long')
  return `${String(sequence).padStart(4, '0')}-${encoded}`
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

function serializableSnapshot(snapshot: FileSnapshot): Record<string, unknown> {
  return { path: snapshot.path, state: snapshot.state, realPath: snapshot.realPath, bytes: snapshot.bytes, sha256: snapshot.sha256, mode: snapshot.mode, identity: snapshot.identity, gitStatus: snapshot.gitStatus }
}

function snapshotBytes(snapshot: FileSnapshot): Buffer { return snapshot.state === 'missing' ? Buffer.alloc(0) : gunzipSync(Buffer.from(snapshot.compressedBytes)) }

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.state === right.state && left.path === right.path && left.realPath === right.realPath && left.bytes === right.bytes && left.sha256 === right.sha256 && left.mode === right.mode && left.identity?.dev === right.identity?.dev && left.identity?.ino === right.identity?.ino && left.identity?.nlink === right.identity?.nlink
}

function sameIdentity(left: FileSnapshot['identity'], right: FileSnapshot['identity']): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
}

function cloneSnapshot(snapshot: FileSnapshot): FileSnapshot {
  return { ...snapshot, ...(snapshot.identity === undefined ? {} : { identity: { ...snapshot.identity } }), compressedBytes: snapshot.compressedBytes.slice() }
}

function clonePatch(patch: OwnedPatch): OwnedPatch {
  return { ...patch, before: cloneSnapshot(patch.before), after: cloneSnapshot(patch.after), rollback: { ...patch.rollback } }
}

async function assertStableParent(root: string, parent: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  const canonicalParent = await realpath(parent)
  const relativeParent = relative(canonicalRoot, canonicalParent)
  if (canonicalParent !== parent || relativeParent.startsWith('..') || relativeParent.includes('\\')) throw new Error('patch parent changed or escapes workspace')
}

function unifiedPatch(path: string, before: Uint8Array, after: Uint8Array): string {
  const left = Buffer.from(before).toString('utf8').split('\n')
  const right = Buffer.from(after).toString('utf8').split('\n')
  const body = [...left.filter((line) => line.length > 0).map((line) => `-${line}`), ...right.filter((line) => line.length > 0).map((line) => `+${line}`)].join('\n')
  return `--- a/${path}\n+++ b/${path}\n@@ -1,${left.length} +1,${right.length} @@\n${body}\n`
}
