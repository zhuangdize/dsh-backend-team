import type { AgentResult } from '@dsh-backend-team/contracts'
import { runManagedNodeTests, type ManagedNodeTestOptions } from './managed-node-tests.js'

export interface ManagedTestVerificationOptions {
  /** Whether this task explicitly declares a required test verification. */
  readonly requireSuccessfulTest?: boolean
}

/** Evidence is issued by the host executor, never reconstructed from model prose. */
export class ManagedTestEvidence {
  private readonly records = new Map<string, { commands: AgentResult['commands']; stale: boolean }>()
  async run(taskId: string, options: ManagedNodeTestOptions): Promise<Awaited<ReturnType<typeof runManagedNodeTests>>> {
    const result = await runManagedNodeTests(options)
    const previous = this.records.get(taskId)
    // Earlier failures belong to the previous file revision (and remain in the
    // session log). Current evidence must describe tests after the latest edit.
    this.records.set(taskId, { commands: [...(previous?.stale ? [] : previous?.commands ?? []), { argv: [...result.argv], exitCode: result.exitCode }], stale: false })
    return result
  }
  invalidate(taskId: string): void {
    const record = this.records.get(taskId)
    if (record !== undefined) record.stale = true
  }
  verify(result: AgentResult, options: ManagedTestVerificationOptions = {}): AgentResult {
    const evidence = this.records.get(result.taskId)
    if (options.requireSuccessfulTest !== false && result.status === 'passed' && (evidence === undefined || evidence.stale || evidence.commands.at(-1)?.exitCode !== 0)) throw new Error('passing development result requires a real successful test after the last edit')
    return { ...result, commands: evidence?.commands ?? [] }
  }
}
