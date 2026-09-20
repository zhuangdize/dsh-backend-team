import { AuthorizationReview, type AuthorizationEvidence, type ProtectedOperation, type AuthorizationFinding } from './authorization-tests.js'
import { SecretScanner, type SecretFinding, type SecretScanInput } from './secret-scan.js'

export interface DependencySecurityFinding { readonly packageName: string; readonly severity: string; readonly fixVersions: readonly string[] }

export interface SecurityReviewInput {
  readonly files: readonly SecretScanInput[]
  readonly dependencyFindings?: readonly DependencySecurityFinding[]
  readonly protectedOperations?: readonly ProtectedOperation[]
  readonly authorizationEvidence?: readonly AuthorizationEvidence[]
}

export interface SecurityReviewFinding {
  readonly code: string
  readonly severity: 'block' | 'warning' | 'info'
  readonly message: string
  readonly path?: string
  readonly line?: number
  readonly evidenceHash?: string
}

export interface SecurityReviewReport {
  readonly status: 'passed' | 'blocked'
  readonly findings: readonly SecurityReviewFinding[]
}

/** Runs local, deterministic security checks over owned patch content and explicit evidence. */
export class SecurityReview {
  private readonly scanner = new SecretScanner()
  private readonly authorization = new AuthorizationReview()

  async run(input: SecurityReviewInput): Promise<SecurityReviewReport> {
    const findings: SecurityReviewFinding[] = []
    for (const file of input.files) {
      if (file.owned === false && file.approvedConfiguration !== true) continue
      for (const finding of this.scanner.scan(file)) findings.push(secretFinding(finding))
      findings.push(...scanCodeSmells(file.content, file.path))
    }
    for (const finding of input.dependencyFindings ?? []) if ((finding.severity === 'critical' || finding.severity === 'high') && finding.fixVersions.length === 0) findings.push({ code: 'UNPATCHED_SEVERE_DEPENDENCY', severity: 'block', message: `${finding.packageName} has an unpatched ${finding.severity} vulnerability` })
    const authorizationFindings = this.authorization.review(input.protectedOperations ?? [], input.authorizationEvidence ?? [])
    findings.push(...authorizationFindings.map(authorizationFinding))
    return Object.freeze({ status: findings.some((finding) => finding.severity === 'block') ? 'blocked' : 'passed', findings: Object.freeze(findings) })
  }

  async scanText(value: string): Promise<readonly SecurityReviewFinding[]> {
    return (await this.run({ files: [{ content: value }] })).findings
  }
}

export interface ProductionTarget { readonly kind: 'database' | 'service'; readonly host: string; readonly path?: string }

export class ProductionTargetDetector {
  detect(text: string): readonly ProductionTarget[] {
    const targets: ProductionTarget[] = []
    for (const match of text.matchAll(/\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s"'@]+@([^\s"'/]+)(?::\d+)?(?:\/([^\s"']*))?/giu)) {
      const host = match[1]
      if (host !== undefined && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase())) targets.push({ kind: 'database', host, ...(match[2] === undefined ? {} : { path: match[2] }) })
    }
    return Object.freeze(targets)
  }
}

function secretFinding(finding: SecretFinding): SecurityReviewFinding { return { code: finding.code, severity: finding.severity, message: finding.message, ...(finding.path === undefined ? {} : { path: finding.path }), ...(finding.line === undefined ? {} : { line: finding.line }), evidenceHash: finding.sha256 } }
function authorizationFinding(finding: AuthorizationFinding): SecurityReviewFinding { return { code: finding.code, severity: finding.severity, message: `${finding.operationId}: ${finding.message}` } }

function scanCodeSmells(content: string, path?: string): SecurityReviewFinding[] {
  const checks: Array<{ code: string; pattern: RegExp; message: string; severity: 'block' | 'warning' }> = [
    { code: 'SQL_INJECTION_SINK', pattern: /\b(?:query|execute|raw)\s*\(\s*[`"'][^`"']*(?:\$\{|\+\s*(?:req\.|request\.|user|input))/iu, message: 'dynamic user-controlled SQL is passed to a query sink', severity: 'block' },
    { code: 'COMMAND_INJECTION_SINK', pattern: /\b(?:exec|execFile|spawn)\s*\(\s*(?:req\.|request\.|user|input)/iu, message: 'user-controlled data is passed to a command execution sink', severity: 'block' },
    { code: 'UNSAFE_DESERIALIZATION', pattern: /\b(?:eval|Function)\s*\(|\bdeserialize\s*\(/u, message: 'unsafe dynamic deserialization or code evaluation is present', severity: 'block' },
    { code: 'SENSITIVE_LOGGING', pattern: /\b(?:console\.(?:log|info|debug)|logger\.(?:log|info|debug))\s*\([^\n]*(?:password|passwd|secret|token|api[_-]?key)/iu, message: 'sensitive credential data may be written to logs', severity: 'block' },
    { code: 'AUTH_BYPASS_PATTERN', pattern: /\b(?:skipAuth|disableAuth|authRequired)\s*[:=]\s*false\b/iu, message: 'an explicit authentication bypass pattern is present', severity: 'block' },
  ]
  return checks.flatMap((check) => {
    const match = check.pattern.exec(content)
    if (!match) return []
    const line = content.slice(0, match.index).split('\n').length
    return [{ code: check.code, severity: check.severity, message: check.message, ...(path === undefined ? {} : { path }), line }]
  })
}
