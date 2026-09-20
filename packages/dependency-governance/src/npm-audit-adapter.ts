import { resolve } from 'node:path'

export type FindingSeverity = 'unknown' | 'low' | 'moderate' | 'high' | 'critical'
export interface SecurityFinding { id?: string | undefined; packageName: string; severity: FindingSeverity; vulnerableRange?: string | undefined; fixVersions: string[]; source: 'npm-audit' | 'osv'; title?: string | undefined; sources?: string[] | undefined }

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface NpmAuditCommandRunner { run(executable: string, args: string[], options: { cwd: string; env?: Record<string, string>; signal?: AbortSignal | undefined }): Promise<CommandResult> }

export function normalizeNpmAudit(payload: unknown): SecurityFinding[] {
  if (!payload || typeof payload !== 'object') return []
  const vulnerabilities = (payload as { vulnerabilities?: unknown }).vulnerabilities
  if (!vulnerabilities || typeof vulnerabilities !== 'object') return []
  const findings: SecurityFinding[] = []
  for (const [packageName, raw] of Object.entries(vulnerabilities as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const value = raw as { severity?: unknown; via?: unknown; fixAvailable?: unknown; range?: unknown }
    const via = Array.isArray(value.via) ? value.via : []
      const records = via.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    if (records.length === 0) records.push({})
    for (const item of records) {
      const fix = typeof value.fixAvailable === 'object' && value.fixAvailable !== null ? value.fixAvailable as { version?: unknown } : undefined
      const itemFix = typeof item.fixAvailable === 'object' && item.fixAvailable !== null ? item.fixAvailable as { version?: unknown } : undefined
      const fixed = typeof itemFix?.version === 'string' ? [itemFix.version] : typeof fix?.version === 'string' ? [fix.version] : []
      findings.push({ id: typeof item.source === 'number' ? `npm-${item.source}` : undefined, packageName, severity: severity(value.severity), vulnerableRange: typeof item.range === 'string' ? item.range : typeof value.range === 'string' ? value.range : undefined, fixVersions: fixed, source: 'npm-audit', title: typeof item.title === 'string' ? item.title : undefined })
    }
  }
  return findings
}

export class NpmAuditAdapter {
  private readonly options: { npmExecutable: string; cwd: string; workspaceRoot: string }

  constructor(private readonly runner: NpmAuditCommandRunner, options: { npmExecutable: string; cwd: string; workspaceRoot: string }) {
    const normalized = { npmExecutable: resolve(options.npmExecutable), cwd: resolve(options.cwd), workspaceRoot: resolve(options.workspaceRoot) }
    if (!options.npmExecutable.startsWith('/') || !options.workspaceRoot.startsWith('/') || !inside(normalized.workspaceRoot, normalized.npmExecutable) || !inside(normalized.workspaceRoot, normalized.cwd) || !/(?:^|\/)npm$/u.test(normalized.npmExecutable)) throw new Error('npm audit requires an absolute workspace-local npm executable and cwd')
    this.options = normalized
  }
  async query(signal?: AbortSignal): Promise<SecurityFinding[]> {
    const teamRoot = `${this.options.workspaceRoot}/.backend-team`
    const env = { PATH: this.options.npmExecutable.slice(0, this.options.npmExecutable.lastIndexOf('/')), HOME: `${teamRoot}/home`, TMPDIR: `${teamRoot}/tmp`, NPM_CONFIG_USERCONFIG: `${teamRoot}/config/npmrc`, NPM_CONFIG_CACHE: `${teamRoot}/cache/npm`, NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_AUDIT: 'true', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false' }
    const result = await this.runner.run(this.options.npmExecutable, ['audit', '--json', '--ignore-scripts'], { cwd: this.options.cwd, env, signal })
    if (result.code !== 0) throw new Error(`npm audit failed with exit code ${result.code}: ${result.stderr}`)
    if (!result.stdout.trim()) throw new Error('npm audit returned no JSON output')
    return normalizeNpmAudit(JSON.parse(result.stdout) as unknown)
  }
}

function inside(root: string, target: string): boolean {
  const normalizedRoot = root.replace(/\/+$/u, '')
  return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`)
}

function severity(input: unknown): FindingSeverity {
  return input === 'low' || input === 'moderate' || input === 'high' || input === 'critical' ? input : 'unknown'
}
