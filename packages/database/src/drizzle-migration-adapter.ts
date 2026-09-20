import { createHash } from 'node:crypto'
import { SqlRiskAnalyzer } from './sql-risk-analyzer.js'
import type { MigrationAdapter, MigrationPreview, MigrationStatus } from './migration-adapter.js'

export interface DrizzleMigrationRunner { generate(signal?: AbortSignal): Promise<{ migrationId: string; sql: string; reverseSql?: string }>; apply(preview: MigrationPreview, approvalToken: string, signal?: AbortSignal): Promise<void>; status(signal?: AbortSignal): Promise<MigrationStatus> }
export class DrizzleMigrationAdapter implements MigrationAdapter {
  constructor(private readonly runner: DrizzleMigrationRunner, private readonly analyzer = new SqlRiskAnalyzer()) {}
  async preview(signal?: AbortSignal): Promise<MigrationPreview> { const generated = await this.runner.generate(signal); return toPreview(generated, this.analyzer) }
  async apply(preview: MigrationPreview, approvalToken: string, signal?: AbortSignal): Promise<MigrationPreview> {
    const exactPreview = Object.freeze({ ...preview })
    if (typeof exactPreview.sql !== 'string' || createHash('sha256').update(exactPreview.sql).digest('hex') !== exactPreview.sqlSha256) throw new Error('migration SQL hash does not match reviewed preview')
    if (typeof approvalToken !== 'string' || approvalToken.trim().length === 0) throw new Error('migration approval token is required')
    if (this.analyzer.analyze(exactPreview.sql).risk !== exactPreview.risk) throw new Error('migration risk does not match reviewed SQL')
    // The runner must validate and consume a host-issued approval bound to this
    // exact preview at its execution boundary; a nonempty string is not approval.
    await this.runner.apply(exactPreview, approvalToken, signal)
    return exactPreview
  }
  status(signal?: AbortSignal): Promise<MigrationStatus> { return this.runner.status(signal) }
}
export function toPreview(generated: { migrationId: string; sql: string; reverseSql?: string }, analyzer = new SqlRiskAnalyzer()): MigrationPreview { return { ...generated, sqlSha256: createHash('sha256').update(generated.sql).digest('hex'), risk: analyzer.analyze(generated.sql).risk } }
