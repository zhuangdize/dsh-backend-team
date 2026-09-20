import { createHash } from 'node:crypto'
import type { PackageManifest } from '../manifest-reader.js'
import type { ProjectEvidence } from '../evidence.js'
import type { DetectedValue } from '../project-profile.js'
import { SecretFilter } from '../secret-filter.js'

export interface DetectorContextInput {
  /** Paths supplied by a bounded FileIndex traversal. */
  readonly paths: readonly string[]
  /** Sanitized package data returned by ManifestReader. */
  readonly manifests: ReadonlyMap<string, PackageManifest>
  /** Optional, bounded inert text for known, non-sensitive files. Never evaluated. */
  readonly textFiles?: ReadonlyMap<string, string>
}

export interface DetectorContext {
  readonly paths: readonly string[]
  readonly manifests: ReadonlyMap<string, PackageManifest>
  readonly textFiles: ReadonlyMap<string, string>
}

export interface Detector<T extends string> {
  collect(context: DetectorContext): Promise<readonly DetectedValue<T>[]>
}

const safePath = (path: string): boolean => path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path) && !path.includes('\\')
  && !path.split('/').some((part) => part === '' || part === '.' || part === '..') && !SecretFilter.isSensitivePath(path)

/**
 * Normalizes bounded FileIndex and ManifestReader outputs. Text values are data
 * only; sensitive paths are discarded before detectors receive the context.
 */
export function createDetectorContext(input: DetectorContextInput): DetectorContext {
  const paths = [...new Set(input.paths.filter(safePath))].sort()
  const pathSet = new Set(paths)
  const manifests = new Map([...input.manifests].filter(([path]) => pathSet.has(path) && path.endsWith('package.json')))
  const textFiles = new Map(
    [...(input.textFiles ?? new Map<string, string>())]
      .filter(([path, text]) => pathSet.has(path) && text.length <= 2 * 1024 * 1024),
  )
  return { paths, manifests, textFiles }
}

export function evidence(kind: ProjectEvidence['kind'], path: string, fact: string, seed: string): ProjectEvidence {
  return { kind, path, fact, excerptHash: createHash('sha256').update(seed).digest('hex') }
}

export function dependencies(manifest: PackageManifest): Readonly<Record<string, string>> {
  return { ...manifest.dependencies, ...manifest.devDependencies }
}

export function manifestEvidence(path: string, fact: string, seed: string): ProjectEvidence {
  return evidence('manifest', path, fact, `manifest:${path}:${seed}`)
}

export class NodeDetector implements Detector<'node' | 'typescript-strict'> {
  async collect(context: DetectorContext): Promise<readonly DetectedValue<'node' | 'typescript-strict'>[]> {
    const results: DetectedValue<'node' | 'typescript-strict'>[] = []
    const packagePath = [...context.manifests.keys()].sort()[0]
    if (packagePath !== undefined) {
      results.push({ value: 'node', confidence: 'high', evidence: [manifestEvidence(packagePath, 'declares a Node package manifest', 'node')], conflicts: [] })
    }
    for (const [path, text] of context.textFiles) {
      if (!path.endsWith('tsconfig.json') || !/"strict"\s*:\s*true/u.test(text)) continue
      results.push({ value: 'typescript-strict', confidence: 'high', evidence: [evidence('config', path, 'enables TypeScript strict mode', 'typescript-strict')], conflicts: [] })
    }
    return results
  }
}
