import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const workspaces: string[] = []

afterEach(async () => {
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true })
  workspaces.length = 0
})

describe('backend-team-start script', () => {
  it('starts the selected Profile with the workspace-local runtime by default', async () => {
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

    const result = await runScript(workspace, ['--profile', 'web', '--port', '3099'])

    expect(result.code, result.stderr).toBe(0)
    expect(await readFile(argumentsFile, 'utf8')).toBe('--profile\nweb\n--host\n127.0.0.1\n--port\n3099\n')
    const [dshHome, path] = (await readFile(environmentFile, 'utf8')).split('\n')
    expect(dshHome).toBe(join(await realWorkspace(workspace), '.backend-team/runtime/dsh-home'))
    expect(path?.split(':')[0]).toBe(join(await realWorkspace(workspace), '.backend-team/runtime/dsh/0.1.0-rc.6/node_modules/.bin'))
  })

  it('rejects non-web Profiles instead of passing Web flags to them', async () => {
    const workspace = await createWorkspace()
    const result = await runScript(workspace, ['--profile', 'headless'], false)

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/only supports the web Profile/i)
  })
})

function runScript(workspace: string, args: string[] = [], useWorkspaceNode = true): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts/backend-team-start.mjs')
    const executable = useWorkspaceNode ? join(workspace, '.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node') : process.execPath
    const child = spawn(executable, [script, '--workspace', workspace, ...args], { cwd: workspace, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data })
    child.once('error', (error) => { stderr += `${error.message}\n`; resolve({ code: 1, stderr }) })
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

async function realWorkspace(workspace: string): Promise<string> {
  return realpath(workspace)
}

async function createWorkspace(): Promise<string> {
  const parent = join(process.cwd(), '.backend-team/test-workspaces')
  await mkdir(parent, { recursive: true })
  const workspace = await mkdtemp(join(parent, 'backend-team-start-'))
  workspaces.push(workspace)
  return workspace
}
