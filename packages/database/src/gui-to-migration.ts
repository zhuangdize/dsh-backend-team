import { createHash } from 'node:crypto'
import { diffSchemas, type SchemaDiff } from './schema-diff.js'
import type { MigrationEvidence } from './migration-verifier.js'
import type { MigrationPreview } from './migration-adapter.js'

export interface GuiMigrationExpert { updateSchemaAndGenerateMigration(diff: SchemaDiff): Promise<MigrationPreview> }
/** Verification must return evidence bound to the exact migration preview. */
export interface GuiMigrationVerifier { verify(preview: MigrationPreview): Promise<MigrationEvidence> }
export interface GuiToMigrationOptions { readonly expert: GuiMigrationExpert; readonly verifier: GuiMigrationVerifier }
/** Generates a verified proposal only. Applying it requires a separate host approval. */
export class GuiToMigration {
  constructor(private readonly options: GuiToMigrationOptions) {}
  async convert(beforeSql: string, afterSql: string): Promise<MigrationPreview> {
    const diff = diffSchemas(beforeSql, afterSql); if (!diff.changed) throw new Error('schema design contains no changes')
    const generatedPreview = await this.options.expert.updateSchemaAndGenerateMigration(diff)
    // The verifier is external code. Give it an immutable value object so it
    // cannot validate one SQL string and hand the applier another one.
    const preview = Object.freeze({ ...generatedPreview })
    const sqlSha256 = createHash('sha256').update(preview.sql).digest('hex')
    if (preview.sqlSha256 !== sqlSha256) throw new Error('migration SQL hash does not match preview')
    const evidence = await this.options.verifier.verify(preview)
    if (createHash('sha256').update(preview.sql).digest('hex') !== preview.sqlSha256) throw new Error('migration SQL changed during verification')
    if (!isBoundEvidence(evidence, preview)) throw new Error('migration verification evidence is not bound to the preview')
    return preview
  }
}

function isBoundEvidence(evidence: unknown, preview: MigrationPreview): evidence is MigrationEvidence {
  if (typeof evidence !== 'object' || evidence === null) return false
  const candidate = evidence as Partial<MigrationEvidence>
  return candidate.migrationId === preview.migrationId && candidate.sqlSha256 === preview.sqlSha256 && typeof candidate.emptyDatabase === 'string' && candidate.emptyDatabase.length > 0 && typeof candidate.schemaHash === 'string' && candidate.schemaHash.length > 0 && typeof candidate.integrationTests === 'string' && candidate.integrationTests.length > 0
}
