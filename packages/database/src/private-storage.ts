import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid()) || await realpath(path) !== resolve(path)) throw new Error('private storage directory is unsafe')
}

export async function readPrivateFile(path: string): Promise<Buffer | undefined> {
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error('private storage file is unsafe')
    return await handle.readFile()
  } finally { await handle.close() }
}
