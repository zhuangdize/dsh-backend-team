import { describe, expect, it } from 'vitest'
import { projectVerificationCommands, runProjectVerification } from '../src/project-verification.js'

describe('project verification', () => {
  it('maps only declared typecheck/build/lint scripts to argv', () => {
    const commands = projectVerificationCommands({ packageManagerExecutable: '/workspace/.backend-team/runtime/bin/npm', projectRoot: '/workspace/service', manifest: { scripts: { typecheck: 'tsc -p tsconfig.json', build: 'nest build', test: 'vitest' } } })
    expect(commands.map(command => command.argv)).toEqual([
      ['/workspace/.backend-team/runtime/bin/npm', 'run', 'typecheck'],
      ['/workspace/.backend-team/runtime/bin/npm', 'run', 'build'],
    ])
    expect(commands.every(command => command.approvalRequired === true && command.networkPolicy === 'deny')).toBe(true)
  })

  it('reports missing project checks explicitly and preserves real results', async () => {
    const result = await runProjectVerification({ runner: { run: async request => ({ exitCode: request.args[1] === 'build' ? 1 : 0, stdout: request.args[1] ?? '', stderr: '', durationMs: 1 }) }, input: { commands: projectVerificationCommands({ packageManagerExecutable: '/workspace/npm', projectRoot: '/workspace', manifest: { scripts: { typecheck: 'tsc' } } }), trace: { requirements: {} } } })
    expect(result.report.results[0]?.status).toBe('passed')
    expect(result.report.status).toBe('passed')
    expect(result.notRun).toEqual([{ purpose: 'build', reason: 'project package manifest has no build script' }, { purpose: 'lint', reason: 'project package manifest has no lint script' }])
  })
})
