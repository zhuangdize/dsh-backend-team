import type { Database, Orm } from './detectors/database.js'
import type { Framework } from './detectors/framework.js'
import type { PackageManager } from './detectors/package-manager.js'
import type { ProjectEvidence } from './evidence.js'
import type { ProjectProfile } from './project-profile.js'

export type ProjectStrategy =
  | Readonly<{ kind: 'new-node-postgresql'; writable: true; nodeVersion: '24.19.0'; preset: 'presets/new-project/node-postgresql.yaml'; evidence: readonly ProjectEvidence[] }>
  | Readonly<{ kind: 'modify-in-place'; writable: true; nodeVersion: string; framework: Framework; database: Database; orm: Orm; packageManager: PackageManager; migration: 'preserve-existing'; evidence: readonly ProjectEvidence[] }>
  | Readonly<{ kind: 'unsupported-read-only'; writable: false; evidence: readonly ProjectEvidence[] }>
  | Readonly<{ kind: 'needs-clarification'; writable: false; evidence: readonly ProjectEvidence[] }>

const packageManagers = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun'])
const frameworks = new Set<Framework>(['nest', 'express', 'fastify', 'koa', 'hapi'])
const orms = new Set<Orm>(['drizzle', 'prisma', 'typeorm', 'sequelize', 'knex'])
const databases = new Set<Database>(['postgresql', 'mysql', 'mariadb', 'sqlite'])

function facts(profile: ProjectProfile, category: string): readonly ProjectProfile['technologies'][number][] {
  return profile.technologies.filter((technology) => technology.category === category)
}

function evidenceFor(profile: ProjectProfile): readonly ProjectEvidence[] {
  return [
    ...profile.technologies.flatMap((technology) => [...technology.evidence, ...technology.conflicts]),
    ...(profile.nodeRuntime?.declarations.map((declaration) => declaration.evidence) ?? []),
    ...profile.nodeRuntime?.conflicts ?? [],
    ...profile.serviceBoundary?.evidence ?? [],
    ...profile.baselineIssues.flatMap((issue) => issue.evidence),
  ]
}

function hasConflicts(profile: ProjectProfile): boolean {
  return profile.technologies.some((technology) => technology.conflicts.length > 0)
}

function hasLowConfidence(profile: ProjectProfile): boolean {
  return profile.technologies.some((technology) => technology.confidence === 'low') || profile.serviceBoundary?.confidence === 'low'
}

function uniqueFact<T extends string>(profile: ProjectProfile, category: string, known: ReadonlySet<T>): (ProjectProfile['technologies'][number] & { readonly value: T }) | undefined {
  const categoryFacts = facts(profile, category)
  if (categoryFacts.length !== 1) return undefined
  const candidate = categoryFacts[0]
  return candidate !== undefined && known.has(candidate.value as T) ? candidate as ProjectProfile['technologies'][number] & { readonly value: T } : undefined
}

function uniqueKnownFact<T extends string>(profile: ProjectProfile, category: string, known: ReadonlySet<T>): (ProjectProfile['technologies'][number] & { readonly value: T }) | undefined {
  const candidates = facts(profile, category).filter((fact): fact is ProjectProfile['technologies'][number] & { readonly value: T } => known.has(fact.value as T))
  return candidates.length === 1 ? candidates[0] : undefined
}

function resolvedFramework(profile: ProjectProfile): (ProjectProfile['technologies'][number] & { readonly value: Framework }) | undefined {
  const categoryFacts = facts(profile, 'framework')
  const single = uniqueFact(profile, 'framework', frameworks)
  if (single) return single
  const values = categoryFacts.map((fact) => fact.value).sort()
  // Nest may intentionally use Fastify as its HTTP adapter; this is an explicit
  // composition, unlike independent frameworks such as Express + Fastify.
  return values.length === 2 && values[0] === 'fastify' && values[1] === 'nest'
    ? categoryFacts.find((fact): fact is ProjectProfile['technologies'][number] & { readonly value: Framework } => fact.value === 'nest')
    : undefined
}

/** Chooses a write strategy only when the persisted profile contains a complete, non-conflicting existing stack. */
export class StrategySelector {
  select(profile: ProjectProfile): ProjectStrategy {
    const allEvidence = evidenceFor(profile)
    if (profile.baselineIssues.some((issue) => issue.severity === 'blocking')) return { kind: 'needs-clarification', writable: false, evidence: allEvidence }
    if (profile.projectKind === 'empty' || (!profile.exists && profile.projectKind === 'unknown')) {
      return { kind: 'new-node-postgresql', writable: true, nodeVersion: '24.19.0', preset: 'presets/new-project/node-postgresql.yaml', evidence: allEvidence }
    }
    if (profile.projectKind === 'non-node') return { kind: 'unsupported-read-only', writable: false, evidence: allEvidence }

    const runtime = profile.nodeRuntime
    const framework = resolvedFramework(profile)
    const orm = uniqueFact(profile, 'orm', orms)
    const database = uniqueFact(profile, 'database', databases)
    const packageManager = uniqueKnownFact(profile, 'other', packageManagers)
    const isNewNodeProject = profile.projectKind === 'node-service' && framework === undefined && orm === undefined && database === undefined
    const hasConflictingRuntimeDeclarations = runtime?.status === 'needs-clarification' && runtime.declarations.length > 0
    if (isNewNodeProject && !hasConflicts(profile) && !hasConflictingRuntimeDeclarations) {
      return { kind: 'new-node-postgresql', writable: true, nodeVersion: '24.19.0', preset: 'presets/new-project/node-postgresql.yaml', evidence: allEvidence }
    }
    const nodeVersion = runtime?.status === 'selected' ? runtime.exactVersion : undefined
    const incomplete = !nodeVersion || profile.serviceBoundary === null
      || framework === undefined || orm === undefined || database === undefined || packageManager === undefined
      || hasConflicts(profile) || hasLowConfidence(profile) || profile.databaseRecommendation?.target !== 'preserve-existing'
    if (incomplete) return { kind: 'needs-clarification', writable: false, evidence: allEvidence }

    return {
      kind: 'modify-in-place',
      writable: true,
      nodeVersion,
      framework: framework.value,
      database: database.value,
      orm: orm.value,
      packageManager: packageManager.value,
      migration: 'preserve-existing',
      evidence: allEvidence,
    }
  }
}
