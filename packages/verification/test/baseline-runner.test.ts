import { describe, expect, it } from 'vitest'
import { VerificationCommandRunner } from '../src/verification-command.js'
import { BaselineRunner } from '../src/baseline-runner.js'

const command = { id: 'typecheck', argv: ['npm', 'run', 'typecheck'], cwd: '/workspace', purpose: 'typecheck' as const, evidenceIds: ['typecheck'] }

describe('BaselineRunner', () => {
  it('captures argv, hashes, redacted output, and exit status', async () => {
    const runner = new BaselineRunner({ commandRunner: new VerificationCommandRunner({
      runner: { run: async () => ({ exitCode: 0, stdout: 'token=super-secret', stderr: '', durationMs: 12 }) },
      now: (() => { let value = 1_700_000_000_000; return () => value += 10 })(),
    }) })
    const result = await runner.capture([command])
    expect(result[0]).toMatchObject({ id: 'typecheck', argv: ['npm', 'run', 'typecheck'], status: 'passed', durationMs: 12, stdoutExcerpt: 'token=[REDACTED]' })
    expect(result[0]?.stdoutSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('records an unavailable command as blocked', async () => {
    const runner = new BaselineRunner({ commandRunner: new VerificationCommandRunner({
      runner: { run: async () => { throw new Error('executable not found') } },
    }) })
    const result = await runner.capture([{ ...command, argv: [] }])
    expect(result[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('no executable') })
  })
})
