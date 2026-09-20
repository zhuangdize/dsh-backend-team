#!/usr/bin/env node
import { readFile, writeFile, realpath, mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import YAML from 'yaml'
import { resolveDshHome, resolveProfileName, resolveWorkspaceRoot } from './backend-team-profile-options.mjs'

const action = process.argv[2]
if (!['enable', 'disable', 'status'].includes(action)) throw new Error('usage: configure-codex-model.mjs <enable|disable|status> [--command /absolute/codex] [--workspace PATH] [--profile web] [--dsh-home PATH]')
const args = new Map()
for (let i = 3; i < process.argv.length; i += 2) { if (!process.argv[i]?.startsWith('--') || !process.argv[i + 1]) throw new Error('expected --option value'); args.set(process.argv[i].slice(2), process.argv[i + 1]) }
const root = await realpath(resolveWorkspaceRoot(args.get('workspace')))
const patchPath = join(resolveDshHome(root, args.get('dsh-home')), 'profiles', resolveProfileName(args.get('profile')), 'cordis.patch.yml')
const source = await readFile(patchPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]\n'; throw error })
const document = YAML.parseDocument(source)
if (document.errors.length) throw new Error('Profile patch contains invalid YAML')
const entries = document.toJSON()
if (!Array.isArray(entries)) throw new Error('Profile patch must be a YAML array')
const matches = entries.filter(entry => entry?.id === 'backend-team')
if (matches.length > 1) throw new Error('Profile has multiple backend-team overrides; merge them before configuring Codex')
const entry = matches[0] ?? { id: 'backend-team', config: {} }
if (action !== 'status') {
  if (entry.config !== undefined && (typeof entry.config !== 'object' || entry.config === null || Array.isArray(entry.config))) throw new Error('backend-team config must be an object')
  entry.config ??= {}
  if (action === 'enable') {
    const requested = args.get('command') ?? entry.config.codexAppServer?.command
    if (typeof requested !== 'string' || !isAbsolute(requested)) throw new Error('enable requires --command with an absolute Codex executable path')
    const command = await realpath(requested)
    await access(command, constants.X_OK)
    entry.config.codexAppServer = { enabled: true, command, cwd: root, timeoutMs: 120000 }
  } else entry.config.codexAppServer = { enabled: false }
  if (matches.length === 0) entries.push(entry)
  await mkdir(dirname(patchPath), { recursive: true })
  await writeFile(patchPath, YAML.stringify(entries), { mode: 0o600 })
}
console.log(JSON.stringify({ profile: resolveProfileName(args.get('profile')), enabled: entry.config?.codexAppServer?.enabled === true, command: entry.config?.codexAppServer?.command ?? null, restartRequired: action !== 'status' }))
