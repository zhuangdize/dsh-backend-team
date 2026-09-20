import { constants } from 'node:fs'
import { open, mkdir, rm } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import { join, resolve } from 'node:path'

export interface PortLease { readonly port: number; readonly lockPath: string; release(): Promise<void> }
export interface PortProbe { isAvailable(port: number): Promise<boolean> }

/** Reserves a high loopback port with a workspace-local exclusive lock. */
export class PortAllocator {
  constructor(private readonly workspaceRoot: string, private readonly probe: PortProbe = { isAvailable: async () => true }) {}
  async allocate(): Promise<PortLease> {
    const lockDirectory = resolve(this.workspaceRoot, '.backend-team/locks')
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const port = randomInt(49152, 65535)
      if (!(await this.probe.isAvailable(port))) continue
      const lockPath = join(lockDirectory, `postgres-${port}.lock`)
      try {
        const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
        await handle.writeFile(`${JSON.stringify({ port, pid: process.pid })}\n`); await handle.sync(); await handle.close()
        let released = false
        return { port, lockPath, release: async () => { if (released) return; released = true; await rm(lockPath, { force: true }) } }
      } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    throw new Error('could not allocate an available local PostgreSQL port')
  }
}
