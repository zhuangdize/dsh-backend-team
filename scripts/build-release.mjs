import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { assertAgentFixture, assertReleaseEvidence, assertRuntimeManifest, releaseError } from './release-gates.mjs'
import { writeReleaseMaterials } from './release-materials.mjs'
const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const channel = value('--channel') ?? 'local-development'
const evidencePath = value('--evidence')
const distributionPath = value('--distribution')
const tarballPath = value('--tarball')
if (!evidencePath) throw releaseError('MISSING_RELEASE_EVIDENCE', 'release requires an explicit evidence file')
const manifest = await readJson(resolve(root, 'runtime-manifests/postgresql-18.6-darwin.json'), 'INCOMPLETE_RUNTIME_PROVENANCE', 'runtime manifest')
assertRuntimeManifest(manifest)
const agentFixture = await readJson(resolve(root, value('--agent-fixture') ?? 'docs/compatibility/0.1.0-rc.6-agent-runtime-fixture.json'), 'INCOMPLETE_AGENT_RUNTIME_PROVENANCE', 'Agent runtime fixture')
assertAgentFixture(agentFixture)
const evidence = await readJson(resolve(root, evidencePath), 'INCOMPLETE_RELEASE_EVIDENCE', 'release evidence')
assertReleaseEvidence(evidence)
const distribution = distributionPath === undefined ? undefined : await readJson(resolve(root, distributionPath), 'INCOMPLETE_RELEASE_DISTRIBUTION', 'release distribution')
const status = await exec('git', ['status', '--porcelain'], { cwd: root }); if (status.stdout.trim() !== '') throw releaseError('DIRTY_REVISION', 'release requires a clean Git revision')
const pack = await exec(process.execPath, [resolve(root, 'scripts/build-workspaces.mjs')], { cwd: root }); void pack
let tarball
let packageFiles
if (tarballPath === undefined) {
  const npmTarget = resolve(dirname(process.execPath), 'npm')
  await mkdir(resolve(root, 'dist'), { recursive: true })
  const packResult = await exec(process.execPath, [npmTarget, 'pack', '--workspace', '@dsh-backend-team/bundle', '--json', '--pack-destination', resolve(root, 'dist')], { cwd: root })
  const packageInfo = JSON.parse(packResult.stdout)[0]
  tarball = resolve(root, 'dist', packageInfo.filename)
  packageFiles = packageInfo.files?.map(file => `package/${file.path ?? file}`) ?? []
} else {
  tarball = resolve(root, tarballPath)
  const previousMaterials = await readJson(`${tarball}.materials.json`, 'INCOMPLETE_RELEASE_MATERIALS', 'existing release materials')
  packageFiles = previousMaterials.bundle?.files
  if (!Array.isArray(packageFiles) || packageFiles.length === 0) throw releaseError('INCOMPLETE_RELEASE_MATERIALS', 'existing release materials do not contain Bundle files')
}
const materials = await writeReleaseMaterials({ root, tarball, channel, packageFiles, runtimeManifestPath: 'runtime-manifests/postgresql-18.6-darwin.json', evidencePath, agentFixturePath: value('--agent-fixture') ?? 'docs/compatibility/0.1.0-rc.6-agent-runtime-fixture.json', distribution })
console.log(JSON.stringify({ channel, tarball, ...materials }))
function value(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
async function readJson(path, code, label) { try { return JSON.parse(await readFile(path, 'utf8')) } catch { throw releaseError(code, `${label} is missing or malformed`) } }
