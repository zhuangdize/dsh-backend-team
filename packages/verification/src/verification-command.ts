import { createHash } from 'node:crypto'
import type { CommandResult, CommandRunner } from '@dsh-backend-team/contracts'

export type VerificationPurpose = 'typecheck' | 'lint' | 'build' | 'unit' | 'integration' | 'api' | 'openapi' | 'migration' | 'startup' | 'health' | 'security' | 'unknown'
export type VerificationStatus = 'passed' | 'failed' | 'blocked' | 'not-run' | 'interrupted'

export interface VerificationCommand {
  readonly id: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly purpose: VerificationPurpose
  readonly expected?: string
  readonly evidenceIds?: readonly string[]
  readonly sliceId?: string
  readonly approvalRequired?: boolean
  readonly networkPolicy?: 'deny' | 'allow'
  readonly env?: Readonly<Record<string, string>>
}

export interface CommandCapture {
  readonly id: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly purpose: VerificationPurpose
  readonly evidenceIds: readonly string[]
  readonly sliceId?: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly exitCode?: number
  readonly status: VerificationStatus
  readonly stdoutSha256: string
  readonly stderrSha256: string
  readonly stdoutExcerpt: string
  readonly stderrExcerpt: string
  readonly reason?: string
}

export interface VerificationCommandRunnerOptions {
  readonly runner: CommandRunner
  readonly now?: () => number
  readonly maxExcerptChars?: number
  readonly defaultEnv?: Readonly<Record<string, string>>
}

/** Captures deterministic, redacted command evidence through the policy-owned runner. */
export class VerificationCommandRunner {
  private readonly now: () => number
  private readonly maxExcerptChars: number
  private readonly defaultEnv: Readonly<Record<string, string>>

  constructor(private readonly options: VerificationCommandRunnerOptions) {
    this.now = options.now ?? (() => Date.now())
    this.maxExcerptChars = options.maxExcerptChars ?? 4_096
    if (!Number.isInteger(this.maxExcerptChars) || this.maxExcerptChars < 128) throw new Error('verification excerpt limit must be at least 128 characters')
    this.defaultEnv = options.defaultEnv ?? {}
  }

  async run(command: VerificationCommand, signal?: AbortSignal): Promise<CommandCapture> {
    const started = this.now()
    const startedAt = new Date(started).toISOString()
    const common = { id: command.id, argv: [...command.argv], cwd: command.cwd, purpose: command.purpose, evidenceIds: [...(command.evidenceIds ?? [command.id])], ...(command.sliceId === undefined ? {} : { sliceId: command.sliceId }) }
    if (command.argv.length === 0 || command.argv.some((argument) => argument.trim().length === 0)) return captureBlocked(common, startedAt, this.now(), 'verification command has no executable or contains an empty argument', this.maxExcerptChars)
    try {
      const result = await this.options.runner.run({ executable: command.argv[0]!, args: command.argv.slice(1), cwd: command.cwd, env: { ...this.defaultEnv, ...(command.env ?? {}) }, purpose: `verification:${command.purpose}`, risk: command.purpose === 'migration' ? 'migration' : 'read', networkPolicy: command.networkPolicy ?? 'deny', executionFingerprint: digest(JSON.stringify([command.argv, command.cwd, command.purpose])) }, signal)
      return captureResult(common, startedAt, this.now(), result, this.maxExcerptChars)
    } catch (error: unknown) {
      const interrupted = signal?.aborted === true || (error instanceof Error && /abort|interrupt|cancel|sigterm|sigint/u.test(error.message.toLowerCase()))
      return captureBlocked(common, startedAt, this.now(), error instanceof Error ? error.message : String(error), this.maxExcerptChars, interrupted ? 'interrupted' : 'blocked')
    }
  }
}

function captureResult(common: Omit<CommandCapture, 'startedAt' | 'finishedAt' | 'durationMs' | 'exitCode' | 'status' | 'stdoutSha256' | 'stderrSha256' | 'stdoutExcerpt' | 'stderrExcerpt'>, startedAt: string, finished: number, result: CommandResult, limit: number): CommandCapture {
  const status: VerificationStatus = result.exitCode === 0 ? 'passed' : 'failed'
  return { ...common, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: Math.max(0, result.durationMs), exitCode: result.exitCode, status, stdoutSha256: digest(result.stdout), stderrSha256: digest(result.stderr), stdoutExcerpt: redact(result.stdout, limit), stderrExcerpt: redact(result.stderr, limit) }
}

function captureBlocked(common: Omit<CommandCapture, 'startedAt' | 'finishedAt' | 'durationMs' | 'exitCode' | 'status' | 'stdoutSha256' | 'stderrSha256' | 'stdoutExcerpt' | 'stderrExcerpt'>, startedAt: string, finished: number, reason: string, limit: number, status: VerificationStatus = 'blocked'): CommandCapture {
  return { ...common, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: Math.max(0, finished - Date.parse(startedAt)), status, stdoutSha256: digest(''), stderrSha256: digest(reason), stdoutExcerpt: '', stderrExcerpt: redact(reason, limit), reason }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function redact(value: string, limit: number): string {
  const redacted = value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(["']?)[^\s,"']+\2/giu, '$1=$2[REDACTED]$2')
    .replace(/AKIA[0-9A-Z]{16}/gu, '[REDACTED-AWS-KEY]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, '[REDACTED-PRIVATE-KEY]')
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}…`
}
