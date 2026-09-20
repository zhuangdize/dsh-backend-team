#!/usr/bin/env node
import { delimiter, dirname, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolveDshBinDirectory, resolveDshHome, resolveDshPath, resolveProfileName, resolveWorkspaceNodePath, resolveWorkspaceRoot } from './backend-team-profile-options.mjs'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index]
  if (key?.startsWith('--')) args.set(key.slice(2), process.argv[index + 1] ?? '')
}
const workspace = await canonicalPath(resolveWorkspaceRoot(args.get('workspace')), 'workspace root')
const profile = resolveProfileName(args.get('profile'))
if (profile !== 'web') throw new Error('backend-team-start only supports the web Profile')
const dsh = await resolveDshPath(args.get('dsh'), workspace)
const host = args.get('host')?.trim() || '127.0.0.1'
if (host !== '127.0.0.1') throw new Error('Backend Team Web must listen on 127.0.0.1; use the official DSH command separately for a deliberate network deployment')
const port = parsePort(args.get('port'))
const cwdRelative = relative(workspace, resolve(process.cwd()))
if (cwdRelative === '..' || cwdRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('start must run from the target workspace')

const nodePath = await canonicalPath(process.execPath, 'current Node')
const expectedNodePath = await resolveWorkspaceNodePath(workspace)
if (nodePath !== expectedNodePath) throw new Error(`run this operation with workspace-local Node 24.19.0: ${expectedNodePath}`)

const command = [dsh, '--profile', profile, '--host', host]
if (port !== undefined) command.push('--port', String(port))
const environment = {
  ...process.env,
  PATH: [resolveDshBinDirectory(workspace), dirname(expectedNodePath), '/usr/bin', '/bin'].join(delimiter),
  DSH_HOME: resolveDshHome(workspace, args.get('dsh-home')),
}
const child = spawn(command[0], command.slice(1), { cwd: workspace, env: environment, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.once('error', (error) => { process.stderr.write(`${error.message}\n`); process.exit(1) })
child.once('close', (code) => process.exit(code ?? 1))

function parsePort(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  if (!/^\d+$/u.test(value.trim())) throw new Error('port must be an integer from 0 to 65535')
  const port = Number(value.trim())
  if (!Number.isSafeInteger(port) || port > 65535) throw new Error('port must be an integer from 0 to 65535')
  return port
}

async function canonicalPath(path, label) {
  try { return await realpath(path) } catch { throw new Error(`${label} was not found: ${path}`) }
}
