import { scanSecrets } from '@dsh-backend-team/verification'

/** No source excerpts or credential values cross the tool/report boundary. */
export function checkCredentials(files: readonly { path: string; content: string }[]) {
  const findings = files.flatMap(file => scanSecrets(file.content, file.path)
    .filter(finding => finding.code !== 'PRODUCTION_TARGET')
    .map(({ code, severity, path, line, message }) => ({ code, severity, path, line, message })))
  return {
    status: findings.some(finding => finding.severity === 'block') ? 'blocked' as const : 'passed' as const,
    scope: '仅检查声明产物中的常见凭据与私钥模式；不代表完整安全审计。',
    findings: findings.slice(0, 100),
    omittedFindings: Math.max(0, findings.length - 100),
  }
}
