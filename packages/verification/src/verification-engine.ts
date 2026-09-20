import type { CommandCapture, VerificationCommand } from './verification-command.js'
import { VerificationCommandRunner } from './verification-command.js'
import { BaselineRunner } from './baseline-runner.js'
import { compareResults, type ResultComparison } from './result-comparator.js'
import { allRequirementsPassed, buildRequirementEvidence, hasBlockedRequirement, type RequirementEvidence } from './requirement-evidence.js'
import type { RequirementTrace } from './requirement-evidence.js'
import type { CommandRunner } from '@dsh-backend-team/contracts'

export interface VerificationReport {
  readonly status: 'passed' | 'failed' | 'blocked'
  readonly requirements: Readonly<Record<string, RequirementEvidence>>
  readonly baseline: readonly CommandCapture[]
  readonly results: readonly CommandCapture[]
  readonly comparison: ResultComparison
  readonly newFailures: readonly CommandCapture[]
}

export interface VerificationEngineOptions {
  readonly runner: CommandRunner
  readonly now?: () => number
  readonly maxExcerptChars?: number
  readonly defaultEnv?: Readonly<Record<string, string>>
}

export interface VerificationRunInput {
  readonly commands: readonly VerificationCommand[]
  readonly trace: RequirementTrace
  readonly signal?: AbortSignal
}

/** Baseline-aware command verification and requirement evidence engine. */
export class VerificationEngine {
  private baseline: readonly CommandCapture[] = []
  private readonly baselineRunner: BaselineRunner

  constructor(options: VerificationEngineOptions) {
    this.baselineRunner = new BaselineRunner({ commandRunner: new VerificationCommandRunner(options) })
  }

  async captureBaseline(commands: readonly VerificationCommand[], signal?: AbortSignal): Promise<readonly CommandCapture[]> {
    this.baseline = await this.baselineRunner.capture(commands, signal)
    return this.baseline
  }

  async verifySlice(input: VerificationRunInput): Promise<VerificationReport> {
    return this.verify(input)
  }

  async verifyAll(input: VerificationRunInput | readonly VerificationCommand[], trace?: RequirementTrace, signal?: AbortSignal): Promise<VerificationReport> {
    return this.verify(isRunInput(input) ? input : { commands: input, trace: trace ?? { requirements: {} }, ...(signal === undefined ? {} : { signal }) })
  }

  private async verify(input: VerificationRunInput): Promise<VerificationReport> {
    const results = await this.baselineRunner.capture(input.commands, input.signal)
    const comparison = compareResults(this.baseline, results)
    const requirements = buildRequirementEvidence(input.trace, results, comparison)
    const passed = allRequirementsPassed(requirements) && comparison.newFailures.length === 0
    const status = passed ? 'passed' : hasBlockedRequirement(requirements) || results.some((capture) => capture.status === 'blocked' || capture.status === 'interrupted') ? 'blocked' : 'failed'
    return Object.freeze({ status, requirements, baseline: this.baseline, results, comparison, newFailures: comparison.newFailures })
  }
}

function isRunInput(input: VerificationRunInput | readonly VerificationCommand[]): input is VerificationRunInput {
  return !Array.isArray(input) && typeof input === 'object' && input !== null && 'commands' in input && 'trace' in input
}
