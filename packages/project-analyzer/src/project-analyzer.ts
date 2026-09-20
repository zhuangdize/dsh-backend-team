import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { CommandRunner, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { CommandDetector } from './detectors/command.js'
import { DatabaseDetector } from './detectors/database.js'
import { FrameworkDetector } from './detectors/framework.js'
import { NodeDetector, createDetectorContext, evidence } from './detectors/node.js'
import { NodeRuntimeDetector } from './detectors/node-version.js'
import { PackageManagerDetector } from './detectors/package-manager.js'
import { TestDetector } from './detectors/test.js'
import type { DetectedCommand } from './detectors/command.js'
import { FileIndex } from './file-index.js'
import { GitBaseline } from './git-baseline.js'
import type { GitBaselineSnapshot } from './git-baseline.js'
import { ManifestReader } from './manifest-reader.js'
import type { PackageManifest } from './manifest-reader.js'
import { ProjectProfileSchema } from './project-profile.js'
import type { ProjectProfile } from './project-profile.js'
import { SecretFilter } from './secret-filter.js'
import { ServiceBoundaryResolver } from './service-boundary.js'
import type { ServiceBoundaryDecision } from './service-boundary.js'
import { StrategySelector } from './strategy-selector.js'
import type { ProjectStrategy } from './strategy-selector.js'
import { VerificationBaseline } from './verification-baseline.js'
import type { VerificationPlanEntry } from './verification-baseline.js'

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const textExtensions = new Set(['.cjs', '.cts', '.js', '.json', '.mjs', '.mts', '.prisma', '.ts', '.tsx'])
const textBasenames = new Set(['.nvmrc', '.node-version', '.tool-versions', 'tsconfig.json'])

export interface ProjectAnalyzerOptions {
  readonly workspace: WorkspaceLayout
  /** Injected Git runner; omitted by default so analysis cannot execute a command. */
  readonly gitRunner?: CommandRunner
  /** Writes only .backend-team/project-profile.json using a temporary file + rename. */
  readonly persistProfile?: boolean
}

export interface ProjectAnalysis {
  readonly profile: ProjectProfile
  readonly strategy: ProjectStrategy
  /** Boundary decision is kept alongside the profile so callers can present an explicit choice. */
  readonly serviceBoundaryDecision?: ServiceBoundaryDecision
  readonly commands: readonly DetectedCommand[]
  readonly verificationPlan: readonly VerificationPlanEntry[]
  readonly gitBaseline?: GitBaselineSnapshot
}

function extension(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot)
}

function isTextEvidencePath(path: string): boolean {
  const basename = path.split('/').at(-1) ?? ''
  return textBasenames.has(basename) || textExtensions.has(extension(path))
}

function readTextEvidence(root: string, paths: readonly string[]): ReadonlyMap<string, string> {
  const canonicalRoot = realpathSync(root)
  const entries: [string, string][] = []
  for (const path of paths) {
    if (!isTextEvidencePath(path) || SecretFilter.isSensitivePath(path)) continue
    const absolute = resolve(canonicalRoot, path)
    const fromRoot = relative(canonicalRoot, absolute)
    if (fromRoot === '..' || fromRoot.startsWith('../')) continue
    let descriptor: number | undefined
    try {
      descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
      const metadata = fstatSync(descriptor)
      if (!metadata.isFile() || metadata.size > MAX_TEXT_BYTES) continue
      const content = Buffer.alloc(metadata.size)
      let offset = 0
      while (offset < content.length) {
        const count = readSync(descriptor, content, offset, content.length - offset, offset)
        if (count === 0) throw new Error('text evidence changed while being read')
        offset += count
      }
      entries.push([path, content.toString('utf8')])
    } catch {
      // FileIndex remains authoritative; unavailable evidence is omitted.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }
  return new Map(entries.sort(([left], [right]) => left.localeCompare(right)))
}

function isSampleOrTestEvidence(path: string): boolean {
  return path.split('/').some(segment => ['test', 'tests', '__tests__', 'fixtures', '__fixtures__', 'templates', 'examples'].includes(segment)) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
}

function readManifests(root: string, paths: readonly string[]): ReadonlyMap<string, PackageManifest> {
  const reader = new ManifestReader(root)
  const entries: [string, PackageManifest][] = []
  for (const path of paths) {
    if (!path.endsWith('package.json') || isSampleOrTestEvidence(path)) continue
    const result = reader.readPackage(path)
    if (result.ok) entries.push([path, result.manifest])
  }
  return new Map(entries.sort(([left], [right]) => left.localeCompare(right)))
}

function kindFor(paths: readonly string[], manifests: ReadonlyMap<string, PackageManifest>): ProjectProfile['projectKind'] {
  const meaningful = paths.filter((path) => path.split('/').at(-1) !== '.gitkeep')
  if (meaningful.length === 0) return 'empty'
  if (manifests.size === 0) return 'non-node'
  return manifests.get('package.json')?.workspaces === undefined ? 'node-service' : 'monorepo'
}

function technologies(
  node: Awaited<ReturnType<NodeDetector['collect']>>,
  frameworks: Awaited<ReturnType<FrameworkDetector['collect']>>,
  databases: Awaited<ReturnType<DatabaseDetector['collect']>>,
  packageManagers: Awaited<ReturnType<PackageManagerDetector['collect']>>,
  tests: Awaited<ReturnType<TestDetector['collect']>>,
): ProjectProfile['technologies'] {
  const categorized = <T extends string>(values: readonly { readonly value: T; readonly confidence: 'high' | 'medium' | 'low'; readonly evidence: readonly ProjectProfile['technologies'][number]['evidence'][number][]; readonly conflicts: readonly ProjectProfile['technologies'][number]['conflicts'][number][] }[], category: ProjectProfile['technologies'][number]['category']) => values.map((technology) => ({
    ...technology,
    category,
    evidence: [...technology.evidence],
    conflicts: [...technology.conflicts],
  }))
  return [
    ...categorized(node.filter((technology) => technology.value === 'node'), 'runtime'),
    ...categorized(node.filter((technology) => technology.value !== 'node'), 'language'),
    ...categorized(frameworks, 'framework'),
    ...categorized(databases.orms, 'orm'),
    ...categorized(databases.databases, 'database'),
    ...categorized(packageManagers, 'other'),
    ...categorized(tests, 'other'),
  ]
}

function stateDirectory(root: string, teamDir: string): string {
  const expected = resolve(root, '.backend-team')
  if (resolve(teamDir) !== expected) throw new Error('profile persistence is restricted to the workspace .backend-team directory')
  try {
    if (lstatSync(expected).isSymbolicLink()) throw new Error('profile persistence directory may not be a symlink')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(expected, { recursive: true })
  const metadata = lstatSync(expected)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('profile persistence directory may not be a directory or symlink')
  const canonicalRoot = realpathSync(root)
  const canonicalTeamDir = realpathSync(expected)
  if (relative(canonicalRoot, canonicalTeamDir) !== '.backend-team') throw new Error('profile persistence escapes the workspace')
  return canonicalTeamDir
}

function persistedProfile(profile: ProjectProfile): ProjectProfile {
  const runtime = profile.nodeRuntime
  if (runtime === null) return profile
  const range = runtime.status === 'selected' && runtime.exactVersion !== undefined ? runtime.exactVersion : 'unresolved'
  return {
    ...profile,
    nodeRuntime: { ...runtime, declarations: runtime.declarations.map((declaration) => ({ ...declaration, range })) },
  }
}

function createTemporaryStateFile(directory: string): { readonly path: string; readonly descriptor: number } {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = resolve(directory, `.project-profile-${randomBytes(24).toString('hex')}.tmp`)
    try {
      return { path, descriptor: openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('could not allocate an exclusive temporary profile file')
}

function assertProfileOutputIsNotSymlink(output: string): void {
  try {
    if (lstatSync(output).isSymbolicLink()) throw new Error('profile persistence output may not be a symlink')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function persist(root: string, teamDir: string, profile: ProjectProfile): void {
  const canonicalTeamDir = stateDirectory(root, teamDir)
  const output = resolve(canonicalTeamDir, 'project-profile.json')
  assertProfileOutputIsNotSymlink(output)
  const temporary = createTemporaryStateFile(canonicalTeamDir)
  const content = Buffer.from(`${JSON.stringify(persistedProfile(profile), null, 2)}\n`, 'utf8')
  try {
    let offset = 0
    while (offset < content.length) offset += writeSync(temporary.descriptor, content, offset, content.length - offset)
    fsyncSync(temporary.descriptor)
    closeSync(temporary.descriptor)
    if (stateDirectory(root, teamDir) !== canonicalTeamDir) throw new Error('profile persistence directory changed during write')
    assertProfileOutputIsNotSymlink(output)
    renameSync(temporary.path, output)
  } catch (error) {
    try { closeSync(temporary.descriptor) } catch {}
    try { unlinkSync(temporary.path) } catch {}
    throw error
  }
}

/** Read-only composition of inert project evidence. It never imports target code or executes target scripts. */
export class ProjectAnalyzer {
  constructor(private readonly options: ProjectAnalyzerOptions) {}

  async analyze(requestedServicePath?: string): Promise<ProjectAnalysis> {
    const index = FileIndex.build(this.options.workspace.root)
    const manifests = readManifests(this.options.workspace.root, index.paths)
    const context = createDetectorContext({ paths: index.paths, manifests, textFiles: readTextEvidence(this.options.workspace.root, index.paths) })
    const applicationContext = createDetectorContext({ paths: context.paths.filter(path => !isSampleOrTestEvidence(path)), manifests, textFiles: new Map([...context.textFiles].filter(([path]) => !isSampleOrTestEvidence(path))) })
    const [node, nodeRuntime, packageManagers, frameworks, databases, tests, commands] = await Promise.all([
      new NodeDetector().collect(context),
      new NodeRuntimeDetector().collect(context),
      new PackageManagerDetector().collect(context),
      new FrameworkDetector().collect(applicationContext),
      new DatabaseDetector().collect(applicationContext),
      new TestDetector().collect(context),
      new CommandDetector().collect(context),
    ])
    const projectKind = kindFor(context.paths, manifests)
    const boundaryDecision = projectKind === 'node-service' || projectKind === 'monorepo'
      ? await new ServiceBoundaryResolver({ workspace: this.options.workspace, context }).resolve(requestedServicePath)
      : undefined
    const gitBaseline = this.options.gitRunner === undefined ? undefined : await new GitBaseline({ runner: this.options.gitRunner, cwd: this.options.workspace.root }).capture()
    const baselineIssues: ProjectProfile['baselineIssues'] = [
      ...commands.map((command) => ({
        code: 'verification-unverified',
        severity: 'info' as const,
        message: 'A detected project command remains unverified.',
        evidence: [...command.evidence],
      })),
      ...(boundaryDecision?.status === 'needs-user-selection'
        ? [{
            code: 'service-boundary-ambiguous',
            severity: 'blocking' as const,
            message: 'Multiple backend service boundaries require user selection.',
            evidence: boundaryDecision.candidates.flatMap((candidate) => candidate.evidence),
          }]
        : []),
      ...(gitBaseline?.repository
        ? gitBaseline.entries.map((entry) => ({
            code: 'git-worktree-change',
            severity: entry.states.includes('conflicted') ? 'blocking' as const : 'warning' as const,
            message: 'Git worktree change captured as read-only baseline evidence.',
            evidence: [evidence('git', entry.path, 'captures a Git worktree change', `git:${entry.path}:${entry.states.join(',')}`)],
          }))
        : []),
    ]
    const profile = ProjectProfileSchema.parse({
      schemaVersion: 1,
      projectKind,
      exists: projectKind !== 'empty',
      technologies: technologies(node, frameworks, databases, packageManagers, tests),
      nodeRuntime: manifests.size === 0 ? null : nodeRuntime,
      serviceBoundary: boundaryDecision?.status === 'selected' ? boundaryDecision.boundary : null,
      baselineIssues,
      databaseRecommendation: databases.databases.length > 0 ? { target: 'preserve-existing', automation: 'automatic' } : null,
    })
    const strategy = new StrategySelector().select(profile)
    const verificationPlan = new VerificationBaseline(commands).plan()
    if (this.options.persistProfile) persist(this.options.workspace.root, this.options.workspace.teamDir, profile)
    return {
      profile,
      strategy,
      ...(boundaryDecision === undefined ? {} : { serviceBoundaryDecision: boundaryDecision }),
      commands,
      verificationPlan,
      ...(gitBaseline === undefined ? {} : { gitBaseline }),
    }
  }
}
