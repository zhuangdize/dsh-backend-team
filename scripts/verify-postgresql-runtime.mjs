import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const manifestArg = process.argv.indexOf('--manifest')
const manifestPath = resolve(manifestArg >= 0 ? process.argv[manifestArg + 1] : 'runtime-manifests/postgresql-18.6-darwin.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.status !== 'verified') throw new Error('PostgreSQL runtime manifest is not verified; native builds are required')
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw new Error('runtime manifest has no artifacts')
const required = ['postgres', 'initdb', 'pg_ctl', 'pg_isready', 'psql', 'createdb', 'dropdb', 'pg_dump', 'pg_restore']
for (const artifact of manifest.artifacts) {
  if (!artifact.root) throw new Error('artifact root is missing')
  for (const binary of required) await access(join(artifact.root, 'bin', binary), constants.X_OK)
  for (const binary of required) {
    const version = await run(join(artifact.root, 'bin', binary), ['--version'])
    if (version.code !== 0 || !version.stdout.includes('18.6')) throw new Error(`${binary} is not PostgreSQL 18.6`)
  }
}
console.log(`verified ${manifest.artifacts.length} PostgreSQL 18.6 artifact(s)`)
function run(file, args) { return new Promise((resolveRun, rejectRun) => { const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => { stdout += data }); child.stderr.on('data', (data) => { stderr += data }); child.once('error', rejectRun); child.once('close', (code) => resolveRun({ code, stdout, stderr })) }) }
