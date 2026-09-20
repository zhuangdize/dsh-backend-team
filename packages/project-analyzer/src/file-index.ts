import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { PolicyAction, PolicyContext, PolicyEngine } from '@dsh-backend-team/contracts'
import ignoreModule, { type Ignore } from 'ignore'
import { SecretFilter } from './secret-filter.js'

const DEFAULT_MAX_PATHS = 100_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const GITIGNORE_MAX_BYTES = 512 * 1024
const BINARY_SAMPLE_BYTES = 8 * 1024
const createIgnore = ignoreModule as unknown as () => Ignore

const HARD_EXCLUDED_DIRECTORIES = new Set([
  '.backend-team',
  '.specify',
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
])

export interface FileIndexOptions {
  readonly maxPaths?: number
}

/** Policy inputs required for a collection that may touch target-project files. */
export interface PolicyReadOptions {
  readonly policyEngine: PolicyEngine
  readonly policyContext: PolicyContext
}

export interface AuthorizedFileIndexOptions extends FileIndexOptions, PolicyReadOptions {}

export interface FileIndexWarning {
  readonly code: 'path-cap-reached'
  readonly message: string
}

export interface FileIndexResult {
  /** Workspace-relative POSIX paths, sorted in deterministic traversal order. */
  readonly paths: readonly string[]
  readonly warnings: readonly FileIndexWarning[]
}

interface IgnoreRule {
  readonly base: string
  readonly matcher: Ignore
}

interface DescriptorBoundPolicyEngine extends PolicyEngine {
  executeApprovedRead<T>(action: Extract<PolicyAction, { kind: 'read' }>, context: PolicyContext, operation: (handle: FileHandle) => Promise<T>): Promise<T>
}

function isWorkspaceRelativePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && !/^[A-Za-z]:/.test(path)
    && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  try {
    const root = realpathSync(workspaceRoot)
    if (!lstatSync(root).isDirectory()) throw new Error('not a directory')
    return root
  } catch {
    throw new Error('workspace root is unavailable or not a directory')
  }
}

function canonicalPolicyContext(root: string, policyContext: PolicyContext): PolicyContext {
  try {
    if (realpathSync(policyContext.workspace.root) !== root) throw new Error('workspace mismatch')
  } catch {
    throw new Error('policy workspace root must match the canonical collection root')
  }
  return { ...policyContext, workspace: { ...policyContext.workspace, root } }
}

function validateMaxPaths(options: FileIndexOptions): number {
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS
  if (!Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > DEFAULT_MAX_PATHS) {
    throw new Error(`maxPaths must be an integer between 1 and ${DEFAULT_MAX_PATHS}`)
  }
  return maxPaths
}

function isHardExcluded(relativePath: string): boolean {
  const segments = relativePath.split('/')
  if (segments.some((segment) => HARD_EXCLUDED_DIRECTORIES.has(segment))) return true
  return segments[0] === '.backend-team' && ['runtime', 'cache', 'artifacts', 'logs', 'locks', 'state'].includes(segments[1] ?? '')
}

function isIgnored(relativePath: string, rules: readonly IgnoreRule[]): boolean {
  return rules.some(({ base, matcher }) => {
    const fromRule = base === '.' ? relativePath : relative(base, relativePath).split(sep).join('/')
    return isWorkspaceRelativePath(fromRule) && matcher.ignores(fromRule)
  })
}

function readGitignore(directory: string, relativeDirectory: string): IgnoreRule | undefined {
  const path = resolve(directory, '.gitignore')
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.size > GITIGNORE_MAX_BYTES) return undefined
    return { base: relativeDirectory, matcher: createIgnore().add(readFileSync(path, 'utf8')) }
  } catch {
    return undefined
  }
}

function isBinaryFile(path: string): boolean {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const sample = Buffer.allocUnsafe(BINARY_SAMPLE_BYTES)
    const count = readSync(descriptor, sample, 0, sample.length, 0)
    return sample.subarray(0, count).includes(0)
  } catch {
    return true
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function hasDescriptorBoundRead(engine: PolicyEngine): engine is DescriptorBoundPolicyEngine {
  return typeof (engine as Partial<DescriptorBoundPolicyEngine>).executeApprovedRead === 'function'
}

function isWithin(root: string, target: string): boolean {
  const pathToTarget = relative(root, target)
  return pathToTarget === '' || (!pathToTarget.startsWith(`..${sep}`) && pathToTarget !== '..' && !pathToTarget.startsWith(sep))
}

async function listAuthorizedDirectory(path: string, root: string, options: PolicyReadOptions, context: PolicyContext): Promise<string[] | undefined> {
  let descriptor: number | undefined
  let directory: ReturnType<typeof opendirSync> | undefined
  try {
    const decision = await options.policyEngine.authorize({ kind: 'read', targetPath: path }, context)
    if (decision.effect !== 'allow') return undefined
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor)
    directory = opendirSync(path)
    const currentPath = realpathSync(path)
    const current = statSync(currentPath)
    if (!opened.isDirectory() || opened.nlink < 1 || !isWithin(root, currentPath)) return undefined
    if (opened.dev !== current.dev || opened.ino !== current.ino || opened.nlink !== current.nlink) return undefined
    const entries: string[] = []
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) entries.push(entry.name)
    const afterPath = realpathSync(path)
    const after = statSync(afterPath)
    if (!isWithin(root, afterPath) || opened.dev !== after.dev || opened.ino !== after.ino || opened.nlink !== after.nlink) return undefined
    return entries.sort()
  } catch {
    return undefined
  } finally {
    if (directory !== undefined) {
      try { directory.closeSync() } catch {}
    }
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
  }
}

async function readHandleText(handle: FileHandle, maxBytes: number): Promise<string | undefined> {
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > maxBytes) return undefined
    const content = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
      if (bytesRead === 0) return undefined
      offset += bytesRead
    }
    return content.toString('utf8')
  } catch {
    return undefined
  }
}

async function readGitignoreAuthorized(directory: string, relativeDirectory: string, options: PolicyReadOptions, context: PolicyContext): Promise<IgnoreRule | undefined> {
  const path = resolve(directory, '.gitignore')
  if (!hasDescriptorBoundRead(options.policyEngine)) return undefined
  try {
    const content = await options.policyEngine.executeApprovedRead({ kind: 'read', targetPath: path }, context, (handle) => readHandleText(handle, GITIGNORE_MAX_BYTES))
    return content === undefined ? undefined : { base: relativeDirectory, matcher: createIgnore().add(content) }
  } catch {
    return undefined
  }
}

async function isApprovedTextFile(path: string, options: PolicyReadOptions, context: PolicyContext): Promise<boolean> {
  if (!hasDescriptorBoundRead(options.policyEngine)) return false
  try {
    return await options.policyEngine.executeApprovedRead({ kind: 'read', targetPath: path }, context, async (handle) => {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) return false
      const sample = Buffer.allocUnsafe(BINARY_SAMPLE_BYTES)
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
      return !sample.subarray(0, bytesRead).includes(0)
    })
  } catch {
    return false
  }
}

/** Read-only, bounded filesystem evidence collection. Symlinks are never dereferenced or returned. */
export class FileIndex {
  static build(workspaceRoot: string, options: FileIndexOptions = {}): FileIndexResult {
    const root = canonicalWorkspaceRoot(workspaceRoot)
    const maxPaths = validateMaxPaths(options)

    const paths: string[] = []
    let truncated = false

    const visit = (directory: string, relativeDirectory: string, inheritedRules: readonly IgnoreRule[]): void => {
      if (truncated) return
      const gitignore = readGitignore(directory, relativeDirectory)
      const rules = gitignore ? [...inheritedRules, gitignore] : inheritedRules
      let entries: string[]
      try {
        entries = readdirSync(directory).sort()
      } catch {
        return
      }

      for (const entry of entries) {
        const relativePath = relativeDirectory === '.' ? entry : `${relativeDirectory}/${entry}`
        if (!isWorkspaceRelativePath(relativePath) || isHardExcluded(relativePath) || SecretFilter.isSensitivePath(relativePath) || isIgnored(relativePath, rules)) continue

        const absolutePath = resolve(directory, entry)
        let metadata: ReturnType<typeof lstatSync>
        try {
          metadata = lstatSync(absolutePath)
        } catch {
          continue
        }

        if (metadata.isSymbolicLink()) continue
        if (metadata.isDirectory()) {
          visit(absolutePath, relativePath, rules)
          if (truncated) return
          continue
        }
        if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES || isBinaryFile(absolutePath)) continue

        if (paths.length === maxPaths) {
          truncated = true
          return
        }
        paths.push(relativePath)
      }
    }

    visit(root, '.', [])
    return {
      paths,
      warnings: truncated ? [{ code: 'path-cap-reached', message: `File evidence was truncated at ${maxPaths} paths.` }] : [],
    }
  }

  /**
   * Policy-bound variant of {@link build}. A candidate is authorized before
   * its contents are sampled or it is emitted as evidence; deny and ask both
   * fail closed by omission.
   */
  static async buildAuthorized(workspaceRoot: string, options: AuthorizedFileIndexOptions): Promise<FileIndexResult> {
    const root = canonicalWorkspaceRoot(workspaceRoot)
    const maxPaths = validateMaxPaths(options)
    const context = canonicalPolicyContext(root, options.policyContext)
    if (!hasDescriptorBoundRead(options.policyEngine)) return { paths: [], warnings: [] }
    const paths: string[] = []
    let truncated = false

    const visit = async (directory: string, relativeDirectory: string, inheritedRules: readonly IgnoreRule[]): Promise<void> => {
      if (truncated) return
      const entries = await listAuthorizedDirectory(directory, root, options, context)
      if (entries === undefined) return
      const gitignore = entries.includes('.gitignore') ? await readGitignoreAuthorized(directory, relativeDirectory, options, context) : undefined
      const rules = gitignore ? [...inheritedRules, gitignore] : inheritedRules

      for (const entry of entries) {
        const relativePath = relativeDirectory === '.' ? entry : `${relativeDirectory}/${entry}`
        if (!isWorkspaceRelativePath(relativePath) || isHardExcluded(relativePath) || SecretFilter.isSensitivePath(relativePath) || isIgnored(relativePath, rules)) continue

        const absolutePath = resolve(directory, entry)
        let metadata: ReturnType<typeof lstatSync>
        try {
          metadata = lstatSync(absolutePath)
        } catch {
          continue
        }
        if (metadata.isSymbolicLink()) continue
        if (metadata.isDirectory()) {
          await visit(absolutePath, relativePath, rules)
          if (truncated) return
          continue
        }
        if (!metadata.isFile() || !await isApprovedTextFile(absolutePath, options, context)) continue
        if (paths.length === maxPaths) {
          truncated = true
          return
        }
        paths.push(relativePath)
      }
    }

    await visit(root, '.', [])
    return {
      paths,
      warnings: truncated ? [{ code: 'path-cap-reached', message: `File evidence was truncated at ${maxPaths} paths.` }] : [],
    }
  }
}
