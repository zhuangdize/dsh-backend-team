import { createHash } from 'node:crypto'

/** Input to the migration generator, not executable upgrade SQL. */
export interface SchemaDiff {
  readonly beforeSql: string
  readonly afterSql: string
  readonly beforeSha256: string
  readonly afterSha256: string
  readonly changed: boolean
}

/** Preserve both complete snapshots: text subtraction cannot express ALTER/DROP. */
export function diffSchemas(beforeSql: string, afterSql: string): SchemaDiff {
  return Object.freeze({
    beforeSql,
    afterSql,
    beforeSha256: digest(beforeSql),
    afterSha256: digest(afterSql),
    changed: beforeSql !== afterSql,
  })
}

function digest(sql: string): string { return createHash('sha256').update(sql).digest('hex') }
