import type { DetectedValue } from '../project-profile.js'
import { evidence, manifestEvidence } from './node.js'
import type { Detector, DetectorContext } from './node.js'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const locks: Readonly<Record<string, PackageManager>> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
}

function managerFromDeclaration(value: string): PackageManager | undefined {
  const manager = value.split('@')[0]
  return manager === 'npm' || manager === 'pnpm' || manager === 'yarn' || manager === 'bun' ? manager : undefined
}

export function preferredPackageManager(context: DetectorContext): PackageManager | undefined {
  const managers = collectManagers(context)
  return managers.length === 1 ? managers[0]?.value : undefined
}

function collectManagers(context: DetectorContext): DetectedValue<PackageManager>[] {
  const values: DetectedValue<PackageManager>[] = []
  for (const [path, manifest] of [...context.manifests].sort(([left], [right]) => left.localeCompare(right))) {
    if (manifest.packageManager) {
      const manager = managerFromDeclaration(manifest.packageManager)
      if (manager && !values.some((value) => value.value === manager)) values.push({ value: manager, confidence: 'high', evidence: [manifestEvidence(path, 'declares the package manager', `packageManager:${manager}`)], conflicts: [] })
    }
  }
  for (const path of context.paths) {
    const manager = locks[path.split('/').at(-1) ?? '']
      if (manager && !values.some((value) => value.value === manager)) values.push({ value: manager, confidence: 'high', evidence: [evidence('lockfile', path, 'identifies the package manager lockfile', `lock:${manager}`)], conflicts: [] })
  }
  if (values.length === 0) {
    const packagePath = [...context.manifests.keys()].sort()[0]
    if (packagePath) values.push({ value: 'npm', confidence: 'low', evidence: [manifestEvidence(packagePath, 'uses the npm package manifest convention', 'npm-convention')], conflicts: [] })
  }
  return values.map((value) => ({ ...value, conflicts: values.filter((other) => other.value !== value.value).flatMap((other) => other.evidence) }))
}

export class PackageManagerDetector implements Detector<PackageManager> {
  async collect(context: DetectorContext): Promise<readonly DetectedValue<PackageManager>[]> {
    return collectManagers(context)
  }
}
