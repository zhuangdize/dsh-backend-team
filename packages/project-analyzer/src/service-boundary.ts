import { lstatSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { WorkspaceLayout } from '@dsh-backend-team/contracts'
import type { ProjectEvidence } from './evidence.js'
import type { ServiceBoundary, ServiceBoundaryResolution } from './project-profile.js'
import { SecretFilter } from './secret-filter.js'
import type { DetectorContext } from './detectors/node.js'
import { MonorepoAnalyzer } from './monorepo-analyzer.js'
import type { ServiceCandidate } from './monorepo-analyzer.js'

export interface ServiceBoundaryResolverOptions {
  readonly workspace: WorkspaceLayout
  readonly context: DetectorContext
}

export interface ServiceBoundaryCandidate {
  readonly relativeRoot: string
  readonly score: number
  readonly evidence: readonly ProjectEvidence[]
}

export type ServiceBoundaryDecision =
  | Readonly<{ status: 'selected'; boundary: ServiceBoundary; candidates: readonly ServiceBoundaryCandidate[] }>
  | Readonly<{ status: 'needs-user-selection'; candidates: readonly ServiceBoundaryCandidate[] }>
  | Readonly<{ status: 'invalid-requested-path'; candidates: readonly [] }>
  | Readonly<{ status: 'no-candidate'; candidates: readonly [] }>

function validRelativePath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  return path === '.' || (path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path) && !path.includes('\\')
    && !path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..' || SecretFilter.isSensitivePath(segment) || SecretFilter.isSensitivePath(`${segment}/placeholder`)))
}

function hasSymlinkAncestor(root: string, relativePath: string): boolean {
  let target = root
  for (const segment of relativePath === '.' ? [] : relativePath.split('/')) {
    target = resolve(target, segment)
    try {
      if (lstatSync(target).isSymbolicLink()) return true
    } catch {
      // The manifest index is authoritative for virtual/test contexts; a missing
      // on-disk path cannot be a symlink escape.
      return false
    }
  }
  return false
}

function candidateView(candidate: ServiceCandidate): ServiceBoundaryCandidate {
  return { relativeRoot: candidate.relativeRoot, score: candidate.score, evidence: candidate.evidence }
}

function boundary(candidate: ServiceCandidate): ServiceBoundary {
  return {
    relativeRoot: candidate.relativeRoot,
    confidence: candidate.score >= 60 ? 'high' : 'medium',
    evidence: [...candidate.evidence],
  }
}

/** Resolves an inert, workspace-relative backend boundary; callers persist only the decision. */
export class ServiceBoundaryResolver {
  private readonly analyzer = new MonorepoAnalyzer()

  constructor(private readonly options: ServiceBoundaryResolverOptions) {}

  async resolve(requestedPath?: string): Promise<ServiceBoundaryDecision> {
    if (requestedPath !== undefined && (!validRelativePath(requestedPath) || hasSymlinkAncestor(this.options.workspace.root, requestedPath))) {
      return { status: 'invalid-requested-path', candidates: [] }
    }
    const candidates = await this.analyzer.candidates(this.options.context)
    if (requestedPath !== undefined) {
      const requested = candidates.find((candidate) => candidate.relativeRoot === requestedPath)
      return requested === undefined
        ? { status: 'invalid-requested-path', candidates: [] }
        : { status: 'selected', boundary: boundary(requested), candidates: [candidateView(requested)] }
    }
    const first = candidates[0]
    if (!first) return { status: 'no-candidate', candidates: [] }
    const second = candidates[1]
    if (second && first.score - second.score < 20) return { status: 'needs-user-selection', candidates: candidates.map(candidateView) }
    return { status: 'selected', boundary: boundary(first), candidates: [candidateView(first)] }
  }

  resolveRuntime(boundaryValue: ServiceBoundary): ServiceBoundaryResolution {
    if (!validRelativePath(boundaryValue.relativeRoot)) throw new Error('service boundary path is unsafe')
    const absoluteRoot = resolve(this.options.workspace.root, boundaryValue.relativeRoot)
    const fromWorkspace = relative(this.options.workspace.root, absoluteRoot)
    if (fromWorkspace.startsWith('..') || fromWorkspace === '..' || hasSymlinkAncestor(this.options.workspace.root, boundaryValue.relativeRoot)) throw new Error('service boundary escapes the workspace')
    return { relativeRoot: boundaryValue.relativeRoot, absoluteRoot, workspace: this.options.workspace }
  }
}
