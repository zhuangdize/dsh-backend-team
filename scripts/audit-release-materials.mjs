import { access, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { verifyReleaseMaterials } from './release-materials.mjs'

const root = resolve(import.meta.dirname, '..')
const checks = []
const packageJson = await readJson('packages/bundle/package.json')
const runtimeManifest = await readJson('runtime-manifests/postgresql-18.6-darwin.json')
const dbgateManifest = await readJson('runtime-manifests/dbgate-7.2.3.json')
const dbgateAudit = await readJson('.backend-team/artifacts/dbgate-audit-current.json')
const tarballValue = value('--tarball')

check('bundle-version', packageJson?.version === '0.1.0' ? 'passed' : 'blocked', {
  expected: '0.1.0',
  actual: packageJson?.version ?? null,
})
const noticeFiles = await listExisting(['packages/bundle/LICENSES/THIRD_PARTY_NOTICES.md', 'packages/bundle/LICENSES'])
check('license-materials', noticeFiles.includes('packages/bundle/LICENSES/THIRD_PARTY_NOTICES.md') && noticeFiles.includes('packages/bundle/LICENSES') ? 'passed' : 'blocked', { files: noticeFiles })
check('postgresql-provenance', runtimeManifest?.status === 'verified' && Array.isArray(runtimeManifest?.artifacts) && runtimeManifest.artifacts.length === 2 ? 'passed' : 'blocked', {
  status: runtimeManifest?.status ?? 'missing',
  artifactCount: Array.isArray(runtimeManifest?.artifacts) ? runtimeManifest.artifacts.length : 0,
  reason: runtimeManifest?.status === 'verified' ? undefined : 'native Darwin arm64/x64 manifest is not verified',
})
check('dbgate-version-and-license', dbgateManifest?.component === 'dbgate' && dbgateManifest.version === '7.2.3' && dbgateManifest.packages?.every(packageEntry => packageEntry.version === '7.2.3' && packageEntry.license === 'GPL-3.0') === true ? 'passed' : 'blocked', {
  component: dbgateManifest?.component ?? null,
  version: dbgateManifest?.version ?? null,
  packages: dbgateManifest?.packages?.map(packageEntry => ({ name: packageEntry.name, version: packageEntry.version, license: packageEntry.license })) ?? [],
})
const dbgatePackageNames = dbgateManifest?.packages?.map(packageEntry => packageEntry.name).sort() ?? []
check('dbgate-postgresql-only-profile', dbgateManifest?.profile === 'postgresql-only' && JSON.stringify(dbgatePackageNames) === JSON.stringify(['dbgate-api', 'dbgate-plugin-postgres', 'dbgate-web']) ? 'passed' : 'blocked', {
  profile: dbgateManifest?.profile ?? null,
  packages: dbgatePackageNames,
  forbiddenPackages: ['dbgate-serve', 'dbgate-plugin-excel', 'xlsx'],
})

const vulnerabilities = dbgateAudit?.metadata?.vulnerabilities ?? {}
const residualRiskNames = Object.keys(dbgateManifest?.residualRisks ?? {})
const auditSource = dbgateAudit?.auditSource ?? 'unknown'
check('dbgate-security-review', vulnerabilities.critical === 0 && vulnerabilities.high === 0 && residualRiskNames.length === 0 && auditSource === 'registry' ? 'passed' : 'blocked', {
  npm: { critical: vulnerabilities.critical ?? null, high: vulnerabilities.high ?? null, moderate: vulnerabilities.moderate ?? null, total: vulnerabilities.total ?? null },
  residualRisks: residualRiskNames,
  auditSource,
  evidence: '.backend-team/artifacts/dbgate-audit-current.json',
  reason: auditSource === 'registry' ? undefined : 'fresh registry-backed npm audit is required; offline cache is not release evidence',
})

if (tarballValue === undefined) {
  check('archive-checksum-sbom', 'blocked', { reason: 'no tarball supplied; pass --tarball to verify archive sidecars' })
  check('release-signature-download', 'blocked', { reason: 'no material set supplied' })
} else {
  const tarball = resolve(root, tarballValue)
  try {
    const verified = await verifyReleaseMaterials({ root, tarball, channel: 'local-development' })
    check('archive-checksum-sbom', 'passed', { tarball: tarballValue, ...verified })
    const materials = await readJson(`${tarballValue}.materials.json`)
    const signatureStatus = materials?.distribution?.signature?.status
    const stableDownloadUrl = materials?.distribution?.stableDownloadUrl
    check('release-signature-download', signatureStatus === 'verified' && typeof stableDownloadUrl === 'string' && stableDownloadUrl.startsWith('https://') ? 'passed' : 'blocked', {
      signature: signatureStatus ?? 'missing',
      stableDownloadUrl: stableDownloadUrl ?? null,
      reason: 'local material set is unsigned and has no stable HTTPS download URL',
    })
  } catch (error) {
    check('archive-checksum-sbom', 'blocked', { tarball: tarballValue, reason: error instanceof Error ? error.message : String(error) })
    check('release-signature-download', 'blocked', { reason: 'archive material verification failed' })
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: checks.every(entry => entry.status === 'passed') ? 'passed' : 'blocked',
  checks,
  releaseBoundary: {
    localDevelopment: 'checksum-and-SBOM-materials-allowed',
    releaseCandidate: 'requires-signed-materials-stable-download-and-all-gates',
  },
}
const output = value('--output')
if (output !== undefined) await writeFile(resolve(root, output), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

function check(id, status, details) { checks.push({ id, status, details }) }
function value(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
async function readJson(path) { try { return JSON.parse(await readFile(resolve(root, path), 'utf8')) } catch { return undefined } }
async function listExisting(paths) { const result = []; for (const path of paths) { try { await access(resolve(root, path), constants.R_OK); result.push(path) } catch {} } return result }
