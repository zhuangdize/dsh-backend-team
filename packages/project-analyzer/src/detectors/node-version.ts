import type { ProjectEvidence } from '../evidence.js'
import type { DetectedNodeRuntime, NodeDeclaration } from '../project-profile.js'
import { evidence, manifestEvidence } from './node.js'
import type { DetectorContext } from './node.js'

type Version = readonly [number, number, number]

function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined
}

function compare(left: Version, right: Version): number {
  for (const index of [0, 1, 2] as const) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}

function acceptsToken(token: string, candidate: Version): boolean {
  const comparison = /^(>=|>|<=|<)(\d+(?:\.\d+){0,2})$/u.exec(token)
  if (comparison) {
    const version = parseVersion(comparison[2] ?? '')
    if (!version) return false
    const result = compare(candidate, version)
    return (comparison[1] === '>=' && result >= 0) || (comparison[1] === '>' && result > 0)
      || (comparison[1] === '<=' && result <= 0) || (comparison[1] === '<' && result < 0)
  }
  const shorthand = /^(\^|~)(\d+(?:\.\d+){0,2})$/u.exec(token)
  if (shorthand) {
    const lower = parseVersion(shorthand[2] ?? '')
    if (!lower) return false
    const upper: Version = shorthand[1] === '~' ? [lower[0], lower[1] + 1, 0]
      : lower[0] > 0 ? [lower[0] + 1, 0, 0] : lower[1] > 0 ? [0, lower[1] + 1, 0] : [0, 0, lower[2] + 1]
    return compare(candidate, lower) >= 0 && compare(candidate, upper) < 0
  }
  const exact = parseVersion(token)
  return exact !== undefined && compare(candidate, exact) === 0
}

function accepts(range: string, exact: string): boolean {
  const version = parseVersion(exact)
  if (!version) return false
  const alternatives = range.trim().split('||').map((part) => part.trim()).filter(Boolean)
  return alternatives.some((alternative) => alternative.split(/\s+/u).every((token) => acceptsToken(token, version)))
}

function exactRange(range: string): string | undefined {
  const version = parseVersion(range)
  return version ? version.join('.') : undefined
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = (value as Readonly<Record<string, unknown>>)[key]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

function devRuntimeRange(value: unknown): string | undefined {
  const direct = stringProperty(value, 'runtime')
  if (direct) return direct
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const runtime = (value as Readonly<Record<string, unknown>>).runtime
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) return undefined
  const record = runtime as Readonly<Record<string, unknown>>
  return record.name === 'node' && typeof record.version === 'string' && record.version.trim() ? record.version.trim() : undefined
}

function declaration(source: string, range: string, evidenceValue: ProjectEvidence): NodeDeclaration {
  return { source, range: range.trim(), evidence: evidenceValue }
}

function normalizedNodeRange(range: string): string {
  return range.trim().replace(/^v(?=\d)/iu, '')
}

export class NodeRuntimeDetector {
  async collect(context: DetectorContext): Promise<DetectedNodeRuntime> {
    const declarations: NodeDeclaration[] = []
    for (const [path, label] of [['.nvmrc', '.nvmrc'], ['.node-version', '.node-version']] as const) {
      const text = context.textFiles.get(path)
      if (text) declarations.push(declaration(label, text, evidence('config', path, 'declares a Node runtime version', `node:${path}:${text}`)))
    }
    const toolVersions = context.textFiles.get('.tool-versions')
    const toolVersion = toolVersions?.split(/\r?\n/u).map((line) => line.trim()).find((line) => /^nodejs\s+/u.test(line))
    if (toolVersion) {
      const range = toolVersion.replace(/^nodejs\s+/u, '').trim()
      if (range) declarations.push(declaration('.tool-versions', range, evidence('config', '.tool-versions', 'declares an asdf Node runtime version', `node:tool-versions:${range}`)))
    }
    for (const [path, manifest] of [...context.manifests].sort(([left], [right]) => left.localeCompare(right))) {
      const engine = stringProperty(manifest.engines, 'node')
      if (engine) declarations.push(declaration(`${path}#engines.node`, engine, manifestEvidence(path, 'declares a Node engine range', `engines.node:${engine}`)))
      const devEngine = devRuntimeRange(manifest.devEngines)
      if (devEngine) declarations.push(declaration(`${path}#devEngines.runtime`, devEngine, manifestEvidence(path, 'declares a Node development runtime range', `devEngines.runtime:${devEngine}`)))
      const volta = stringProperty(manifest.volta, 'node')
      if (volta) declarations.push(declaration(`${path}#volta.node`, volta, manifestEvidence(path, 'declares a Volta Node runtime version', `volta.node:${volta}`)))
    }
    if (declarations.length === 0) {
      const lockEvidence = context.paths.flatMap((path) => {
        const basename = path.split('/').at(-1)
        return basename === 'package-lock.json' || basename === 'npm-shrinkwrap.json' || basename === 'pnpm-lock.yaml' || basename === 'yarn.lock' || basename === 'bun.lock' || basename === 'bun.lockb'
          ? [evidence('lockfile', path, 'does not declare Node runtime compatibility', `node-compatibility-unavailable:${path}`)]
          : []
      })
      const packageManagerEvidence = [...context.manifests].flatMap(([path, manifest]) => manifest.packageManager
        ? [manifestEvidence(path, 'declares a package manager but not Node runtime compatibility', `node-compatibility-unavailable:${manifest.packageManager.split('@')[0] ?? 'unknown'}`)]
        : [])
      return { declarations, conflicts: [...lockEvidence, ...packageManagerEvidence], status: 'needs-clarification' }
    }

    const normalizedDeclarations = declarations.map((item) => ({ ...item, range: normalizedNodeRange(item.range) }))
    const exactDeclarations = normalizedDeclarations.map((item) => ({ item, exact: exactRange(item.range) })).filter((item): item is { readonly item: NodeDeclaration, readonly exact: string } => item.exact !== undefined)
    const selected = exactDeclarations.find(({ exact }) => normalizedDeclarations.every((item) => accepts(item.range, exact)))
    if (!selected) return { declarations, conflicts: declarations.map((item) => item.evidence), status: 'needs-clarification' }
    return { declarations, exactVersion: selected.exact, selectionSource: selected.item.source, conflicts: [], status: 'selected' }
  }
}
