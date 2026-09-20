import type { ProjectEvidence } from '../evidence.js'
import { manifestEvidence } from './node.js'
import type { DetectorContext } from './node.js'
import { preferredPackageManager } from './package-manager.js'
import { PackageManagerDetector } from './package-manager.js'

export type CommandPurpose = 'typecheck' | 'lint' | 'build' | 'unit' | 'integration' | 'migration-generate' | 'migration-apply' | 'migration-rollback' | 'start' | 'health' | 'unknown'

export interface DetectedCommand {
  readonly script: string
  readonly argv: readonly string[]
  readonly purpose: CommandPurpose
  readonly status: 'unverified'
  readonly evidence: readonly ProjectEvidence[]
  readonly conflicts: readonly ProjectEvidence[]
}

function purposeFor(script: string): CommandPurpose {
  const lower = script.toLowerCase()
  if (lower === 'typecheck' || lower.includes('type-check')) return 'typecheck'
  if (lower === 'lint' || lower.startsWith('lint:')) return 'lint'
  if (lower === 'build' || lower.startsWith('build:')) return 'build'
  if (lower.includes('migration:generate') || lower.includes('migrate:generate')) return 'migration-generate'
  if (lower.includes('migration:rollback') || lower.includes('migrate:rollback')) return 'migration-rollback'
  if (lower.includes('migration') || lower.includes('migrate')) return 'migration-apply'
  if (lower.includes('integration')) return 'integration'
  if (lower === 'test' || lower.startsWith('test:') || lower.includes('unit')) return 'unit'
  if (lower === 'start' || lower.startsWith('start:') || lower === 'dev') return 'start'
  if (lower.includes('health')) return 'health'
  return 'unknown'
}

function argvFor(manager: string, script: string): readonly string[] {
  if (manager === 'npm' || manager === 'pnpm' || manager === 'yarn' || manager === 'bun') return [manager, 'run', script]
  return []
}

export class CommandDetector {
  async collect(context: DetectorContext): Promise<readonly DetectedCommand[]> {
    const manager = preferredPackageManager(context)
    const managerClaims = await new PackageManagerDetector().collect(context)
    const conflicts = manager === undefined ? managerClaims.flatMap((claim) => claim.evidence) : []
    const commands: DetectedCommand[] = []
    for (const [path, manifest] of [...context.manifests].sort(([left], [right]) => left.localeCompare(right))) {
      for (const script of Object.keys(manifest.scripts ?? {}).sort()) {
        const purpose = purposeFor(script)
        commands.push({ script, argv: manager ? argvFor(manager, script) : [], purpose, status: 'unverified', evidence: [manifestEvidence(path, `declares the ${script} script`, `script:${script}`)], conflicts })
      }
    }
    return commands.sort((left, right) => left.script.localeCompare(right.script))
  }
}
