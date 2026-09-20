export type LicenseClassificationKind = 'normal-review' | 'special-review' | 'unknown'
export interface LicenseClassification { license: string; kind: LicenseClassificationKind; reason: string }

const NORMAL = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'PostgreSQL', '0BSD'])
const SPECIAL = new Set(['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'SSPL-1.0', 'EPL-1.0', 'EPL-2.0', 'MPL-2.0'])

export class LicensePolicy {
  classify(input: string): LicenseClassificationKind {
    const license = input.trim()
    if (NORMAL.has(license)) return 'normal-review'
    if (SPECIAL.has(license)) return 'special-review'
    return 'unknown'
  }

  explain(input: string): LicenseClassification {
    const license = input.trim()
    const kind = this.classify(license)
    return { license, kind, reason: kind === 'normal-review' ? 'permissive or project-compatible license' : kind === 'special-review' ? 'reciprocal or source-available terms require distribution review' : 'license was not verified against the approved SPDX set' }
  }
}
