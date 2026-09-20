import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_FILES = 10
const MAX_TOTAL_BYTES = 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u

/** The real registry returns absolutePath and bytes; the optional fields keep
 * this helper compatible with the core's structural artifact snapshot port. */
export interface ApprovalArtifactSnapshot {
  readonly featureDirectory: string
  readonly artifacts: readonly ApprovalArtifactSnapshotFile[]
}

export interface ApprovalArtifactSnapshotFile {
  readonly path: string
  readonly absolutePath?: string
  readonly bytes?: number
  readonly sha256: string
}

export interface ApprovalArtifactRegistry {
  snapshot(): ApprovalArtifactSnapshot | Promise<ApprovalArtifactSnapshot>
}

export interface ApprovalArtifactPendingApproval {
  readonly id: string
  readonly workspaceId: string
  readonly stateRevision: number
  readonly artifactHash: string
  readonly request: { readonly kind: 'requirements' | 'design' | 'migration'; readonly artifactHashes?: Readonly<Record<string, string>> }
}

export interface ApprovalArtifactPendingFeed {
  listPending(): readonly ApprovalArtifactPendingApproval[]
}

export interface ApprovalArtifactPreviewOptions {
  readonly workspaceRoot: string
  readonly artifactRegistry: ApprovalArtifactRegistry
  readonly approvals: ApprovalArtifactPendingFeed
  readonly readRevision: () => number | Promise<number>
  readonly requestedArtifactId?: string
}

export interface ApprovalArtifactPreviewFile {
  readonly path: string
  readonly content: string
}

export interface ApprovalArtifactPreview {
  readonly artifactHash: string
  readonly files: readonly ApprovalArtifactPreviewFile[]
}

/**
 * Reads only the fixed Spec Kit documents covered by a current requirements or
 * design approval. The descriptor checks and before/after snapshots make this
 * a text preview of the approved bytes, rather than an arbitrary file reader.
 */
export function readApprovalArtifactPreview(options: ApprovalArtifactPreviewOptions, action: { readonly artifactId: string }): Promise<ApprovalArtifactPreview>
export function readApprovalArtifactPreview(options: ApprovalArtifactPreviewOptions & { readonly requestedArtifactId: string }): Promise<ApprovalArtifactPreview>
export async function readApprovalArtifactPreview(options: ApprovalArtifactPreviewOptions, action?: { readonly artifactId: string }): Promise<ApprovalArtifactPreview> {
  assertOptions(options)
  const requestedArtifactId = options.requestedArtifactId ?? action?.artifactId
  if (typeof requestedArtifactId !== 'string' || !SHA256.test(requestedArtifactId)) throw new Error('artifact preview id must be a SHA-256 hash')
  const workspaceRoot = await realpath(options.workspaceRoot)
  const beforeRevision = await readRevision(options.readRevision)
  const before = await readSnapshot(options.artifactRegistry)
  const beforeFiles = await validateSnapshot(workspaceRoot, before)
  const pending = currentPending(options.approvals, workspaceRoot, beforeRevision, requestedArtifactId)
  if (pending.request.kind === 'migration') throw new Error('migration SQL uses its dedicated preview reader')
  const allowed = allowedPaths(pending.request.kind)
  const selected = beforeFiles.filter(file => allowed.has(file.path))
  if (selected.length === 0 || !selected.some(file => file.sha256 === pending.artifactHash)) throw new Error('artifact preview hash is not present in the current pending approval')
  assertPendingHashes(pending, selected, allowed)
  if (selected.length > MAX_FILES) throw new Error('artifact preview contains too many files')

  const files: ApprovalArtifactPreviewFile[] = []
  let totalBytes = 0
  for (const file of selected) {
    const content = await readVerifiedFile(file, before.featureDirectory)
    const bytes = Buffer.byteLength(content, 'utf8')
    totalBytes += bytes
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('artifact preview exceeds the size limit')
    files.push(Object.freeze({ path: workspaceRelativePath(workspaceRoot, file.absolutePath), content }))
  }

  const afterRevision = await readRevision(options.readRevision)
  const after = await readSnapshot(options.artifactRegistry)
  const afterFiles = await validateSnapshot(workspaceRoot, after)
  if (afterRevision !== beforeRevision || snapshotFingerprint(beforeFiles) !== snapshotFingerprint(afterFiles)) throw new Error('artifact preview snapshot changed during read')
  const afterPending = currentPending(options.approvals, workspaceRoot, afterRevision, requestedArtifactId)
  assertPendingHashes(afterPending, afterFiles.filter(file => allowed.has(file.path)), allowed)
  return Object.freeze({ artifactHash: pending.artifactHash, files: Object.freeze(files) })
}

interface VerifiedSnapshotFile { readonly path: string; readonly absolutePath: string; readonly bytes: number; readonly sha256: string }

async function validateSnapshot(workspaceRoot: string, snapshot: ApprovalArtifactSnapshot): Promise<readonly VerifiedSnapshotFile[]> {
  if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.featureDirectory !== 'string' || !Array.isArray(snapshot.artifacts)) throw new Error('artifact registry snapshot is invalid')
  if (snapshot.artifacts.length > MAX_FILES) throw new Error('artifact registry snapshot contains too many files')
  const featureDirectory = await canonicalFeatureDirectory(workspaceRoot, snapshot.featureDirectory)
  const seen = new Set<string>()
  const files: VerifiedSnapshotFile[] = []
  for (const candidate of snapshot.artifacts) {
    if (candidate === null || typeof candidate !== 'object' || typeof candidate.path !== 'string' || typeof candidate.sha256 !== 'string' || !SHA256.test(candidate.sha256)) throw new Error('artifact registry snapshot contains an invalid artifact')
    if (!KNOWN_PATHS.has(candidate.path) || seen.has(candidate.path)) throw new Error(`artifact registry snapshot contains an unsupported or duplicate path: ${candidate.path}`)
    seen.add(candidate.path)
    const expected = resolve(featureDirectory, candidate.path)
    if (!inside(featureDirectory, expected)) throw new Error(`artifact path escapes feature directory: ${candidate.path}`)
    await assertSafeParents(expected, featureDirectory, candidate.path)
    const absolutePath = candidate.absolutePath === undefined ? expected : resolve(candidate.absolutePath)
    if (absolutePath !== expected) throw new Error(`artifact path is not canonical: ${candidate.path}`)
    const bytes = candidate.bytes === undefined ? 0 : candidate.bytes
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_TOTAL_BYTES) throw new Error(`artifact byte count is invalid: ${candidate.path}`)
    files.push(Object.freeze({ path: candidate.path, absolutePath, bytes, sha256: candidate.sha256 }))
  }
  return Object.freeze(files.sort((left, right) => KNOWN_ORDER.indexOf(left.path as typeof KNOWN_ORDER[number]) - KNOWN_ORDER.indexOf(right.path as typeof KNOWN_ORDER[number])))
}

async function canonicalFeatureDirectory(workspaceRoot: string, featureDirectory: string): Promise<string> {
  if (featureDirectory.includes('\0')) throw new Error('feature directory contains NUL')
  const specs = resolve(workspaceRoot, 'specs')
  const specsDetails = await lstat(specs)
  if (specsDetails.isSymbolicLink() || !specsDetails.isDirectory()) throw new Error('workspace specs directory is unsafe')
  const canonicalSpecs = await realpath(specs)
  const details = await lstat(featureDirectory)
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('feature directory is unsafe')
  const canonical = await realpath(featureDirectory)
  if (!inside(canonicalSpecs, canonical) || canonical === canonicalSpecs) throw new Error('feature directory escapes workspace specs')
  if (canonical !== resolve(featureDirectory)) throw new Error('feature directory is not canonical')
  return canonical
}

async function readVerifiedFile(file: VerifiedSnapshotFile, featureDirectory: string): Promise<string> {
  await assertSafeParents(file.absolutePath, featureDirectory, file.path)
  const before = await lstat(file.absolutePath)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error(`artifact is not a private regular file: ${file.path}`)
  const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`artifact changed before read: ${file.path}`)
    if (opened.size > MAX_TOTAL_BYTES || (file.bytes > 0 && opened.size !== file.bytes)) throw new Error(`artifact size changed: ${file.path}`)
    const content = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat()
    const current = await lstat(file.absolutePath)
    await assertSafeParents(file.absolutePath, featureDirectory, file.path)
    if (!after.isFile() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(`artifact changed while reading: ${file.path}`)
    const hash = createHash('sha256').update(content).digest('hex')
    if (hash !== file.sha256) throw new Error(`artifact hash changed: ${file.path}`)
    return content
  } finally {
    await handle.close()
  }
}

async function assertSafeParents(path: string, root: string, relativePath: string): Promise<void> {
  let current = resolve(path, '..')
  while (true) {
    const details = await lstat(current)
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`artifact has an unsafe parent: ${relativePath}`)
    if (current === root) return
    const parent = resolve(current, '..')
    if (parent === current || !inside(root, parent)) throw new Error(`artifact escapes feature directory: ${relativePath}`)
    current = parent
  }
}

function currentPending(feed: ApprovalArtifactPendingFeed, workspaceRoot: string, revision: number, artifactHash: string): ApprovalArtifactPendingApproval {
  const workspacePending = feed.listPending().filter(item => item.workspaceId === workspaceRoot)
  if (workspacePending.some(item => item.artifactHash === artifactHash && item.stateRevision !== revision)) throw new Error('current pending approval revision is stale')
  if (workspacePending.length > 0 && !workspacePending.some(item => item.artifactHash === artifactHash)) throw new Error('current pending approval artifact hash mismatch')
  const candidates = workspacePending.filter(item => item.stateRevision === revision && item.artifactHash === artifactHash)
  if (candidates.length !== 1) throw new Error('current pending approval is missing or ambiguous')
  const pending = candidates[0]!
  if (pending.request.kind !== 'requirements' && pending.request.kind !== 'design') throw new Error('artifact preview approval kind is unsupported')
  return pending
}

function assertPendingHashes(pending: ApprovalArtifactPendingApproval, selected: readonly VerifiedSnapshotFile[], allowed: ReadonlySet<string>): void {
  const hashes = pending.request.artifactHashes
  if (hashes === undefined) return
  const entries = Object.entries(hashes)
  if (entries.length !== selected.length || entries.some(([path, hash]) => !allowed.has(path) || !SHA256.test(hash) || selected.find(file => file.path === path)?.sha256 !== hash)) throw new Error('pending approval artifact hashes do not match the current snapshot')
  if (!entries.some(([, hash]) => hash === pending.artifactHash)) throw new Error('pending approval artifact hash mismatch')
}

function allowedPaths(kind: 'requirements' | 'design'): ReadonlySet<string> {
  return new Set(kind === 'requirements' ? ['spec.md', 'clarification.md'] : KNOWN_ORDER.filter(path => path !== 'tasks.md'))
}

function readSnapshot(registry: ApprovalArtifactRegistry): Promise<ApprovalArtifactSnapshot> { return Promise.resolve(registry.snapshot()) }

async function readRevision(reader: ApprovalArtifactPreviewOptions['readRevision']): Promise<number> {
  const value = await reader()
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('coordinator revision is invalid')
  return value
}

function workspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const value = relative(workspaceRoot, absolutePath).replaceAll(sep, '/')
  if (value === '' || value === '..' || value.startsWith('../') || isAbsolute(value) || value.includes('\0')) throw new Error('artifact path escapes workspace')
  return value
}

function snapshotFingerprint(files: readonly VerifiedSnapshotFile[]): string {
  return files.map(file => `${file.path}\0${file.absolutePath}\0${file.bytes}\0${file.sha256}`).join('\0')
}

function inside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function assertOptions(value: ApprovalArtifactPreviewOptions): void {
  if (value === null || typeof value !== 'object') throw new TypeError('artifact preview options are required')
  if (typeof value.workspaceRoot !== 'string' || value.workspaceRoot.length === 0) throw new TypeError('artifact preview workspace root is required')
  if (typeof value.artifactRegistry?.snapshot !== 'function') throw new TypeError('artifact preview artifact registry is required')
  if (typeof value.approvals?.listPending !== 'function') throw new TypeError('artifact preview approval feed is required')
  if (typeof value.readRevision !== 'function') throw new TypeError('artifact preview revision reader is required')
}

const KNOWN_ORDER = Object.freeze([
  'spec.md', 'clarification.md', 'plan.md', 'tasks.md', 'research.md',
  'architecture.md', 'data-model.md', 'test-plan.md', 'decisions.md', 'contracts/openapi.yaml',
] as const)
const KNOWN_PATHS: ReadonlySet<string> = new Set(KNOWN_ORDER)
