import { isIP } from 'node:net'
import { basename, resolve } from 'node:path'
import type { PolicyAction, PolicyContext, PolicyDecision } from '@dsh-backend-team/contracts'

type Rule = (action: PolicyAction, context: PolicyContext) => Promise<PolicyDecision | null>

const deny = (ruleId: string, reason: string): PolicyDecision => ({ effect: 'deny', ruleId, reason })
const ask = (ruleId: string, reason: string, approvalKind: NonNullable<PolicyDecision['approvalKind']>): PolicyDecision => ({ effect: 'ask', ruleId, reason, approvalKind })
const allow = (ruleId: string, reason: string): PolicyDecision => ({ effect: 'allow', ruleId, reason })
const PRIVILEGE_WRAPPERS = new Set(['sudo', 'su', 'doas', 'pkexec'])
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'])
const SYSTEM_INSTALLERS = new Set(['brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman'])
const NODE_INSTALLERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

const RULES: readonly Rule[] = [denyProductionDatabase, denyNonLoopbackService, denyWorkspaceEscape, denySystemOrGlobalInstall, denyDestructiveGit, denyUnownedDelete, requireInstallApproval, requireMigrationApproval, requireSharedConfigApproval, allowKnownRead, allowApprovedOwnedWrite]

export async function evaluateRules(action: PolicyAction, context: PolicyContext): Promise<PolicyDecision> {
  for (const rule of RULES) {
    const decision = await rule(action, context)
    if (decision !== null) return decision
  }
  return action.kind === 'command'
    ? deny('deny-unknown', 'commands require verified executable, cwd, environment, and provenance')
    : deny('deny-unknown', 'the action is not known to be safe in this workspace')
}

async function denyProductionDatabase(action: PolicyAction): Promise<PolicyDecision | null> {
  if (action.kind === 'database') {
    const host = databaseHost(action.connectionString)
    return host === null || !isLoopbackHost(host) ? deny('deny-production-database', 'database targets must be loopback-only') : null
  }
  if (action.kind === 'command' && commandValues(action).some(hasUnsafeDatabaseTarget)) {
    return deny('deny-production-database', 'database targets must be loopback-only')
  }
  return null
}

async function denyNonLoopbackService(action: PolicyAction): Promise<PolicyDecision | null> {
  if (action.kind !== 'command') return null
  return serviceHosts(action).some((host) => !isLoopbackHost(host)) ? deny('deny-non-loopback-service', 'services may bind only to loopback addresses') : null
}

async function denyWorkspaceEscape(action: PolicyAction, context: PolicyContext): Promise<PolicyDecision | null> {
  // DefaultPolicyEngine performs this first with real filesystem canonicalization.
  void action
  void context
  return null
}

async function denySystemOrGlobalInstall(action: PolicyAction, context: PolicyContext): Promise<PolicyDecision | null> {
  if (action.kind === 'install' && action.packages.some(isGlobalInstallFlag)) return deny('deny-system-or-global-install', 'global installation is forbidden')
  if (action.kind !== 'command') return null
  const executable = commandName(action)
  if (PRIVILEGE_WRAPPERS.has(executable) || SHELL_WRAPPERS.has(executable) || ['env', 'command', 'xargs', 'nohup'].includes(executable)) return deny('deny-system-or-global-install', 'opaque execution wrappers are forbidden')
  if (SYSTEM_INSTALLERS.has(executable)) return deny('deny-system-or-global-install', 'system package manager invocation is forbidden')
  if (hasForbiddenGlobalInstall(action, context) || (executable === 'yarn' && action.args[0] === 'global')) return deny('deny-system-or-global-install', 'global installation is forbidden')
  return null
}

async function denyDestructiveGit(action: PolicyAction): Promise<PolicyDecision | null> {
  if (action.kind !== 'command') return null
  if (commandName(action) === 'rm' && action.args.some(isRecursiveDeleteFlag)) return deny('deny-destructive-git', 'recursive deletion is forbidden')
  if (commandName(action) === 'git' && isDestructiveGit(action.args)) return deny('deny-destructive-git', 'destructive Git commands are forbidden')
  return null
}

async function denyUnownedDelete(action: PolicyAction): Promise<PolicyDecision | null> {
  if (action.kind === 'delete') return deny('deny-unowned-delete', 'deletion is not permitted by this policy stage')
  if (action.kind === 'command' && isGenericDeleteCommand(action)) return deny('deny-unowned-delete', 'deletion is not permitted by this policy stage')
  return null
}

async function requireInstallApproval(action: PolicyAction): Promise<PolicyDecision | null> {
  return action.kind === 'install' || isInstallCommand(action) || isInstallPath(action) ? ask('require-install-approval', 'installing dependencies requires approval', 'install') : null
}

async function requireMigrationApproval(action: PolicyAction): Promise<PolicyDecision | null> {
  return action.kind === 'migration' || isMigrationPath(action) || isMigrationCommand(action) ? ask('require-migration-approval', 'migrations require approval', 'migration') : null
}

async function requireSharedConfigApproval(action: PolicyAction): Promise<PolicyDecision | null> {
  return action.kind === 'shared-config' || isSharedConfigPath(action) || isSharedConfigCommand(action) ? ask('require-shared-config-approval', 'shared configuration requires approval', 'shared-config') : null
}

async function allowKnownRead(action: PolicyAction): Promise<PolicyDecision | null> {
  return action.kind === 'read' ? allow('allow-known-read', 'canonical in-workspace reads are allowed') : null
}

async function allowApprovedOwnedWrite(action: PolicyAction, context: PolicyContext): Promise<PolicyDecision | null> {
  // Trusted ownership and descriptor acquisition are outer guard stages in
  // DefaultPolicyEngine; this ordered rule intentionally remains diagnostic.
  void action
  void context
  return null
}

function pathTarget(action: PolicyAction): string | null {
  switch (action.kind) {
    case 'write': case 'delete': case 'migration': case 'shared-config': return action.targetPath
    default: return null
  }
}

function databaseHost(connectionString: string): string | null {
  try { return new URL(connectionString).hostname } catch { return null }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, '')
  return normalized === 'localhost' || normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'))
}

function serviceHosts(action: Extract<PolicyAction, { kind: 'command' }>): string[] {
  const hosts: string[] = []
  const values = action.args
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!
    if (['--host', '--hostname', '--bind', '--listen', '--address', '--interface', '-h', '-H', '-b'].includes(argument)) hosts.push(values[index + 1] ?? '')
    const match = /^(?:--host|--hostname|--bind|--listen|--address|--interface|-h|-H|-b)=(.*)$/u.exec(argument)
    if (match?.[1] !== undefined) hosts.push(match[1])
  }
  for (const [key, value] of Object.entries(action.env)) {
    if (/(?:^|_)(?:HOST|HOSTNAME|BIND|LISTEN|ADDRESS|INTERFACE)(?:_|$)/iu.test(key)) hosts.push(value)
  }
  return hosts
}

function isGlobalInstallFlag(argument: string): boolean {
  return argument === '-g' || argument === '--global' || argument === '--global=true' || argument === '--system' || argument === '--location=global' || argument.startsWith('global=') || argument.startsWith('prefix=')
}

function hasForbiddenGlobalInstall(action: Extract<PolicyAction, { kind: 'command' }>, context: PolicyContext): boolean {
  if (action.args.some(isGlobalInstallFlag)) return true
  const env = action.env
  if (Object.entries(env).some(([key, value]) => /^(?:NPM_CONFIG_GLOBAL|NPM_CONFIG_PREFIX)$/iu.test(key) && (key.toUpperCase().endsWith('GLOBAL') ? !/^false$/iu.test(value) : isOutsideOrSystemPrefix(value, action.cwd, context.workspace.root)))) return true
  if (commandName(action) === 'npm' && action.args[0] === 'config' && action.args[1] === 'set' && action.args[2] === 'prefix') return true
  for (let index = 0; index < action.args.length; index += 1) {
    const argument = action.args[index]!
    if (argument === '--prefix') { if (isOutsideOrSystemPrefix(action.args[index + 1] ?? '', action.cwd, context.workspace.root)) return true }
    if (argument.startsWith('--prefix=' ) && isOutsideOrSystemPrefix(argument.slice('--prefix='.length), action.cwd, context.workspace.root)) return true
    if (argument === '--location' && action.args[index + 1] === 'global') return true
  }
  return false
}

function isOutsideOrSystemPrefix(value: string, cwd: string, workspaceRoot: string): boolean {
  if (value === '' || value === 'global') return true
  const target = resolve(cwd, value)
  return !target.startsWith(`${workspaceRoot}/`) && target !== workspaceRoot
}

function isRecursiveDeleteFlag(argument: string): boolean {
  return argument === '--recursive' || /^-[^-]*[rR]/u.test(argument)
}

function isDestructiveGit(args: readonly string[]): boolean {
  const { subcommand, rest } = gitSubcommand(args)
  if (subcommand === 'reset') return rest.includes('--hard')
  if (subcommand === 'clean') return rest.some((argument) => /^-[^-]*f/u.test(argument) || argument === '--force')
  if (subcommand === 'checkout') return rest.includes('.') || rest.includes('--') || rest.includes('-f') || rest.includes('--force')
  if (subcommand === 'restore') return rest.some((argument) => !argument.startsWith('-'))
  if (subcommand === 'push') return rest.includes('--force') || rest.includes('-f') || rest.some((argument) => argument.startsWith('+') || argument.startsWith('--force=' ) || argument.startsWith('--force-'))
  if (subcommand === 'branch') return rest.includes('-D') || rest.includes('-d') || rest.includes('--delete')
  if (subcommand === 'worktree') return rest[0] === 'remove' && (rest.includes('--force') || rest.includes('-f'))
  if (subcommand === 'tag') return rest.includes('-d') || rest.includes('--delete')
  return subcommand === 'stash' && ['clear', 'drop'].includes(rest[0] ?? '')
}

function gitSubcommand(args: readonly string[]): { subcommand: string | undefined; rest: readonly string[] } {
  let index = 0
  while (index < args.length) {
    const argument = args[index]!
    if (argument === '-C' || argument === '-c' || argument === '--git-dir' || argument === '--work-tree') { index += 2; continue }
    if (argument.startsWith('-')) { index += 1; continue }
    return { subcommand: argument, rest: args.slice(index + 1) }
  }
  return { subcommand: undefined, rest: [] }
}

function isInstallCommand(action: PolicyAction): boolean {
  if (action.kind !== 'command' || !NODE_INSTALLERS.has(commandName(action))) return false
  return action.args.some((argument) => ['install', 'add', 'i'].includes(argument))
}

function isMigrationPath(action: PolicyAction): boolean {
  if (action.kind === 'read') return false
  const target = pathTarget(action)
  return target !== null && /(?:^|\/)migrations?(?:\/|$)|(?:^|\/)drizzle(?:\/|$)|\.sql$/u.test(target)
}

function isMigrationCommand(action: PolicyAction): boolean {
  return action.kind === 'command' && action.args.some((argument) => /migrat|drizzle/u.test(argument))
}

function isInstallPath(action: PolicyAction): boolean {
  if (action.kind === 'read') return false
  const target = pathTarget(action)
  return target !== null && /(?:^|\/)node_modules(?:\/|$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/u.test(target)
}

function isSharedConfigPath(action: PolicyAction): boolean {
  if (action.kind === 'read') return false
  const target = pathTarget(action)
  return target !== null && /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|(?:eslint|vite|vitest)\.config\.[^/]+)$/u.test(target)
}

function isSharedConfigCommand(action: PolicyAction): boolean {
  return action.kind === 'command' && action.args.some((argument) => /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|(?:eslint|vite|vitest)\.config\.[^/]+)$/u.test(argument))
}

function commandName(action: Extract<PolicyAction, { kind: 'command' }>): string { return basename(action.executable) }

function commandValues(action: Extract<PolicyAction, { kind: 'command' }>): readonly string[] {
  return [...action.args, ...Object.values(action.env)]
}

function hasUnsafeDatabaseTarget(value: string): boolean {
  return [...value.matchAll(/(?:jdbc:)?postgres(?:ql)?:\/\/[^\s'"=]+/giu)].some((match) => {
    const raw = match[0]
    const url = raw.startsWith('jdbc:') ? raw.slice('jdbc:'.length) : raw
    const host = databaseHost(url)
    return host === null || !isLoopbackHost(host)
  })
}

function isGenericDeleteCommand(action: Extract<PolicyAction, { kind: 'command' }>): boolean {
  const executable = commandName(action)
  return executable === 'rm' || executable === 'unlink' || executable === 'rmdir' || (executable === 'find' && action.args.some((argument) => argument === '-delete' || argument === '-exec' || argument === '-execdir'))
}
