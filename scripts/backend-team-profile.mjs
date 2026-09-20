#!/usr/bin/env node
import { delimiter, dirname, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { stageProfileBundle } from './profile-bundle-cache.mjs'
import { resolveDshBinDirectory, resolveDshHome, resolveDshPath, resolveProfileName, resolveProfileStoreDirectory, resolveWorkspaceNodePath, resolveWorkspaceRoot } from './backend-team-profile-options.mjs'

const args = new Map(); for (let index = 2; index < process.argv.length; index += 1) { const key = process.argv[index]; if (key?.startsWith('--')) args.set(key.slice(2), process.argv[index + 1] ?? '') }
const action = process.argv[2]
if (!['inspect', 'install', 'verify', 'upgrade', 'rollback', 'uninstall'].includes(action ?? '')) throw new Error('usage: backend-team-profile.mjs <inspect|install|verify|upgrade|rollback|uninstall> [--dsh PATH] [--profile NAME] [--workspace PATH] [--dsh-home PATH] [--bundle PATH]')
const profile = resolveProfileName(args.get('profile')); const target = await canonicalPath(resolveWorkspaceRoot(args.get('workspace')), 'workspace root'); const dsh = await resolveDshPath(args.get('dsh'), target)
const cwdRelative = relative(target, resolve(process.cwd())); if (cwdRelative === '..' || cwdRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('profile operation must run from the target workspace')
const bundleArgument = args.get('bundle')
const bundle = bundleArgument ? await stageProfileBundle(await canonicalPath(resolve(bundleArgument), 'Bundle archive'), target) : undefined
if ((action === 'install' || action === 'upgrade') && (bundle === undefined || bundle.length === 0)) throw new Error(`${action} requires --bundle PATH; use the packed Bundle .tgz file`)
const usesPnpm = ['install', 'upgrade', 'rollback', 'uninstall'].includes(action)
const storeDirectory = usesPnpm ? await resolveProfileStoreDirectory(target, args.get('dsh-home'), profile) : undefined
const command = action === 'inspect' || action === 'verify' ? [dsh, '--profile', profile, '--dump-config'] : action === 'install' ? [dsh, 'plugin', '--profile', profile, 'add', bundle, '--ignore-scripts', '--store-dir', storeDirectory] : action === 'upgrade' ? [dsh, 'plugin', '--profile', profile, 'add', bundle, '--ignore-scripts', '--store-dir', storeDirectory] : action === 'rollback' ? [dsh, 'plugin', '--profile', profile, 'remove', '@dsh-backend-team/bundle', '--store-dir', storeDirectory] : [dsh, 'plugin', '--profile', profile, 'remove', '@dsh-backend-team/bundle', '--store-dir', storeDirectory]
if (action === 'uninstall' && args.get('confirm') !== 'preserve-data') throw new Error('uninstall requires --confirm preserve-data; project data is never deleted by default')
const nodePath = await canonicalPath(process.execPath, 'current Node')
const expectedNodePath = await resolveWorkspaceNodePath(target)
if (nodePath !== expectedNodePath) throw new Error(`run this operation with workspace-local Node 24.19.0: ${expectedNodePath}`)
const environment = { ...process.env, PATH: [resolveDshBinDirectory(target), dirname(expectedNodePath), '/usr/bin', '/bin'].join(delimiter), DSH_HOME: resolveDshHome(target, args.get('dsh-home')) }
const result = await run(command[0], command.slice(1), target, environment); if (result.code !== 0) throw new Error(`${action} failed: ${result.stdout}${result.stderr}`); process.stdout.write(result.stdout)
async function canonicalPath(path, label) { try { return await realpath(path) } catch { throw new Error(`${label} was not found: ${path}`) } }
function run(file, commandArgs, cwd, env) { return new Promise((resolveRun, rejectRun) => { const child = spawn(file, commandArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => { stdout += data }); child.stderr.on('data', (data) => { stderr += data }); child.once('error', rejectRun); child.once('close', (code) => resolveRun({ code, stdout, stderr })) }) }
