import { createHash, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DrizzleKitGenerator, OrmSchemaSynchronizer, SqlRiskAnalyzer, assertDatabaseId } from '@dsh-backend-team/database'
import type { SchemaDesignSessionRecord } from '@dsh-backend-team/database'
import type { PreparedDatabaseMigration } from './database-migration-review.js'

export interface NativeMigrationOperations {
  session(): SchemaDesignSessionRecord | undefined
  url(database: string): Promise<string>
  command(program: string, args: readonly string[]): Promise<string>
}

/** Uses only owned design/source names and verifies generated DDL on a disposable clone. */
export async function prepareNativeDatabaseMigration(root: string, toolingRoot: string, operations: NativeMigrationOperations, ormSchemaPath?: string): Promise<PreparedDatabaseMigration> {
  const session = operations.session()
  if (session === undefined) throw new Error('请先打开数据库工具并保存表结构修改')
  assertDatabaseId(session.sourceDatabase); assertDatabaseId(session.database)
  const schema = async (database: string): Promise<string> => canonicalDump(await operations.command('pg_dump', ['--dbname', database, '--schema-only', '--no-owner', '--no-privileges']))
  const before = await schema(session.sourceDatabase)
  const designed = await schema(session.database)
  if (before === designed) throw new Error('数据库结构没有变化，无需生成迁移')
  const generated = await new DrizzleKitGenerator({ workspaceRoot: root, toolingRoot, nodeExecutable: process.execPath }).generate(await operations.url(session.sourceDatabase), await operations.url(session.database))
  let sql = generated.preview.sql
  const verification = 'migration_verify_' + randomBytes(8).toString('hex')
  const generatedSql = join(generated.directory, 'generated.sql')
  // psql owns the transaction; generated SQL is read from these exact private bytes.
  await writeFile(generatedSql, sql, { mode: 0o600, flag: 'wx' })
  const apply = async (database: string, path = generatedSql): Promise<void> => {
    await operations.command('psql', ['--dbname', database, '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--single-transaction', '--command', "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '25s';", '--file', path])
  }
  await operations.command('createdb', ['--maintenance-db', 'postgres', '--template', session.sourceDatabase, verification])
  try {
    await apply(verification)
    // Drizzle pull 0.31.10 loses names on single-column primary keys.
    // Restore only names whose table and key columns are otherwise identical.
    const keys = async (database: string): Promise<readonly PrimaryKey[]> => {
      const result = await operations.command('psql', ['--dbname', database, '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--command', "SELECT coalesce(json_agg(k), '[]'::json) FROM (SELECT n.nspname AS schema, t.relname AS table, c.conname AS name, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='p' AND n.nspname='public') k"])
      return JSON.parse(result) as PrimaryKey[]
    }
    const actual = await keys(verification)
    const expected = await keys(session.database)
    const renames = expected.flatMap(key => {
      const found = actual.find(candidate => candidate.schema === key.schema && candidate.table === key.table && candidate.definition === key.definition)
      return found === undefined || found.name === key.name ? [] : [`ALTER TABLE ${identifier(key.schema)}.${identifier(key.table)} RENAME CONSTRAINT ${identifier(found.name)} TO ${identifier(key.name)};`]
    }).join('\n')
    if (renames) {
      const renamePath = join(generated.directory, 'constraint-names.sql')
      await writeFile(renamePath, renames, { mode: 0o600, flag: 'wx' })
      await apply(verification, renamePath)
      sql += '\n' + renames + '\n'
    }
    if (await schema(verification) !== designed) throw new Error('迁移结果与数据库工具中的设计不一致，已阻止审批')
  } finally { await operations.command('dropdb', ['--maintenance-db', 'postgres', verification]) }
  if (await schema(session.sourceDatabase) !== before || await schema(session.database) !== designed) throw new Error('生成期间数据库结构已改变，请重试')
  const preview = Object.freeze({ ...generated.preview, sql, sqlSha256: digest(sql), risk: new SqlRiskAnalyzer().analyze(sql).risk })
  const ormSchema = ormSchemaPath === undefined ? undefined : await new OrmSchemaSynchronizer(root).prepare(generated.schemaPath, ormSchemaPath)
  await writeFile(join(generated.directory, 'reviewed.sql'), sql, { mode: 0o600, flag: 'wx' })
  await writeFile(join(generated.directory, 'review.json'), JSON.stringify({ sqlSha256: preview.sqlSha256, sourceDatabase: session.sourceDatabase, sourceSha256: digest(before), designSha256: digest(designed), verified: true }, null, 2), { mode: 0o600, flag: 'wx' })
  let consumed = false
  return {
    preview,
    target: { sourceDatabase: session.sourceDatabase, designDatabase: session.database },
    apply: async () => {
      if (consumed) throw new Error('迁移审批已使用')
      consumed = true
      if (operations.session() !== session || await schema(session.sourceDatabase) !== before || await schema(session.database) !== designed) throw new Error('数据库结构已改变，请重新生成迁移')
      const backup = 'migration_backup_' + randomBytes(8).toString('hex')
      try {
        await ormSchema?.apply()
        // Preserve a complete clone for recovery, including data, immediately before applying.
        await operations.command('createdb', ['--maintenance-db', 'postgres', '--template', session.sourceDatabase, backup])
        await writeFile(join(generated.directory, 'backup.json'), JSON.stringify({ database: backup, sqlSha256: preview.sqlSha256 }), { mode: 0o600, flag: 'wx' })
        // Recreate the execution file from the immutable preview; editable disk SQL is not approval.
        const executionSql = join(generated.directory, 'approved-' + randomBytes(8).toString('hex') + '.sql')
        await writeFile(executionSql, sql, { mode: 0o600, flag: 'wx' })
        await apply(session.sourceDatabase, executionSql)
        if (await schema(session.sourceDatabase) !== designed) throw new Error(`迁移后结构验证失败；恢复副本：${backup}`)
        await writeFile(join(generated.directory, 'applied.json'), JSON.stringify({ sqlSha256: preview.sqlSha256, backupDatabase: backup, ...(ormSchema === undefined ? {} : { ormSchemaPath: ormSchema.preview.path, ormSchemaSha256: ormSchema.preview.afterSha256 }), appliedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' })
      } catch (error: unknown) {
        try { await ormSchema?.restore() } catch (rollback: unknown) { throw new AggregateError([error, rollback], '数据库迁移失败且 ORM 源码回滚失败') }
        throw error
      }
    },
    ...(ormSchema === undefined ? {} : { ormSchema: ormSchema.preview }),
  }
}

/** pg_dump emits a fresh psql restriction nonce on every call; all DDL/order is retained. */
function canonicalDump(sql: string): string { return sql.replace(/^\\(?:un)?restrict [^\r\n]+\r?\n/gmu, '') }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
interface PrimaryKey { readonly schema: string; readonly table: string; readonly name: string; readonly definition: string }
function identifier(value: string): string { return '"' + value.replace(/"/gu, '""') + '"' }
