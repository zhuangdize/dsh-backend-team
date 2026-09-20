import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('a crashed host releases the cross-process run lease and the next host can recover', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 't25-cross-process-'))
  try {
    const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../../../packages/development/src/file-development-checkpoint-store.ts')).href
    const { FileDevelopmentCheckpointStore } = await import(moduleUrl)
    const childCode = `
      const { FileDevelopmentCheckpointStore } = await import(${JSON.stringify(moduleUrl)});
      const store = new FileDevelopmentCheckpointStore(${JSON.stringify(root)}, 'cross-process');
      await store.acquireRun();
      process.stdout.write('acquired\\n');
      await new Promise(() => {});
    `
    const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', childCode], {
      cwd: resolve(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    await new Promise<void>((resolveReady, reject) => {
      child.stdout.on('data', chunk => { if (String(chunk).includes('acquired')) resolveReady() })
      child.once('error', reject)
      child.once('exit', (code, signal) => reject(new Error(`child exited before acquiring: ${code ?? signal}: ${stderr}`)))
    })

    const store = new FileDevelopmentCheckpointStore(root, 'cross-process')
    await assert.rejects(store.acquireRun(), /run lock is busy/u)
    child.kill('SIGKILL')
    await once(child, 'exit')

    const recoveredRelease = await store.acquireRun()
    await recoveredRelease()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
