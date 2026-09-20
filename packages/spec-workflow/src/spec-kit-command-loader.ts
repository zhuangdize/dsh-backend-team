import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { assertRealDirectoryInside } from './spec-kit-project.js'

const MAX_COMMAND_BYTES = 1024 * 1024
const COMMAND_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u

export interface LoadedSpecKitCommand {
  readonly id: string
  readonly prompt: string
  readonly sourceRealPath: string
  readonly sourceSha256: string
}
export interface SpecKitCommandLoaderOptions { readonly commandsDirectory: string }

/** Reads official generated prompt assets as data.  It never interprets their Markdown or embedded code. */
export class SpecKitCommandLoader {
  constructor(private readonly options: SpecKitCommandLoaderOptions) {}

  async load(command: string, args: string): Promise<LoadedSpecKitCommand> {
    const id = normalizeId(command)
    const commandsDirectory = await assertRealDirectoryInside(this.options.commandsDirectory, workspaceRootFor(this.options.commandsDirectory), 'generic commands directory')
    const requested = resolve(commandsDirectory, `${id}.md`)
    const sourceRealPath = await realpathExisting(requested, commandsDirectory, id)
    const source = await readOfficialCommand(sourceRealPath)
    return Object.freeze({ id, prompt: source.text.replace(/(?<![A-Za-z0-9_])\$ARGUMENTS(?![A-Za-z0-9_])/gu, () => args), sourceRealPath, sourceSha256: createHash('sha256').update(source.bytes).digest('hex') })
  }
}

function normalizeId(value: string): string {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || !COMMAND_ID.test(value)) throw new Error('command must be a normalized command id')
  return value
}
function workspaceRootFor(commandsDirectory: string): string {
  const marker = `${sep}.backend-team${sep}runtime${sep}spec-kit${sep}commands`
  if (!commandsDirectory.endsWith(marker)) throw new Error('generic commands directory is outside the Team runtime')
  return commandsDirectory.slice(0, -marker.length)
}
async function realpathExisting(path: string, commandsDirectory: string, id: string): Promise<string> {
  try {
    const details = await lstat(path)
    if (details.isSymbolicLink()) throw new Error('official command symlink is unsafe')
    if (!details.isFile() || details.nlink !== 1) throw new Error('official command is unsafe')
    const canonical = await realpath(path)
    const rel = relative(commandsDirectory, canonical)
    if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '' || rel.includes(sep)) throw new Error('official command escapes the commands directory')
    return canonical
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`unknown Spec Kit command: ${id}`)
    throw error
  }
}
async function readOfficialCommand(path: string): Promise<{ readonly bytes: Buffer; readonly text: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat(); const current = await lstat(path)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_COMMAND_BYTES || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(`official command is unsafe or exceeds 1 MiB`)
    const bytes = await handle.readFile()
    const final = await handle.stat(); const currentFinal = await lstat(path)
    if (bytes.byteLength > MAX_COMMAND_BYTES || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || currentFinal.dev !== opened.dev || currentFinal.ino !== opened.ino) throw new Error('official command changed during read')
    try { return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } } catch { throw new Error('official command is not valid UTF-8') }
  } finally { await handle.close() }
}
