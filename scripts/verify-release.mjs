import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, basename } from 'node:path'
import { assertAgentFixture, assertReleaseEvidence, assertRuntimeManifest, releaseError } from './release-gates.mjs'
import { verifyReleaseMaterials } from './release-materials.mjs'
const root = resolve(import.meta.dirname, '..')
const channel = value('--channel') ?? 'local-development'
const tarballValue = value('--tarball')
if (!tarballValue) throw releaseError('TARBALL_REQUIRED', 'verification requires an explicit tarball path')
const tarball = resolve(tarballValue)
const manifestPath = resolve(value('--manifest') ?? resolve(root, 'runtime-manifests/postgresql-18.6-darwin.json'))
const agentFixturePath = resolve(value('--agent-fixture') ?? resolve(root, 'docs/compatibility/0.1.0-rc.6-agent-runtime-fixture.json'))
const evidenceValue = value('--evidence')
if (!evidenceValue) throw releaseError('MISSING_RELEASE_EVIDENCE', 'verification requires an explicit evidence file')
const evidencePath = resolve(evidenceValue)
const manifest = await readJson(manifestPath, 'INCOMPLETE_RUNTIME_PROVENANCE', 'runtime manifest')
assertRuntimeManifest(manifest)
const agentFixture = await readJson(agentFixturePath, 'INCOMPLETE_AGENT_RUNTIME_PROVENANCE', 'Agent runtime fixture')
assertAgentFixture(agentFixture)
const evidence = await readJson(evidencePath, 'INCOMPLETE_RELEASE_EVIDENCE', 'release evidence')
assertReleaseEvidence(evidence)
const tarballStat = await stat(tarball).catch(() => undefined)
if (!tarballStat?.isFile()) throw releaseError('TARBALL_REQUIRED', 'tarball path must point to an actual file')
const content = await readFile(tarball)
const digest = createHash('sha256').update(content).digest('hex')
const expected = await readFile(`${tarball}.sha256`, 'utf8').catch(() => undefined)
if (expected === undefined) throw releaseError('MISSING_TARBALL_CHECKSUM', 'tarball checksum file is required')
const checksum = expected.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/u)
if (!checksum || checksum[1] !== digest || basename(checksum[2]) !== basename(tarball)) throw releaseError('TARBALL_HASH_MISMATCH', 'tarball checksum does not match')
try {
  const materials = await verifyReleaseMaterials({ root, tarball, channel })
  console.log(JSON.stringify({ verified: true, tarball, sha256: digest, ...materials }))
} catch (error) {
  throw releaseError('INCOMPLETE_RELEASE_MATERIALS', error instanceof Error ? error.message : String(error))
}
function value(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
async function readJson(path, code, label) { try { return JSON.parse(await readFile(path, 'utf8')) } catch { throw releaseError(code, `${label} is missing or malformed`) } }
