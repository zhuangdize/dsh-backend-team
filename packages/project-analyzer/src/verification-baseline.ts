import { createHash } from 'node:crypto'
import type { DetectedCommand, CommandPurpose } from './detectors/command.js'
import type { ProjectEvidence } from './evidence.js'

export type VerificationRisk = 'read' | 'write' | 'migration' | 'unknown'

export interface VerificationPlanEntry {
  readonly candidateId: string
  readonly script: string
  readonly argv: readonly string[]
  readonly purpose: CommandPurpose
  readonly risk: VerificationRisk
  readonly approvalRequired: boolean
  readonly status: 'unverified'
  readonly evidence: readonly ProjectEvidence[]
  readonly conflicts: readonly ProjectEvidence[]
}

export interface ExternalVerificationResult {
  readonly candidateId?: string
  readonly script?: string
  readonly exitCode: number
  readonly durationMs: number
}

export interface RecordedVerification extends VerificationPlanEntry {
  readonly result?: Readonly<{ exitCode: number; durationMs: number }>
}

function riskFor(purpose: CommandPurpose): VerificationRisk {
  if (purpose.startsWith('migration-')) return 'migration'
  if (purpose === 'build' || purpose === 'start') return 'write'
  if (purpose === 'unknown') return 'unknown'
  return 'read'
}

function candidateId(command: DetectedCommand): string {
  const path = command.evidence[0]?.path ?? ''
  return createHash('sha256').update(JSON.stringify([path, command.script, command.argv])).digest('hex')
}

/** Preserves detector command candidates without executing them in analysis stages. */
export class VerificationBaseline {
  constructor(private readonly commands: readonly DetectedCommand[]) {}

  plan(): readonly VerificationPlanEntry[] {
    return this.commands.map((command) => ({
      candidateId: candidateId(command),
      script: command.script,
      argv: [...command.argv],
      purpose: command.purpose,
      risk: riskFor(command.purpose),
      approvalRequired: command.purpose === 'unknown' || command.conflicts.length > 0,
      status: 'unverified',
      evidence: command.evidence,
      conflicts: command.conflicts,
    }))
  }

  record(plan: readonly VerificationPlanEntry[], results: readonly ExternalVerificationResult[]): readonly RecordedVerification[] {
    const byCandidateId = new Map(results.filter((result): result is ExternalVerificationResult & { readonly candidateId: string } => result.candidateId !== undefined).map((result) => [result.candidateId, result]))
    const candidateCountByScript = new Map<string, number>()
    for (const candidate of plan) candidateCountByScript.set(candidate.script, (candidateCountByScript.get(candidate.script) ?? 0) + 1)
    const uniqueByScript = new Map(results.filter((result): result is ExternalVerificationResult & { readonly script: string } => result.candidateId === undefined && result.script !== undefined).map((result) => [result.script, result]))
    return plan.map((candidate) => {
      const result = byCandidateId.get(candidate.candidateId)
        ?? (candidateCountByScript.get(candidate.script) === 1 ? uniqueByScript.get(candidate.script) : undefined)
      return result === undefined ? { ...candidate } : { ...candidate, result: { exitCode: result.exitCode, durationMs: result.durationMs } }
    })
  }
}
