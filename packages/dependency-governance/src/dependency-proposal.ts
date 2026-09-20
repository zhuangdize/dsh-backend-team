import type { SecurityFinding } from './npm-audit-adapter.js'
import { LicensePolicy, type LicenseClassification } from './license-policy.js'
import { LifecyclePolicy, type LifecycleScript } from './lifecycle-policy.js'

export interface MaintenanceEvidence {
  lastRelease: string
  repositoryArchived: boolean
  evidence: string
}

export interface DependencyProposal {
  name: string
  version: string
  type: 'runtime' | 'development' | 'optional' | 'peer'
  purpose: string
  alternatives: string[]
  repository: string
  licenses: string[]
  transitive: Array<{ name: string; version: string; licenses: string[]; source?: string }>
  maintenance: MaintenanceEvidence
  lifecycleScripts: Record<string, string> | LifecycleScript[]
  telemetry: string
  network: string
  replacementPath: string
  requestedFiles: string[]
  projectKind?: 'new-project' | 'existing-project'
}

export type DependencyDecisionEffect = 'allow' | 'deny' | 'ask-special-license-review' | 'blocked'

export interface DependencyDecision {
  effect: DependencyDecisionEffect
  reasons: string[]
  findings: SecurityFinding[]
  licenseClassifications: LicenseClassification[]
  lifecycle: ReturnType<LifecyclePolicy['review']>
  sbom?: import('./sbom.js').CycloneDxBom
}

export interface DependencyGovernanceAdapters {
  npmAudit: (proposal: DependencyProposal, options: { signal?: AbortSignal | undefined }) => Promise<SecurityFinding[]>
  osv: (proposal: DependencyProposal, options: { signal?: AbortSignal | undefined }) => Promise<SecurityFinding[]>
}

export interface DependencyGovernanceOptions {
  npmAudit?: DependencyGovernanceAdapters['npmAudit']
  osv?: DependencyGovernanceAdapters['osv']
  licensePolicy?: LicensePolicy
  lifecyclePolicy?: LifecyclePolicy
}

const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export class DependencyGovernance {
  readonly licensePolicy: LicensePolicy
  readonly lifecyclePolicy: LifecyclePolicy
  private readonly adapters: DependencyGovernanceAdapters

  constructor(options: DependencyGovernanceOptions = {}) {
    this.licensePolicy = options.licensePolicy ?? new LicensePolicy()
    this.lifecyclePolicy = options.lifecyclePolicy ?? new LifecyclePolicy()
    this.adapters = {
      npmAudit: options.npmAudit ?? (async () => { throw new Error('npm audit adapter is not configured') }),
      osv: options.osv ?? (async () => { throw new Error('OSV adapter is not configured') }),
    }
  }

  async review(proposal: DependencyProposal, options: { networkApproved?: boolean; installApproved?: boolean; signal?: AbortSignal; sbom?: import('./sbom.js').CycloneDxBom } = {}): Promise<DependencyDecision> {
    const reasons: string[] = []
    const classifications = proposal.licenses.map((license) => this.licensePolicy.explain(license))
    const allLicenses = [...proposal.licenses, ...proposal.transitive.flatMap((item) => item.licenses)]
    if (allLicenses.length === 0 || allLicenses.some((license) => this.licensePolicy.classify(license) === 'unknown')) reasons.push('every direct and transitive dependency must have a confirmed SPDX license')
    if (!exactVersion.test(proposal.version)) reasons.push(`dependency ${proposal.name} must use an exact version`)
    if (proposal.maintenance.repositoryArchived) reasons.push('dependency repository is archived')
    if (!proposal.purpose.trim() || proposal.alternatives.length === 0 || !proposal.replacementPath.trim()) reasons.push('proposal must document purpose, an alternative, and a replacement path')
    for (const dependency of proposal.transitive) {
      if (!exactVersion.test(dependency.version)) reasons.push(`transitive dependency ${dependency.name} must use an exact version`)
      if (dependency.licenses.length === 0 || dependency.licenses.some((license) => this.licensePolicy.classify(license) === 'unknown')) reasons.push(`transitive dependency ${dependency.name} must have a confirmed SPDX license`)
    }

    const lifecycle = this.lifecyclePolicy.review(proposal.lifecycleScripts)
    if (lifecycle.scripts.length > 0) reasons.push('dependency lifecycle scripts require separate approval')
    if (options.installApproved !== true) reasons.push('dependency installation approval is required')

    let findings: SecurityFinding[] = []
    let securityCheckBlocked = false
    if (options.networkApproved !== true) {
      reasons.push('network approval is required for the two-source vulnerability check')
    } else {
      try {
        const [npm, osv] = await Promise.all([this.adapters.npmAudit(proposal, { signal: options.signal }), this.adapters.osv(proposal, { signal: options.signal })])
        findings = mergeFindings([...npm, ...osv])
        if (findings.some((finding) => isUnpatchedSevere(finding))) reasons.push('a severe vulnerability has no reviewed fixed version')
        if (findings.some((finding) => finding.severity === 'unknown')) reasons.push('a vulnerability severity could not be normalized')
      } catch (error: unknown) {
        securityCheckBlocked = true
        reasons.push(`two-source vulnerability check unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const specialLicense = allLicenses.some((license) => this.licensePolicy.classify(license) === 'special-review')
    const unknownLicense = allLicenses.length === 0 || allLicenses.some((license) => this.licensePolicy.classify(license) === 'unknown')
    const effect: DependencyDecisionEffect = unknownLicense || reasons.some((reason) => reason.includes('severe vulnerability') || reason.includes('severity could not') || reason.includes('exact version') || reason.includes('archived') || reason.includes('purpose') || reason.includes('confirmed SPDX'))
      ? 'deny'
      : options.networkApproved !== true || securityCheckBlocked || options.installApproved !== true
        ? 'blocked'
        : specialLicense || lifecycle.scripts.length > 0
          ? 'ask-special-license-review'
          : 'allow'
    return { effect, reasons, findings, licenseClassifications: classifications, lifecycle, ...(options.sbom === undefined ? {} : { sbom: options.sbom }) }
  }
}

function isUnpatchedSevere(finding: SecurityFinding): boolean {
  return (finding.severity === 'critical' || finding.severity === 'high') && finding.fixVersions.length === 0
}

function mergeFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const byKey = new Map<string, SecurityFinding>()
  for (const finding of findings) {
    const key = `${finding.packageName}:${finding.id ?? finding.vulnerableRange ?? finding.title ?? 'unknown'}`
    const current = byKey.get(key)
    if (!current) byKey.set(key, { ...finding, fixVersions: [...new Set(finding.fixVersions)] })
    else byKey.set(key, { ...current, fixVersions: [...new Set([...current.fixVersions, ...finding.fixVersions])], sources: [...new Set([...(current.sources ?? [current.source]), ...(finding.sources ?? [finding.source])])] })
  }
  return [...byKey.values()]
}
