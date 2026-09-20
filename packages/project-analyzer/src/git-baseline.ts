import type { CommandRequest, CommandRunner } from '@dsh-backend-team/contracts'
import { SecretFilter } from './secret-filter.js'

export type GitChangeState = 'tracked-modified' | 'untracked' | 'staged' | 'renamed' | 'deleted' | 'conflicted'
export type GitBaselineReason = 'not-a-repository' | 'head-unavailable' | 'status-unavailable'

export interface GitBaselineEntry {
  readonly path: string
  readonly previousPath?: string
  readonly states: readonly GitChangeState[]
}

export type GitBaselineSnapshot =
  | Readonly<{ repository: true; head: string; entries: readonly GitBaselineEntry[] }>
  | Readonly<{ repository: false; reason: GitBaselineReason; entries: readonly [] }>

export interface GitBaselineOptions {
  readonly runner: CommandRunner
  readonly cwd: string
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path) && !path.includes('\\')
    && !path.split('/').some((part) => part.length === 0 || part === '.' || part === '..') && !SecretFilter.isSensitivePath(path)
}

function tailAfterFields(record: string, fields: number): string | undefined {
  let spaces = 0
  for (let index = 0; index < record.length; index += 1) {
    if (record[index] !== ' ') continue
    spaces += 1
    if (spaces === fields) return record.slice(index + 1)
  }
  return undefined
}

function statesForOrdinary(xy: string): readonly GitChangeState[] {
  const states: GitChangeState[] = []
  const index = xy[0] ?? '.'
  const worktree = xy[1] ?? '.'
  if (index === 'D' || worktree === 'D') states.push('deleted')
  if (index !== '.' && index !== 'D') states.push('staged')
  if (worktree !== '.' && worktree !== 'D') states.push('tracked-modified')
  return states.length > 0 ? states : ['tracked-modified']
}

function parseStatus(stdout: string): readonly GitBaselineEntry[] {
  const records = stdout.split('\0')
  const entries: GitBaselineEntry[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    if (record.startsWith('? ')) {
      const path = record.slice(2)
      if (safePath(path)) entries.push({ path, states: ['untracked'] })
      continue
    }
    if (record.startsWith('1 ')) {
      const path = tailAfterFields(record, 8)
      const xy = record.split(' ', 3)[1] ?? ''
      if (path && safePath(path)) entries.push({ path, states: statesForOrdinary(xy) })
      continue
    }
    if (record.startsWith('2 ')) {
      const path = tailAfterFields(record, 9)
      const previousPath = records[index + 1]
      const xy = record.split(' ', 3)[1] ?? ''
      if (path && previousPath && safePath(path) && safePath(previousPath)) {
        const states: GitChangeState[] = ['renamed']
        if ((xy[0] ?? '.') !== '.') states.push('staged')
        if ((xy[1] ?? '.') !== '.') states.push('tracked-modified')
        entries.push({ path, previousPath, states })
      }
      index += 1
      continue
    }
    if (record.startsWith('u ')) {
      const path = tailAfterFields(record, 10)
      if (path && safePath(path)) entries.push({ path, states: ['conflicted'] })
    }
  }
  return entries
}

/** Captures a read-only Git snapshot through an injected command boundary. */
export class GitBaseline {
  constructor(private readonly options: GitBaselineOptions) {}

  async capture(): Promise<GitBaselineSnapshot> {
    const topLevel = await this.run(['rev-parse', '--show-toplevel'], 'capture Git repository root')
    if (topLevel.exitCode !== 0) return { repository: false, reason: 'not-a-repository', entries: [] }
    const head = await this.run(['rev-parse', 'HEAD'], 'capture Git HEAD')
    if (head.exitCode !== 0) return { repository: false, reason: 'head-unavailable', entries: [] }
    const status = await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all'], 'capture Git worktree status')
    if (status.exitCode !== 0) return { repository: false, reason: 'status-unavailable', entries: [] }
    return { repository: true, head: head.stdout.trim(), entries: parseStatus(status.stdout) }
  }

  private run(args: readonly string[], purpose: string) {
    const request: CommandRequest = {
      executable: 'git', args, cwd: this.options.cwd, env: { LANG: 'C', LC_ALL: 'C' }, purpose, risk: 'read', networkPolicy: 'deny', executionFingerprint: `project-analyzer/git/${args.join('/')}`,
    }
    return this.options.runner.run(request)
  }
}
