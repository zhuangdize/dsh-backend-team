import { createHash, randomBytes } from 'node:crypto'
import type { MigrationPreview } from './migration-adapter.js'

export interface MigrationVerificationRunner {
  createDatabase(name: string): Promise<void>
  dropDatabase(name: string): Promise<void>
  applyAll(database: string): Promise<void>
  /** Materialize the declared prior schema in an upgrade verification database. */
  initializeBaseline?(database: string, priorSchemaHash: string): Promise<void>
  /** Apply this exact preview to an initialized upgrade baseline. */
  applyMigration?(database: string, preview: MigrationPreview): Promise<void>
  schemaHash(database: string): Promise<string>
  runIntegrationTests(database: string): Promise<{ passed: boolean; output: string }>
  snapshot?(database: string, reason: string): Promise<string>
  rollbackOrRepair?(database: string): Promise<{ mode: 'rollback' | 'forward-repair'; passed: boolean; output: string }>
}
export interface MigrationVerificationOptions { readonly expectedSchemaHash: string; readonly priorSchemaHash?: string; readonly approvalToken?: string; readonly snapshotRequired?: boolean }
export interface MigrationEvidence { readonly migrationId: string; readonly sqlSha256: string; readonly emptyDatabase: string; readonly upgradeDatabase?: string; readonly schemaHash: string; readonly integrationTests: string; readonly recovery?: string; readonly snapshotRef?: string }

export class MigrationVerifier {
  constructor(private readonly runner: MigrationVerificationRunner) {}
  async verify(preview: MigrationPreview, options: MigrationVerificationOptions): Promise<MigrationEvidence> {
    // Keep one immutable value through all runner calls; a runner is an
    // external boundary and must not be able to swap the SQL after hashing.
    const exactPreview = Object.freeze({ ...preview })
    const sqlSha256 = createHash('sha256').update(exactPreview.sql).digest('hex')
    if (exactPreview.sqlSha256 !== sqlSha256) throw new Error('migration SQL hash does not match preview')
    const highRisk = exactPreview.risk === 'high' || exactPreview.risk === 'destructive'
    // High/destructive verification always needs a snapshot. The option can
    // request one for standard migrations, but cannot waive this policy.
    const snapshotRequired = options.snapshotRequired === true || highRisk
    if (highRisk && (typeof options.approvalToken !== 'string' || options.approvalToken.trim().length === 0)) throw new Error('high-risk migration requires approval token')
    if (snapshotRequired && this.runner.snapshot === undefined) throw new Error('migration snapshot capability is required')
    if (options.priorSchemaHash !== undefined && (this.runner.initializeBaseline === undefined || this.runner.applyMigration === undefined || this.runner.rollbackOrRepair === undefined)) throw new Error('upgrade verification capabilities are required')
    // PostgreSQL identifiers are limited to 63 bytes. Keep room for the
    // verification prefix, random suffix, and the `_upgrade` child name.
    const migrationName = exactPreview.migrationId.replaceAll(/[^a-z0-9_]/gi, '_').slice(0, 24) || 'migration'
    const emptyDatabase = `verify_${migrationName}_empty_${randomBytes(6).toString('hex')}`
    let emptyCreated = false
    let upgradeDatabase: string | undefined
    let upgradeCreated = false
    let evidence: MigrationEvidence | undefined
    let primaryError: unknown
    let failed = false
    try {
      // Record cleanup intent before the request: a dropped connection can
      // mean the server created the database even though the call rejected.
      emptyCreated = true; await this.runner.createDatabase(emptyDatabase)
      await this.runner.applyAll(emptyDatabase)
      const schemaHash = await this.runner.schemaHash(emptyDatabase)
      if (schemaHash !== options.expectedSchemaHash) throw new Error('migration schema does not match expected schema')
      const tests = await this.runner.runIntegrationTests(emptyDatabase)
      if (!tests.passed) throw new Error(`migration integration tests failed: ${tests.output}`)
      const integrationOutputs = [tests.output]
      let recovery: string | undefined
      if (options.priorSchemaHash !== undefined) {
        upgradeDatabase = `${emptyDatabase}_upgrade`; upgradeCreated = true; await this.runner.createDatabase(upgradeDatabase)
        await this.runner.initializeBaseline!(upgradeDatabase, options.priorSchemaHash)
        const baselineHash = await this.runner.schemaHash(upgradeDatabase)
        if (baselineHash !== options.priorSchemaHash) throw new Error('upgrade baseline does not match prior schema')
        await this.runner.applyMigration!(upgradeDatabase, exactPreview)
        const upgraded = await this.runner.schemaHash(upgradeDatabase); if (upgraded !== options.expectedSchemaHash) throw new Error('upgrade schema does not match expected schema')
        const upgradeTests = await this.runner.runIntegrationTests(upgradeDatabase)
        if (!upgradeTests.passed) throw new Error(`upgrade integration tests failed: ${upgradeTests.output}`)
        integrationOutputs.push(upgradeTests.output)
        const result = await this.runner.rollbackOrRepair!(upgradeDatabase); if (!result.passed) throw new Error(`migration ${result.mode} failed: ${result.output}`); recovery = result.mode
      }
      // This snapshot documents the disposable verification database only; it
      // is not a production backup or a production rollback guarantee.
      const snapshotRef = snapshotRequired ? await this.runner.snapshot!(emptyDatabase, `migration:${exactPreview.migrationId}`) : undefined
      if (snapshotRequired && (typeof snapshotRef !== 'string' || snapshotRef.length === 0)) throw new Error('migration snapshot reference is empty')
      evidence = { migrationId: exactPreview.migrationId, sqlSha256, emptyDatabase, ...(upgradeDatabase === undefined ? {} : { upgradeDatabase }), schemaHash, integrationTests: integrationOutputs.join('\n'), ...(recovery === undefined ? {} : { recovery }), ...(snapshotRef === undefined ? {} : { snapshotRef }) }
    } catch (error: unknown) { failed = true; primaryError = error }
    const cleanupErrors: unknown[] = []
    if (upgradeCreated && upgradeDatabase !== undefined) { try { await this.runner.dropDatabase(upgradeDatabase) } catch (error: unknown) { cleanupErrors.push(error) } }
    if (emptyCreated) { try { await this.runner.dropDatabase(emptyDatabase) } catch (error: unknown) { cleanupErrors.push(error) } }
    if (failed && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], 'migration verification and cleanup failed')
    if (failed) throw primaryError
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'migration verification cleanup failed')
    return evidence!
  }
}
