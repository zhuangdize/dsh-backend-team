import { createHash } from 'node:crypto'

export type SecretFindingSeverity = 'block' | 'warning'
export interface SecretFinding {
  readonly code: 'SECRET_CREDENTIAL' | 'PRIVATE_KEY' | 'PRODUCTION_TARGET' | 'HIGH_ENTROPY_SECRET'
  readonly severity: SecretFindingSeverity
  readonly path?: string
  readonly line?: number
  readonly message: string
  readonly sha256: string
  readonly redactedExcerpt: string
}

export interface SecretScanInput { readonly path?: string; readonly content: string; readonly owned?: boolean; readonly approvedConfiguration?: boolean }

/** Deterministic secret and production-target scanner; values never appear in findings. */
export class SecretScanner {
  scan(input: SecretScanInput): readonly SecretFinding[] { return scanSecrets(input.content, input.path) }
}

export function scanSecrets(content: string, path?: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = []
  const seen = new Set<string>()
  const add = (code: SecretFinding['code'], severity: SecretFindingSeverity, message: string, match: string, index: number): void => {
    const line = content.slice(0, index).split('\n').length
    const key = `${code}:${line}:${message}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ code, severity, ...(path === undefined ? {} : { path }), line, message, sha256: createHash('sha256').update(match).digest('hex'), redactedExcerpt: redact(match) })
  }
  for (const match of content.matchAll(/AKIA[0-9A-Z]{16}/gu)) add('SECRET_CREDENTIAL', 'block', 'AWS access key material is present', match[0], match.index ?? 0)
  for (const match of content.matchAll(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gu)) add('PRIVATE_KEY', 'block', 'private key material is present', match[0], match.index ?? 0)
  for (const match of content.matchAll(/(?:postgres(?:ql)?|mysql|redis):\/\/[^\s"']+:[^\s"'@]+@[^\s"']+/giu)) add('SECRET_CREDENTIAL', 'block', 'credential-bearing service URL is present', match[0], match.index ?? 0)
  for (const match of content.matchAll(/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']([^"']{8,})["']/giu)) add('HIGH_ENTROPY_SECRET', 'block', 'credential-like value is present', match[0], match.index ?? 0)
  for (const match of content.matchAll(/\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s"'@]+@([^\s"'/]+)(?::\d+)?(?:\/[^\s"']*)?/giu)) {
    const host = match[1]?.toLowerCase()
    if (host !== undefined && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) add('PRODUCTION_TARGET', 'block', 'service URL targets a non-loopback host', match[0], match.index ?? 0)
  }
  return Object.freeze(findings)
}

function redact(value: string): string {
  return value.replace(/(password|passwd|secret|token|key)\s*[:=]\s*["']?[^\s,"']+/giu, '$1=[REDACTED]').replace(/AKIA[0-9A-Z]{16}/gu, '[REDACTED-AWS-KEY]').replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gu, '[REDACTED-PRIVATE-KEY]').replace(/:\/\/[^\s"']+@/gu, '://[REDACTED]@')
}
