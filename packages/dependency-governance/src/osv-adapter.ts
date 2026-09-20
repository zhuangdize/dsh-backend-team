import type { DependencyProposal } from './dependency-proposal.js'
import type { FindingSeverity, SecurityFinding } from './npm-audit-adapter.js'

export interface OsvFetcher { fetch(input: string | URL, init?: RequestInit): Promise<Response> }

/** Normalizes both detailed OSV records and the querybatch ID-only response. */
export function normalizeOsvResponse(payload: unknown, packageNames: readonly string[] = []): SecurityFinding[] {
  if (!payload || typeof payload !== 'object') return []
  const results = (payload as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const findings: SecurityFinding[] = []
  results.forEach((result, index) => {
    if (!result || typeof result !== 'object') return
    const record = result as Record<string, unknown>
    const packages = Array.isArray(record.packages) ? record.packages : []
    for (const pkg of packages) {
      if (!pkg || typeof pkg !== 'object') continue
      const packageInfo = (pkg as { package?: { name?: unknown } }).package
      const name = typeof packageInfo?.name === 'string' ? packageInfo.name : undefined
      if (name === undefined) continue
      const vulnerabilities = Array.isArray((pkg as { vulnerabilities?: unknown }).vulnerabilities) ? (pkg as { vulnerabilities: unknown[] }).vulnerabilities : []
      for (const vulnerability of vulnerabilities) {
        const finding = normalizeVulnerability(vulnerability, name)
        if (finding !== undefined) findings.push(finding)
      }
    }
    const ids = Array.isArray(record.vulns) ? record.vulns : []
    for (const vulnerability of ids) {
      if (!vulnerability || typeof vulnerability !== 'object') continue
      const id = (vulnerability as { id?: unknown }).id
      if (typeof id === 'string') findings.push({ id, packageName: packageNames[index] ?? 'unknown', severity: 'unknown', fixVersions: [], source: 'osv' })
    }
  })
  return findings
}

export class OsvAdapter {
  constructor(private readonly fetcher: OsvFetcher = globalThis, private readonly endpoint = 'https://api.osv.dev/v1/querybatch') {}

  async query(proposal: DependencyProposal, signal?: AbortSignal): Promise<SecurityFinding[]> {
    const packages = [{ name: proposal.name, version: proposal.version }, ...proposal.transitive.map((item) => ({ name: item.name, version: item.version }))]
    const seen = new Set<string>()
    const queries = packages.filter((item) => { const key = `${item.name}@${item.version}`; if (seen.has(key)) return false; seen.add(key); return true }).map((item) => ({ package: { name: item.name, ecosystem: 'npm' }, version: item.version }))
    const ids: Array<{ readonly id: string; readonly packageName: string }> = []
    let pending: Array<{ readonly query: typeof queries[number]; readonly pageToken?: string }> = queries.map((query) => ({ query }))
    for (let page = 0; pending.length > 0; page += 1) {
      if (page >= 8) throw new Error('OSV query pagination limit exceeded')
      const response = await this.fetcher.fetch(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: pending.map((item) => ({ ...item.query, ...(item.pageToken === undefined ? {} : { page_token: item.pageToken }) })) }), ...(signal === undefined ? {} : { signal }) })
      if (!response.ok) throw new Error(`OSV query failed with HTTP ${response.status}`)
      const payload = await response.json() as unknown
      if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { results?: unknown }).results)) throw new Error('OSV query returned an invalid response')
      const results = (payload as { results: unknown[] }).results
      const next: Array<{ readonly query: typeof queries[number]; readonly pageToken: string }> = []
      pending.forEach((item, index) => {
        const result = results[index]
        if (!result || typeof result !== 'object') throw new Error('OSV query result ordering is invalid')
        const record = result as Record<string, unknown>
        const vulnerabilities = Array.isArray(record.vulns) ? record.vulns : []
        for (const vulnerability of vulnerabilities) {
          if (vulnerability && typeof vulnerability === 'object' && typeof (vulnerability as { id?: unknown }).id === 'string') ids.push({ id: (vulnerability as { id: string }).id, packageName: item.query.package.name })
        }
        if (typeof record.next_page_token === 'string' && record.next_page_token.length > 0) next.push({ query: item.query, pageToken: record.next_page_token })
      })
      pending = next
    }
    const unique = [...new Map(ids.map((item) => [`${item.packageName}:${item.id}`, item])).values()]
    const findings: SecurityFinding[] = []
    for (const item of unique) {
      const detailUrl = new URL(`/v1/vulns/${encodeURIComponent(item.id)}`, this.endpoint).toString()
      const response = await this.fetcher.fetch(detailUrl, { ...(signal === undefined ? {} : { signal }) })
      if (!response.ok) throw new Error(`OSV vulnerability detail failed with HTTP ${response.status}`)
      const finding = normalizeVulnerability(await response.json() as unknown, item.packageName)
      if (finding === undefined) throw new Error(`OSV vulnerability detail is invalid: ${item.id}`)
      findings.push(finding)
    }
    return findings
  }
}

function normalizeVulnerability(value: unknown, packageName: string): SecurityFinding | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : undefined
  if (id === undefined) return undefined
  const affected = Array.isArray(record.affected) ? record.affected : []
  const fixes = affected.flatMap((item) => item && typeof item === 'object' && Array.isArray((item as { ranges?: unknown }).ranges) ? (item as { ranges: unknown[] }).ranges.flatMap((range) => range && typeof range === 'object' && Array.isArray((range as { events?: unknown }).events) ? (range as { events: unknown[] }).events.flatMap((event) => event && typeof event === 'object' && typeof (event as { fixed?: unknown }).fixed === 'string' ? [(event as { fixed: string }).fixed] : []) : []) : [])
  return { id, packageName, severity: severityOf(record), vulnerableRange: undefined, fixVersions: [...new Set(fixes)], source: 'osv', title: typeof record.summary === 'string' ? record.summary : undefined }
}

function severityOf(record: Record<string, unknown>): FindingSeverity {
  const databaseSpecific = record.database_specific
  const label = databaseSpecific && typeof databaseSpecific === 'object' ? (databaseSpecific as { severity?: unknown }).severity : undefined
  if (typeof label === 'string') {
    const normalized = label.toLowerCase()
    if (normalized === 'critical' || normalized === 'high' || normalized === 'moderate' || normalized === 'low') return normalized
  }
  const severities = Array.isArray(record.severity) ? record.severity : []
  const scores = severities.map((item) => item && typeof item === 'object' ? Number((item as { score?: unknown }).score) : NaN).filter(Number.isFinite)
  return osvSeverity(Math.max(...scores, 0))
}

function osvSeverity(score: number): FindingSeverity {
  if (score >= 9) return 'critical'
  if (score >= 7) return 'high'
  if (score >= 4) return 'moderate'
  if (score > 0) return 'low'
  return 'unknown'
}
