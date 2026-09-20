import { createHash } from 'node:crypto'

export interface LifecycleScript { packageName: string; packageVersion?: string; scriptName: string; command: string; source?: string; hash?: string }
export interface LifecycleReview { installArgs: string[]; scripts: LifecycleScript[]; requiresApproval: boolean; approvedRebuildArgs: string[] }
export type LifecycleApproval = Pick<LifecycleScript, 'packageName' | 'packageVersion' | 'scriptName' | 'command' | 'source' | 'hash'>

export class LifecyclePolicy {
  review(input: Record<string, string> | LifecycleScript[]): LifecycleReview {
    const scripts: LifecycleScript[] = Array.isArray(input) ? input.map((script): LifecycleScript => ({ ...script })) : Object.entries(input).map(([key, command]): LifecycleScript => {
      const [packageName, scriptName = 'install'] = key.split('#')
      return { packageName: packageName ?? '', scriptName, command }
    })
    const normalized = scripts.map((script) => ({ ...script, source: script.source ?? `package-lock:${script.packageName}`, hash: script.hash ?? createHash('sha256').update(script.command).digest('hex') }))
    const unique = [...new Map(normalized.map((script) => [`${script.packageName}:${script.packageVersion ?? ''}:${script.scriptName}:${script.command}:${script.source}:${script.hash}`, script])).values()]
    return { installArgs: ['install', '--ignore-scripts'], scripts: unique, requiresApproval: unique.length > 0, approvedRebuildArgs: [] }
  }

  rebuildCommand(scripts: LifecycleScript[], approvals: readonly LifecycleApproval[]): string[] {
    const requested = [...scripts].sort(compareScript)
    const approved = [...approvals].sort(compareScript)
    if (requested.length !== approved.length || requested.some((script, index) => !sameScript(script, approved[index]!))) throw new Error('lifecycle approval must enumerate the exact package, version, source, script, and hash')
    return ['rebuild', ...[...new Set(requested.map((script) => script.packageName))].sort()]
  }

  extractFromPackageLock(lockfile: unknown): LifecycleScript[] {
    if (!lockfile || typeof lockfile !== 'object') return []
    const packages = (lockfile as { packages?: unknown }).packages
    if (!packages || typeof packages !== 'object') return []
    const scripts: LifecycleScript[] = []
    for (const [path, raw] of Object.entries(packages as Record<string, unknown>)) {
      if (!path.startsWith('node_modules/') || !raw || typeof raw !== 'object') continue
      const value = raw as { name?: unknown; version?: unknown; scripts?: unknown; hasInstallScript?: unknown }
      const name = typeof value.name === 'string' ? value.name : path.slice('node_modules/'.length)
      const scriptMap = value.scripts && typeof value.scripts === 'object' ? value.scripts as Record<string, unknown> : {}
      for (const scriptName of ['preinstall', 'install', 'postinstall', 'prepare']) {
        const command = typeof scriptMap[scriptName] === 'string' ? scriptMap[scriptName] : undefined
        if (command !== undefined) scripts.push({ packageName: name, ...(typeof value.version === 'string' ? { packageVersion: value.version } : {}), scriptName, command, source: path })
      }
      if (value.hasInstallScript === true && !scripts.some((script) => script.packageName === name)) scripts.push({ packageName: name, ...(typeof value.version === 'string' ? { packageVersion: value.version } : {}), scriptName: 'install', command: '<declared by package>', source: path })
    }
    return scripts
  }
}

function compareScript(left: LifecycleScript, right: LifecycleScript): number { return `${left.packageName}:${left.packageVersion ?? ''}:${left.scriptName}:${left.source ?? ''}:${left.hash ?? ''}`.localeCompare(`${right.packageName}:${right.packageVersion ?? ''}:${right.scriptName}:${right.source ?? ''}:${right.hash ?? ''}`) }
function sameScript(left: LifecycleScript, right: LifecycleScript): boolean { return left.packageName === right.packageName && left.packageVersion === right.packageVersion && left.scriptName === right.scriptName && left.command === right.command && left.source === right.source && left.hash === right.hash }
