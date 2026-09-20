import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Build the release sidecars which bind a Bundle archive to its lockfile,
 * license notice and reviewed runtime inputs. The sidecars contain no
 * credentials and are useful for local-development releases as well as CI.
 */
export async function writeReleaseMaterials({ root, tarball, channel, packageFiles = [], runtimeManifestPath, evidencePath, agentFixturePath, distribution }) {
  const workspaceRoot = resolve(root)
  const archive = resolve(tarball)
  const archiveStat = await stat(archive).catch(() => undefined)
  if (!archiveStat?.isFile()) throw new Error('release materials require an actual Bundle tarball')

  const lockPath = resolve(workspaceRoot, 'package-lock.json')
  const packagePath = resolve(workspaceRoot, 'packages/bundle/package.json')
  const noticePath = resolve(workspaceRoot, 'packages/bundle/LICENSES/THIRD_PARTY_NOTICES.md')
  const lockfile = JSON.parse(await readFile(lockPath, 'utf8'))
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  await readFile(noticePath)

  const archiveSha256 = await sha256File(archive)
  const normalizedDistribution = normalizeDistribution(distribution, archiveSha256)
  const sbom = buildCycloneDxBomFromPackageLock(lockfile, serialFromDigest(archiveSha256))
  const sbomPath = `${archive}.cdx.json`
  await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8')
  const sbomSha256 = await sha256File(sbomPath)
  const checksumPath = `${archive}.sha256`
  await writeFile(checksumPath, `${archiveSha256}  ${archive.split('/').at(-1)}\n`, 'utf8')

  const materialsPath = `${archive}.materials.json`
  const materials = {
    schemaVersion: 1,
    channel,
    bundle: {
      filename: archive.split('/').at(-1),
      bytes: archiveStat.size,
      sha256: archiveSha256,
      packageVersion: packageJson.version,
      files: [...packageFiles].map(file => file.startsWith('package/') ? file : `package/${file}`).sort(),
    },
    sbom: {
      filename: sbomPath.split('/').at(-1),
      format: 'CycloneDX',
      specVersion: sbom.specVersion,
      sha256: sbomSha256,
      componentCount: sbom.components.length,
    },
    inputs: {
      packageLock: inputDigest(workspaceRoot, lockPath, await sha256File(lockPath)),
      bundlePackage: inputDigest(workspaceRoot, packagePath, await sha256File(packagePath)),
      thirdPartyNotice: inputDigest(workspaceRoot, noticePath, await sha256File(noticePath)),
      ...(runtimeManifestPath === undefined ? {} : { runtimeManifest: await digestIfPresent(workspaceRoot, runtimeManifestPath) }),
      ...(evidencePath === undefined ? {} : { releaseEvidence: await digestIfPresent(workspaceRoot, evidencePath) }),
      ...(agentFixturePath === undefined ? {} : { agentFixture: await digestIfPresent(workspaceRoot, agentFixturePath) }),
    },
    distribution: normalizedDistribution,
  }
  await writeFile(materialsPath, `${JSON.stringify(materials, null, 2)}\n`, 'utf8')
  return { archiveSha256, checksumPath, sbomPath, sbomSha256, materialsPath }
}

export async function verifyReleaseMaterials({ root, tarball, channel = 'local-development' }) {
  const workspaceRoot = resolve(root)
  const archive = resolve(tarball)
  const archiveStat = await stat(archive).catch(() => undefined)
  if (!archiveStat?.isFile()) throw new Error('release materials require an actual Bundle tarball')
  const checksumPath = `${archive}.sha256`
  const checksum = (await readFile(checksumPath, 'utf8')).trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/u)
  const archiveSha256 = await sha256File(archive)
  if (!checksum || checksum[1] !== archiveSha256 || checksum[2].split('/').at(-1) !== archive.split('/').at(-1)) throw new Error('Bundle checksum does not match the archive')

  const sbomPath = `${archive}.cdx.json`
  const sbom = JSON.parse(await readFile(sbomPath, 'utf8'))
  assertSbom(sbom)
  const sbomSha256 = await sha256File(sbomPath)
  const materialsPath = `${archive}.materials.json`
  const materials = JSON.parse(await readFile(materialsPath, 'utf8'))
  if (materials.schemaVersion !== 1 || materials.bundle?.filename !== archive.split('/').at(-1) || materials.bundle?.sha256 !== archiveSha256 || materials.sbom?.filename !== sbomPath.split('/').at(-1) || materials.sbom?.sha256 !== sbomSha256 || materials.sbom?.componentCount !== sbom.components.length) throw new Error('release materials do not match the archive and SBOM')
  const lockPath = resolve(workspaceRoot, 'package-lock.json')
  const expectedLockDigest = await sha256File(lockPath)
  if (materials.inputs?.packageLock?.sha256 !== expectedLockDigest) throw new Error('release materials package-lock digest is stale')
  const lockfile = JSON.parse(await readFile(lockPath, 'utf8'))
  const expectedBom = buildCycloneDxBomFromPackageLock(lockfile, sbom.serialNumber)
  const expectedRefs = expectedBom.components.map(component => component['bom-ref']).sort()
  const actualRefs = sbom.components.map(component => component['bom-ref']).sort()
  if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) throw new Error('Bundle SBOM components do not match package-lock')
  const packagePath = resolve(workspaceRoot, 'packages/bundle/package.json')
  if (materials.inputs?.bundlePackage?.sha256 !== await sha256File(packagePath)) throw new Error('release materials Bundle package digest is stale')
  const noticePath = resolve(workspaceRoot, 'packages/bundle/LICENSES/THIRD_PARTY_NOTICES.md')
  if (materials.inputs?.thirdPartyNotice?.sha256 !== await sha256File(noticePath)) throw new Error('release materials license notice digest is stale')
  for (const [name, input] of Object.entries(materials.inputs ?? {})) {
    if (!input || name === 'packageLock' || name === 'bundlePackage' || name === 'thirdPartyNotice') continue
    if (typeof input.path !== 'string' || typeof input.sha256 !== 'string') throw new Error(`release materials ${name} input is malformed`)
    const inputPath = resolve(workspaceRoot, input.path)
    const escaped = relative(workspaceRoot, inputPath)
    if (isAbsolute(escaped) || escaped === '..' || escaped.startsWith(`..${sep}`)) throw new Error(`release materials ${name} input escapes workspace`)
    if (await sha256File(inputPath) !== input.sha256) throw new Error(`release materials ${name} digest is stale`)
  }
  if (!Array.isArray(materials.bundle.files) || !materials.bundle.files.includes('package/LICENSES/THIRD_PARTY_NOTICES.md')) throw new Error('Bundle archive is missing the third-party license notice')
  assertDistribution(materials.distribution, archiveSha256)
  if (channel === 'release-candidate') {
    if (materials.distribution?.signature?.status !== 'verified') throw new Error('release candidate signature is not verified')
    if (typeof materials.distribution?.stableDownloadUrl !== 'string' || !materials.distribution.stableDownloadUrl.startsWith('https://')) throw new Error('release candidate stable download URL is missing')
  }
  return { archiveSha256, sbomSha256, componentCount: sbom.components.length, materialsPath }
}

function buildCycloneDxBomFromPackageLock(lockfile, serial) {
  const packages = lockfile && typeof lockfile === 'object' && lockfile.packages
  const components = []
  const entries = []
  if (packages && typeof packages === 'object') {
    for (const [path, raw] of Object.entries(packages)) {
      if (!path.startsWith('node_modules/') || !raw || typeof raw !== 'object' || typeof raw.version !== 'string') continue
      const name = typeof raw.name === 'string' ? raw.name : path.slice('node_modules/'.length)
      const purl = `pkg:npm/${name.replace(/^@/, '%40').replace('/', '%2F')}@${raw.version}`
      const integrity = typeof raw.integrity === 'string' ? raw.integrity : undefined
      const hash = integrity?.startsWith('sha512-') === true ? Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex') : undefined
      const licenses = typeof raw.license === 'string' ? [raw.license] : []
      components.push({ 'bom-ref': purl, type: 'library', name, version: raw.version, purl, ...(hash === undefined ? {} : { hashes: [{ alg: 'SHA-512', content: hash }] }), licenses: licenses.map(license => ({ license: { id: license } })) })
      const dependencyNames = raw.dependencies && typeof raw.dependencies === 'object' ? Object.keys(raw.dependencies) : []
      entries.push({ path, name, purl, dependencyNames })
    }
  }
  const byName = new Map()
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) if (!byName.has(entry.name)) byName.set(entry.name, entry.purl)
  const dependencies = entries.map(entry => ({ ref: entry.purl, dependsOn: [...new Set(entry.dependencyNames.map(name => byName.get(name)).filter(Boolean))].sort() })).filter(entry => entry.dependsOn.length > 0)
  return { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: serial, version: 1, components, ...(dependencies.length === 0 ? {} : { dependencies }) }
}

function assertSbom(value) {
  if (!value || typeof value !== 'object' || value.bomFormat !== 'CycloneDX' || value.specVersion !== '1.5' || value.version !== 1 || !Array.isArray(value.components) || value.components.length === 0 || typeof value.serialNumber !== 'string' || value.serialNumber.length === 0) throw new Error('Bundle SBOM is missing or malformed')
}

function normalizeDistribution(value, archiveSha256) {
  if (value === undefined) return { signature: { status: 'not-attested', provider: null, evidenceRef: null, artifactSha256: null }, stableDownloadUrl: null, runtimeProvenance: 'external-release-gate' }
  assertRecord(value, 'release distribution')
  const rawSignature = value.signature === undefined ? {} : value.signature
  assertRecord(rawSignature, 'release distribution signature')
  const status = rawSignature.status === undefined ? 'not-attested' : rawSignature.status
  if (status !== 'not-attested' && status !== 'verified') throw new Error('release distribution signature status must be not-attested or verified')
  const stableDownloadUrl = value.stableDownloadUrl === undefined ? null : value.stableDownloadUrl
  if (stableDownloadUrl !== null && !isHttpsUrl(stableDownloadUrl)) throw new Error('release distribution stable download URL must use HTTPS without credentials')
  if (status === 'verified') {
    const provider = nonEmptyString(rawSignature.provider, 'release distribution signature provider')
    const evidenceRef = nonEmptyString(rawSignature.evidenceRef, 'release distribution signature evidenceRef')
    if (rawSignature.artifactSha256 !== archiveSha256) throw new Error('release distribution signature digest does not match the Bundle archive')
    return { signature: { status, provider, evidenceRef, artifactSha256: archiveSha256 }, stableDownloadUrl, runtimeProvenance: nonEmptyString(value.runtimeProvenance ?? 'external-release-gate', 'release distribution runtimeProvenance') }
  }
  if (stableDownloadUrl !== null || (rawSignature.provider !== undefined && rawSignature.provider !== null) || (rawSignature.evidenceRef !== undefined && rawSignature.evidenceRef !== null) || (rawSignature.artifactSha256 !== undefined && rawSignature.artifactSha256 !== null)) throw new Error('release distribution metadata requires a verified signature')
  return { signature: { status, provider: null, evidenceRef: null, artifactSha256: null }, stableDownloadUrl: null, runtimeProvenance: nonEmptyString(value.runtimeProvenance ?? 'external-release-gate', 'release distribution runtimeProvenance') }
}

function assertDistribution(value, archiveSha256) {
  assertRecord(value, 'release distribution')
  const signature = value.signature
  assertRecord(signature, 'release distribution signature')
  const status = signature.status === undefined ? 'not-attested' : signature.status
  if (status === 'verified') {
    const normalized = normalizeDistribution(value, archiveSha256)
    if (JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error('release distribution metadata is malformed or not bound to the archive')
    return
  }
  if (status !== 'not-attested') throw new Error('release distribution signature status must be not-attested or verified')
  const stableDownloadUrl = value.stableDownloadUrl
  if (stableDownloadUrl !== undefined && stableDownloadUrl !== null) throw new Error('release distribution metadata requires a verified signature')
  for (const field of ['provider', 'evidenceRef', 'artifactSha256']) if (signature[field] !== undefined && signature[field] !== null) throw new Error('release distribution metadata requires a verified signature')
  nonEmptyString(value.runtimeProvenance ?? 'external-release-gate', 'release distribution runtimeProvenance')
}

function assertRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch { return false }
}

function inputDigest(root, path, sha256) { return { path: relative(root, path), sha256 } }

async function digestIfPresent(root, path) {
  const resolved = resolve(root, path)
  return inputDigest(root, resolved, await sha256File(resolved))
}

async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex') }

function serialFromDigest(digest) { return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}` }
