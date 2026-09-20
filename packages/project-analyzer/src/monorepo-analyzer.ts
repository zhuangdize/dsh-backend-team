import type { PackageManifest } from './manifest-reader.js'
import type { ProjectEvidence } from './evidence.js'
import { DatabaseDetector } from './detectors/database.js'
import { FrameworkDetector } from './detectors/framework.js'
import { createDetectorContext, dependencies, evidence } from './detectors/node.js'
import type { DetectorContext } from './detectors/node.js'
import { SecretFilter } from './secret-filter.js'

export interface ServiceCandidate {
  readonly relativeRoot: string
  readonly score: number
  readonly evidence: readonly ProjectEvidence[]
}

const frontendDependencies = new Set(['@angular/core', 'next', 'nuxt', 'react', 'react-dom', 'svelte', 'vue'])

function workspacePatterns(manifest: PackageManifest | undefined): readonly string[] {
  const value = manifest?.workspaces
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const packages = (value as Readonly<Record<string, unknown>>).packages
  return Array.isArray(packages) && packages.every((entry) => typeof entry === 'string') ? packages : []
}

function matchesWorkspace(relativeRoot: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const expression = pattern.split('/').map((segment) => segment === '**' ? '.+' : segment === '*' ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('/')
    return new RegExp(`^${expression}$`, 'u').test(relativeRoot)
  })
}

function relativeRoot(path: string): string {
  return path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length)
}

function isSafeRelativeRoot(root: string): boolean {
  return root === '.' || (root.length > 0 && !root.startsWith('/') && !/^[A-Za-z]:/u.test(root) && !root.includes('\\')
    && !root.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..' || SecretFilter.isSensitivePath(segment) || SecretFilter.isSensitivePath(`${segment}/placeholder`)))
}

function textForBoundary(context: DetectorContext, root: string, rootIsWorkspace: boolean): ReadonlyMap<string, string> {
  if (root === '.' && rootIsWorkspace) return new Map()
  return new Map([...context.textFiles].filter(([path]) => root === '.' || path.startsWith(`${root}/`)).sort(([left], [right]) => left.localeCompare(right)))
}

function hasFrontendDependencies(manifest: PackageManifest): boolean {
  return Object.keys(dependencies(manifest)).some((dependency) => frontendDependencies.has(dependency))
}

function hasServerStartScript(manifest: PackageManifest): boolean {
  return Object.entries(manifest.scripts ?? {}).some(([script, command]) => (script === 'start' || script.startsWith('start:') || script === 'dev')
    && !/(?:^|\s)(?:vite|next|nuxt|react-scripts|svelte-kit)(?:\s|$)/u.test(command))
}

/** Scores only manifest-backed workspace candidates from inert detector evidence. */
export class MonorepoAnalyzer {
  async candidates(context: DetectorContext): Promise<readonly ServiceCandidate[]> {
    const rootManifest = context.manifests.get('package.json')
    const patterns = workspacePatterns(rootManifest)
    const rootIsWorkspace = patterns.length > 0
    const candidates: ServiceCandidate[] = []
    for (const [path, manifest] of [...context.manifests].sort(([left], [right]) => left.localeCompare(right))) {
      if (!path.endsWith('package.json')) continue
      const root = relativeRoot(path)
      if (!isSafeRelativeRoot(root)) continue
      if (root !== '.' && !matchesWorkspace(root, patterns)) continue

      const boundaryPaths = root === '.'
        ? (rootIsWorkspace ? [path] : context.paths)
        : context.paths.filter((candidatePath) => candidatePath.startsWith(`${root}/`))
      const candidateContext = createDetectorContext({
        paths: boundaryPaths,
        manifests: new Map([[path, manifest]]),
        textFiles: textForBoundary(context, root, rootIsWorkspace),
      })
      const [frameworks, database] = await Promise.all([
        new FrameworkDetector().collect(candidateContext),
        new DatabaseDetector().collect(candidateContext),
      ])
      const scripts = hasServerStartScript(manifest)
        ? [evidence('script', path, 'declares a server start script', `service-start:${path}`)]
        : []
      if (hasFrontendDependencies(manifest) && frameworks.length === 0 && database.orms.length === 0 && database.databases.length === 0) continue
      const detected = [...frameworks.flatMap((value) => value.evidence), ...database.orms.flatMap((value) => value.evidence), ...database.databases.flatMap((value) => value.evidence), ...scripts]
      const score = (frameworks.length > 0 ? 60 : 0) + (scripts.length > 0 ? 25 : 0) + (database.orms.length > 0 || database.databases.length > 0 ? 15 : 0)
      if (score > 0) candidates.push({ relativeRoot: root, score, evidence: detected })
    }
    return candidates.sort((left, right) => right.score - left.score || left.relativeRoot.localeCompare(right.relativeRoot))
  }
}
