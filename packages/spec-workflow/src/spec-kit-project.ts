import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { WorkspaceLayout } from '@dsh-backend-team/contracts'

export const SPEC_KIT_COMMANDS_RELATIVE_PATH = '.backend-team/runtime/spec-kit/commands'
const SPECIFY_RELATIVE_PATH = '.specify'

export interface ManagedPathSnapshot { readonly path: string; readonly state: 'missing' | 'directory' | 'file'; readonly dev?: number; readonly ino?: number; readonly mode?: number; readonly size?: number; readonly sha256?: string }
export interface SpecKitProjectStatus {
  readonly initialized: boolean
  readonly integration?: 'generic'
  readonly commandsDirectory?: string
}

/** Workspace-only paths that the official generic integration is allowed to manage. */
export class SpecKitProject {
  readonly specifyDirectory: string
  readonly integrationPath: string
  readonly commandsDirectory: string

  constructor(readonly layout: WorkspaceLayout) {
    this.specifyDirectory = resolve(layout.root, SPECIFY_RELATIVE_PATH)
    this.integrationPath = resolve(this.specifyDirectory, 'integration.json')
    this.commandsDirectory = resolve(layout.root, SPEC_KIT_COMMANDS_RELATIVE_PATH)
  }

  async snapshotBeforeForce(): Promise<readonly ManagedPathSnapshot[]> {
    const snapshot: ManagedPathSnapshot[] = []
    await this.snapshotPath(this.specifyDirectory, SPECIFY_RELATIVE_PATH, snapshot)
    await this.snapshotPath(this.commandsDirectory, SPEC_KIT_COMMANDS_RELATIVE_PATH, snapshot)
    return Object.freeze(snapshot.sort((left, right) => left.path.localeCompare(right.path)))
  }

  async status(): Promise<SpecKitProjectStatus> {
    if (!(await existsDirectory(this.specifyDirectory)) || !(await existsDirectory(this.commandsDirectory))) return Object.freeze({ initialized: false })
    const integration = await readGenericIntegration(this.integrationPath)
    await assertRealDirectoryInside(this.commandsDirectory, this.layout.root, 'generic commands directory')
    return Object.freeze({ initialized: true, integration, commandsDirectory: this.commandsDirectory })
  }

  async requireInitializedGeneric(): Promise<{ readonly integration: 'generic'; readonly commandsDirectory: string }> {
    const current = await this.status()
    if (!current.initialized || current.integration !== 'generic' || current.commandsDirectory === undefined) throw new Error('official generic Spec Kit output is missing')
    return Object.freeze({ integration: current.integration, commandsDirectory: current.commandsDirectory })
  }

  private async snapshotPath(path: string, relativePath: string, snapshot: ManagedPathSnapshot[]): Promise<void> {
    assertInside(this.layout.root, path, 'Spec Kit managed path')
    let details: Awaited<ReturnType<typeof lstat>>
    try { details = await lstat(path) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { try { await lstat(path); throw new Error(`Spec Kit managed path appeared during snapshot: ${relativePath}`) } catch (check: unknown) { if ((check as NodeJS.ErrnoException).code !== 'ENOENT') throw check }; snapshot.push(Object.freeze({ path: relativePath, state: 'missing' })); return }
      throw error
    }
    if (details.isSymbolicLink()) throw new Error(`Spec Kit managed path contains symlink: ${relativePath}`)
    if (details.isDirectory()) {
      const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const opened = await directory.stat()
      try {
        const current = await lstat(path)
        if (current.isSymbolicLink() || !sameIdentity(opened, current)) throw new Error(`Spec Kit managed directory changed: ${relativePath}`)
        snapshot.push(Object.freeze({ path: relativePath, state: 'directory', dev: opened.dev, ino: opened.ino, mode: opened.mode & 0o777, size: opened.size }))
      } finally { await directory.close() }
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink()) throw new Error(`Spec Kit managed path contains symlink: ${relativePath}/${entry.name}`)
        await this.snapshotPath(resolve(path, entry.name), `${relativePath}/${entry.name}`, snapshot)
      }
      const final = await lstat(path)
      if (!sameIdentity(details, final) || final.isSymbolicLink()) throw new Error(`Spec Kit managed directory changed: ${relativePath}`)
      return
    }
    if (!details.isFile() || details.nlink !== 1) throw new Error(`Spec Kit managed path is not a regular file: ${relativePath}`)
    const stable = await sha256File(path)
    snapshot.push(Object.freeze({ path: relativePath, state: 'file', ...stable }))
  }
}

export async function readGenericIntegration(path: string): Promise<'generic'> {
  const content = await readRegularUtf8(path, 'Spec Kit integration', 64 * 1024)
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { throw new Error('Spec Kit integration schema is invalid JSON') }
  if (!record(parsed) || !exactKeys(parsed, ['version', 'integration_state_schema', 'installed_integrations', 'integration_settings', 'integration', 'default_integration']) || parsed.version !== '0.16.5' || parsed.integration_state_schema !== 1 || parsed.integration !== 'generic' || parsed.default_integration !== 'generic' || !Array.isArray(parsed.installed_integrations) || parsed.installed_integrations.length !== 1 || parsed.installed_integrations[0] !== 'generic' || !record(parsed.integration_settings) || !exactKeys(parsed.integration_settings, ['generic']) || !record(parsed.integration_settings.generic) || !exactKeys(parsed.integration_settings.generic, ['script', 'raw_options', 'parsed_options', 'invoke_separator']) || parsed.integration_settings.generic.script !== 'sh' || parsed.integration_settings.generic.raw_options !== '--commands-dir .backend-team/runtime/spec-kit/commands' || !record(parsed.integration_settings.generic.parsed_options) || !exactKeys(parsed.integration_settings.generic.parsed_options, ['commands_dir']) || parsed.integration_settings.generic.parsed_options.commands_dir !== '.backend-team/runtime/spec-kit/commands' || parsed.integration_settings.generic.invoke_separator !== '.') throw new Error('Spec Kit integration schema is not the pinned official generic v0.16.5 schema')
  return 'generic'
}

export async function assertRealDirectoryInside(path: string, root: string, label: string): Promise<string> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is not a regular directory`)
  const canonical = await realpath(path)
  if (canonical !== path || !inside(root, canonical)) throw new Error(`${label} escapes workspace boundary`)
  return canonical
}

export async function readRegularUtf8(path: string, label: string, limit = Number.MAX_SAFE_INTEGER): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(`${label} is not a regular file or exceeds size limit`)
    const bytes = await handle.readFile()
    const final = await handle.stat(); const finalPath = await lstat(path)
    if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino) throw new Error(`${label} changed during read`)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    if (error instanceof TypeError) throw new Error(`${label} is not valid UTF-8`)
    throw error
  } finally { await handle.close() }
}

async function sha256File(path: string): Promise<{ readonly dev: number; readonly ino: number; readonly mode: number; readonly size: number; readonly sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Spec Kit managed file is not a regular file')
    const digest = async () => { const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0; for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (bytesRead === 0) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead } return hash.digest('hex') }
    const first = await digest(); const second = await digest()
    const final = await handle.stat(); const finalPath = await lstat(path)
    if (first !== second || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino) throw new Error('Spec Kit managed file changed during snapshot')
    return { dev: opened.dev, ino: opened.ino, mode: opened.mode & 0o777, size: opened.size, sha256: first }
  } finally { await handle.close() }
}

async function existsDirectory(path: string): Promise<boolean> {
  try { const details = await lstat(path); if (details.isSymbolicLink()) throw new Error('Spec Kit project contains symlink'); return details.isDirectory() } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(); const sortedExpected = [...expected].sort(); return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]) }
function inside(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
function assertInside(root: string, target: string, label: string): void { if (!inside(root, target)) throw new Error(`${label} escapes workspace`) }
function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino }
