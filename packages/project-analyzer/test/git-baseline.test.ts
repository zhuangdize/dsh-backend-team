import { describe, expect, it } from 'vitest'
import type { CommandRequest, CommandResult, CommandRunner } from '@dsh-backend-team/contracts'
import { GitBaseline } from '../src/index.js'

function result(exitCode: number, stdout = '', stderr = ''): CommandResult {
  return { exitCode, stdout, stderr, durationMs: 1 }
}

function runner(results: readonly CommandResult[]): { readonly runner: CommandRunner, readonly requests: CommandRequest[] } {
  const requests: CommandRequest[] = []
  let index = 0
  return {
    requests,
    runner: {
      async run(request): Promise<CommandResult> {
        requests.push(request)
        return results[index++] ?? result(1, '', 'unexpected command')
      },
    },
  }
}

describe('GitBaseline', () => {
  it('captures a clean repository through deterministic read-only Git requests', async () => {
    const fake = runner([result(0, '/workspace\n'), result(0, 'abc123\n'), result(0)])

    const baseline = await new GitBaseline({ runner: fake.runner, cwd: '/workspace' }).capture()

    expect(baseline).toEqual({ repository: true, head: 'abc123', entries: [] })
    expect(fake.requests.map((request) => request.args)).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
    ])
    expect(fake.requests.every((request) => request.executable === 'git' && request.risk === 'read' && request.networkPolicy === 'deny')).toBe(true)
  })

  it('returns a typed no-repository baseline without issuing later Git commands', async () => {
    const fake = runner([result(128, '', 'not a git repository')])

    await expect(new GitBaseline({ runner: fake.runner, cwd: '/workspace' }).capture()).resolves.toEqual({ repository: false, reason: 'not-a-repository', entries: [] })
    expect(fake.requests).toHaveLength(1)
  })

  it('parses NUL porcelain v2 records for staged, modified, untracked, renamed, deleted, and conflicted paths', async () => {
    const status = [
      '1 MM N... 100644 100644 100644 aaa bbb src/app.ts',
      '1 .D N... 100644 100644 000000 aaa bbb src/removed.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts',
      'src/old.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
      '? new file.ts',
    ].join('\0') + '\0'
    const fake = runner([result(0, '/workspace\n'), result(0, 'abc123\n'), result(0, status)])

    const baseline = await new GitBaseline({ runner: fake.runner, cwd: '/workspace' }).capture()

    expect(baseline.entries).toEqual([
      expect.objectContaining({ path: 'src/app.ts', states: ['staged', 'tracked-modified'] }),
      expect.objectContaining({ path: 'src/removed.ts', states: ['deleted'] }),
      expect.objectContaining({ path: 'src/new.ts', previousPath: 'src/old.ts', states: ['renamed', 'staged'] }),
      expect.objectContaining({ path: 'src/conflict.ts', states: ['conflicted'] }),
      expect.objectContaining({ path: 'new file.ts', states: ['untracked'] }),
    ])
  })

  it('filters absolute, traversing, and sensitive status paths before exposing baseline entries', async () => {
    const status = ['? /absolute.ts', '? ../escape.ts', '? secrets/token.ts', '? src/visible.ts'].join('\0') + '\0'
    const fake = runner([result(0, '/workspace\n'), result(0, 'abc123\n'), result(0, status)])

    const baseline = await new GitBaseline({ runner: fake.runner, cwd: '/workspace' }).capture()

    expect(baseline).toMatchObject({ repository: true, entries: [{ path: 'src/visible.ts', states: ['untracked'] }] })
  })
})
