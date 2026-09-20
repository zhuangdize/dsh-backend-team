import { access } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)

describe('DbGate package assets', () => {
  it('ships the loopback preload alongside the compiled database package', async () => {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
    await expect(access(join(packageRoot, 'dist/dbgate-loopback-preload.cjs'), constants.R_OK)).resolves.toBeUndefined()
  })

  it('rewrites an explicitly non-loopback TCP host before DbGate code can listen', async () => {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
    const preload = join(packageRoot, 'dist/dbgate-loopback-preload.cjs')
    const probe = "const net = require('node:net'); const server = net.createServer(); server.listen({ port: 0, host: '0.0.0.0' }, () => { process.stdout.write(String(server.address().address)); server.close(); });"
    const result = await execFile(process.execPath, ['--require', preload, '-e', probe], { cwd: packageRoot })
    expect(result.stdout).toBe('127.0.0.1')
  })
})
