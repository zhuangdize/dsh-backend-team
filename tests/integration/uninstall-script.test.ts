import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const workspaces: string[] = []

afterEach(async () => {
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true })
  workspaces.length = 0
})

describe('backend-team-uninstall script', () => {
  it('uses the web Profile and workspace-local runtime by default', async () => {
    const workspace = await createWorkspace()
    const dshDirectory = join(workspace, '.backend-team/runtime/dsh/0.1.0-rc.6/node_modules/.bin')
    const nodeDirectory = join(workspace, '.backend-team/runtime/nvm/versions/node/v24.19.0/bin')
    await mkdir(dshDirectory, { recursive: true })
    await mkdir(nodeDirectory, { recursive: true })

    const argumentsFile = join(workspace, 'arguments.txt')
    const environmentFile = join(workspace, 'environment.txt')
    const dshPath = join(dshDirectory, 'dsh')
    await writeFile(dshPath, `#!/bin/sh
printf '%s\\n' "$@" > "${argumentsFile}"
printf '%s\\n%s' "$DSH_HOME" "$PATH" > "${environmentFile}"
`, { mode: 0o755 })
    await chmod(dshPath, 0o755)
    await link(process.execPath, join(nodeDirectory, 'node'))

    const result = await runScript(workspace)

    expect(result.code, result.stderr).toBe(0)
    const canonicalWorkspace = await realpath(workspace)
    expect(await readFile(argumentsFile, 'utf8')).toBe(`plugin\n--profile\nweb\nremove\n@dsh-backend-team/bundle\n--store-dir\n${join(canonicalWorkspace, '.backend-team/runtime/dsh-store')}\n`)
    const [dshHome, path] = (await readFile(environmentFile, 'utf8')).split('\n')
    expect(dshHome).toBe(join(canonicalWorkspace, '.backend-team/runtime/dsh-home'))
    expect(path?.split(':')[0]).toBe(join(canonicalWorkspace, '.backend-team/runtime/dsh/0.1.0-rc.6/node_modules/.bin'))

    const userDshHome = join(workspace, 'user-profile')
    const explicit = await runScript(workspace, ['--dsh-home', userDshHome])
    expect(explicit.code, explicit.stderr).toBe(0)
    expect((await readFile(environmentFile, 'utf8')).split('\n')[0]).toBe(userDshHome)
  })
})

function runScript(workspace: string, extraArgs: string[] = []): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts/backend-team-uninstall.mjs')
    const child = spawn(join(workspace, '.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node'), [script, '--workspace', workspace, ...extraArgs, '--confirm', 'preserve-data'], { cwd: workspace, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data })
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

async function createWorkspace(): Promise<string> {
  const parent = join(process.cwd(), '.backend-team/test-workspaces')
  await mkdir(parent, { recursive: true })
  const workspace = await mkdtemp(join(parent, 'backend-team-uninstall-'))
  workspaces.push(workspace)
  return workspace
}
