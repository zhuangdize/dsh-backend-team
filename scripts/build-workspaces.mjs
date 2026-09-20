import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildOrder = Object.freeze([
  '@dsh-backend-team/contracts',
  '@dsh-backend-team/agent-team',
  '@dsh-backend-team/core',
  '@dsh-backend-team/policy-engine',
  '@dsh-backend-team/development',
  '@dsh-backend-team/dependency-governance',
  '@dsh-backend-team/database',
  '@dsh-backend-team/web',
  '@dsh-backend-team/verification',
  '@dsh-backend-team/platform-macos',
  '@dsh-backend-team/spec-workflow',
  '@dsh-backend-team/project-analyzer',
  '@dsh-backend-team/harness-adapter',
  '@dsh-backend-team/bundle',
])

if (process.argv.length === 3 && process.argv[2] === '--plan') {
  process.stdout.write(`${JSON.stringify(buildOrder)}\n`)
} else if (process.argv.length === 2) {
  await buildAll()
} else {
  throw new Error('usage: node scripts/build-workspaces.mjs [--plan]')
}

async function buildAll() {
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const nodeBin = dirname(process.execPath)
    const npmTarget = await realpath(join(nodeBin, 'npm'))
    const env = { ...process.env, PATH: `${nodeBin}${process.env.PATH ? `:${process.env.PATH}` : ''}` }
    for (const workspace of buildOrder) {
      await runWorkspace(npmTarget, workspace, env, controller.signal)
    }
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

function runWorkspace(npmTarget, workspace, env, signal) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [npmTarget, 'run', 'build', '--workspace', workspace], {
      cwd: root,
      env,
      shell: false,
      signal,
      stdio: 'inherit',
    })
    child.once('error', rejectRun)
    child.once('close', (code, childSignal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`workspace build failed: ${workspace} (${code ?? childSignal ?? 'unknown'})`))
    })
  })
}
