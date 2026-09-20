import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const FEATURE_ARTIFACT_PATHS = Object.freeze([
  'spec.md', 'clarification.md', 'plan.md', 'tasks.md', 'research.md',
  'architecture.md', 'data-model.md', 'test-plan.md', 'decisions.md', 'contracts/openapi.yaml',
] as const)

export interface FeatureArtifact {
  readonly path: string
  readonly absolutePath: string
  readonly bytes: number
  readonly sha256: string
}

export interface FeatureArtifacts {
  readonly featureDirectory: string
  readonly artifacts: readonly FeatureArtifact[]
}

export interface ArtifactRegistryOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/** Resolves one Spec Kit feature and records exact bytes for its known artifacts. */
export class ArtifactRegistry {
  private readonly workspaceRoot: string
  private readonly environment: Readonly<Record<string, string | undefined>>

  constructor(workspaceRoot: string, options: ArtifactRegistryOptions = {}) {
    if (workspaceRoot.includes('\0')) throw new Error('workspace root contains NUL')
    this.workspaceRoot = resolve(workspaceRoot)
    this.environment = options.environment ?? process.env
  }

  async snapshot(): Promise<FeatureArtifacts> {
    const workspace = await realpath(this.workspaceRoot)
    const featureDirectory = await this.resolveFeatureDirectory(workspace)
    const artifacts: FeatureArtifact[] = []
    for (const path of FEATURE_ARTIFACT_PATHS) {
      const absolutePath = resolve(featureDirectory, path)
      if (!inside(featureDirectory, absolutePath)) throw new Error(`feature artifact escapes feature directory: ${path}`)
      await assertSafeParents(absolutePath, featureDirectory, path)
      const artifact = await snapshotFile(absolutePath, path)
      if (artifact !== undefined) artifacts.push(artifact)
    }
    return Object.freeze({ featureDirectory, artifacts: Object.freeze(artifacts) })
  }

  private async resolveFeatureDirectory(workspace: string): Promise<string> {
    const configured = this.environment.SPECIFY_FEATURE_DIRECTORY
    const featurePath = configured === undefined || configured.trim() === ''
      ? await featureFromJson(workspace)
      : configured
    if (featurePath === undefined || featurePath.trim() === '') throw new Error('active Spec Kit feature directory is missing')
    const candidate = isAbsolute(featurePath) ? resolve(featurePath) : resolve(workspace, featurePath)
    const specsRoot = await realpath(resolve(workspace, 'specs'))
    const candidateDetails = await lstat(candidate)
    if (candidateDetails.isSymbolicLink()) throw new Error('feature directory must not be a symbolic link')
    const canonical = await realpath(candidate)
    if (!inside(specsRoot, canonical) || canonical === specsRoot) throw new Error('feature directory must remain under workspace/specs')
    const details = await lstat(canonical)
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('feature directory must be a regular directory')
    return canonical
  }
}

async function featureFromJson(workspace: string): Promise<string | undefined> {
  const path = resolve(workspace, '.specify/feature.json')
  const details = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (details === undefined) return undefined
  if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) throw new Error('.specify/feature.json must be a private regular file')
  let content: string
  try { content = await readFile(path, 'utf8') } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new Error('.specify/feature.json is invalid JSON') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('.specify/feature.json must contain an object')
  const record = value as Record<string, unknown>
  for (const key of ['feature_directory', 'featureDirectory', 'directory', 'path']) {
    if (typeof record[key] === 'string') return record[key]
  }
  throw new Error('.specify/feature.json does not declare a feature directory')
}

async function assertSafeParents(path: string, root: string, relativePath: string): Promise<void> {
  let current = resolve(path, '..')
  while (true) {
    const details = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (details !== undefined && (details.isSymbolicLink() || !details.isDirectory())) throw new Error(`feature artifact has an unsafe parent: ${relativePath}`)
    if (current === root) return
    const parent = resolve(current, '..')
    if (parent === current || !inside(root, parent)) throw new Error(`feature artifact escapes feature directory: ${relativePath}`)
    current = parent
  }
}

async function snapshotFile(path: string, relativePath: string): Promise<FeatureArtifact | undefined> {
  let details: Awaited<ReturnType<typeof lstat>>
  try { details = await lstat(path) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) throw new Error(`feature artifact is not a private regular file: ${relativePath}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== details.dev || opened.ino !== details.ino) throw new Error(`feature artifact changed during snapshot: ${relativePath}`)
    const first = await sha256Handle(handle)
    const second = await sha256Handle(handle)
    const after = await handle.stat()
    const current = await lstat(path)
    if (first !== second || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(`feature artifact changed during snapshot: ${relativePath}`)
    return Object.freeze({ path: relativePath, absolutePath: path, bytes: opened.size, sha256: first })
  } finally { await handle.close() }
}

async function sha256Handle(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
