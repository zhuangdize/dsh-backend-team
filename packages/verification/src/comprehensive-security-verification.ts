import { SecurityReview, type SecurityReviewInput, type SecurityReviewReport } from './security-review.js'

export interface SecurityEvidenceCheck {
  readonly id: string
  readonly kind: 'database' | 'api' | 'openapi' | 'migration' | 'startup' | 'health' | 'contract' | 'custom'
  readonly required: boolean
  readonly run: () => Promise<{ readonly status: 'passed' | 'failed' | 'blocked' | 'not-run'; readonly message?: string }>
}

export interface ComprehensiveSecurityInput extends SecurityReviewInput {
  readonly checks?: readonly SecurityEvidenceCheck[]
}

export interface ComprehensiveSecurityFinding {
  readonly code: string
  readonly severity: 'block' | 'warning' | 'info'
  readonly message: string
  readonly checkId?: string
}

export interface ComprehensiveSecurityReport {
  readonly status: 'passed' | 'blocked'
  readonly findings: readonly ComprehensiveSecurityFinding[]
  readonly security: SecurityReviewReport
}

/** Combines local secret/auth review with applicable DB/API/contract evidence. */
export class ComprehensiveSecurityReview {
  private readonly local = new SecurityReview()

  async run(input: ComprehensiveSecurityInput): Promise<ComprehensiveSecurityReport> {
    const security = await this.local.run(input)
    const findings: ComprehensiveSecurityFinding[] = security.findings.map(finding => ({ code: finding.code, severity: finding.severity, message: finding.message, ...(finding.path === undefined ? {} : { checkId: finding.path }) }))
    for (const check of input.checks ?? []) {
      let result: { readonly status: 'passed' | 'failed' | 'blocked' | 'not-run'; readonly message?: string }
      try { result = await check.run() } catch (error: unknown) { result = { status: 'blocked', message: error instanceof Error ? error.message : String(error) } }
      if (result.status === 'failed' || result.status === 'blocked' || (result.status === 'not-run' && check.required)) findings.push({ code: result.status === 'not-run' ? 'REQUIRED_SECURITY_CHECK_NOT_RUN' : 'SECURITY_CHECK_FAILED', severity: 'block', message: result.message ?? `${check.kind} security check did not pass`, checkId: check.id })
      else if (result.status === 'not-run') findings.push({ code: 'OPTIONAL_SECURITY_CHECK_NOT_RUN', severity: 'warning', message: result.message ?? `${check.kind} check was not applicable or not run`, checkId: check.id })
    }
    return Object.freeze({ status: findings.some(finding => finding.severity === 'block') ? 'blocked' : 'passed', findings: Object.freeze(findings), security })
  }
}
