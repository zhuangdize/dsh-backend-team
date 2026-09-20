#!/usr/bin/env node
import { delimiter, dirname, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolveDshBinDirectory, resolveDshHome, resolveDshPath, resolveProfileName, resolveProfileStoreDirectory, resolveWorkspaceNodePath, resolveWorkspaceRoot } from './backend-team-profile-options.mjs'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index]
  if (key?.startsWith('--')) args.set(key.slice(2), process.argv[index + 1] ?? '')
}
const workspace = await canonicalPath(resolveWorkspaceRoot(args.get('workspace')), 'workspace root')
const profile = resolveProfileName(args.get('profile'))
if (args.get('confirm') !== 'preserve-data') throw new Error('uninstall requires --confirm preserve-data; project data is never deleted by default')
const dsh = await resolveDshPath(args.get('dsh'), workspace)
const storeDirectory = await resolveProfileStoreDirectory(workspace, args.get('dsh-home'), profile)
const cwdRelative = relative(workspace, resolve(process.cwd()))
if (cwdRelative === '..' || cwdRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('uninstall must run from the target workspace')

const nodePath = await canonicalPath(process.execPath, 'current Node')
const expectedNodePath = await resolveWorkspaceNodePath(workspace)
if (nodePath !== expectedNodePath) throw new Error(`run this operation with workspace-local Node 24.19.0: ${expectedNodePath}`)

const environment = {
  ...process.env,
  PATH: [resolveDshBinDirectory(workspace), dirname(expectedNodePath), '/usr/bin', '/bin'].join(delimiter),
  DSH_HOME: resolveDshHome(workspace, args.get('dsh-home')),
}
const child = spawn(dsh, ['plugin', '--profile', profile, 'remove', '@dsh-backend-team/bundle', '--store-dir', storeDirectory], { cwd: workspace, env: environment, stdio: 'inherit' })
child.once('error', (error) => { process.stderr.write(`${error.message}\n`); process.exit(1) })
child.once('close', (code) => process.exit(code ?? 1))

async function canonicalPath(path, label) {
  try { return await realpath(path) } catch { throw new Error(`${label} was not found: ${path}`) }
}
