import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ApprovalRequest } from '@dsh-backend-team/contracts'
import type { MigrationPreview, OrmSchemaSyncPreview } from '@dsh-backend-team/database'

/** Durable facts needed to recreate a migration approval after a host restart. */
export interface PersistedMigrationReview {
  readonly schemaVersion: 1
  readonly approvalId: string
  readonly workspaceId: string
  readonly revision: number
  readonly request: ApprovalRequest & { readonly kind: 'migration' }
  readonly preview: MigrationPreview
  readonly target?: Readonly<Record<string, string>>
  readonly ormSchema?: OrmSchemaSyncPreview
  readonly savedAt: string
}

export interface MigrationReviewStore {
  load(): Promise<PersistedMigrationReview | undefined>
  save(value: PersistedMigrationReview): Promise<void>
  clear(): Promise<void>
}

/** Workspace-local, mode 0600 store. SQL stays local and is hash-bound on read. */
export class FileMigrationReviewStore implements MigrationReviewStore {
  private readonly directory: string
  private readonly path: string
  private operation: Promise<void> = Promise.resolve()

  constructor(workspaceRoot: string, taskId?: string) {
    this.directory = resolve(realpathSync.native(workspaceRoot), '.backend-team/runtime/postgresql')
    if (taskId !== undefined && !/^[a-z0-9-]{1,80}$/u.test(taskId)) throw new Error('invalid migration task id')
    // The legacy host has no task id and keeps the original path for backward
    // compatibility. Conversation task hosts use a task-owned record so the
    // legacy host cannot consume another task's pending migration on startup.
    this.path = join(this.directory, taskId === undefined ? 'pending-migration.json' : `pending-migration-${taskId}.json`)
  }

  load(): Promise<PersistedMigrationReview | undefined> {
    return this.withOperation(async () => {
      try { await this.assertDirectory(false) } catch (error: unknown) { if (isMissing(error)) return undefined; throw error }
      try {
        await this.assertFile()
        return parsePersisted(JSON.parse(await readFile(this.path, 'utf8')))
      } catch (error: unknown) {
        if (isMissing(error)) return undefined
        throw error
      }
    }) as Promise<PersistedMigrationReview | undefined>
  }

  save(value: PersistedMigrationReview): Promise<void> {
    return this.withOperation(async () => {
      const parsed = parsePersisted(value)
      await this.assertDirectory(true)
      const temporary = join(this.directory, `.pending-migration.${randomUUID()}.tmp`)
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      try {
        const file = await open(temporary, 'r')
        try { await file.sync() } finally { await file.close() }
        await rename(temporary, this.path)
        await chmod(this.path, 0o600)
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    })
  }

  clear(): Promise<void> {
    return this.withOperation(async () => {
      try { await this.assertDirectory(false) } catch (error: unknown) { if (isMissing(error)) return; throw error }
      try {
        await this.assertFile()
        await rm(this.path)
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
      } catch (error: unknown) {
        if (!isMissing(error)) throw error
      }
    })
  }

  private withOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async assertDirectory(create: boolean): Promise<void> {
    const workspace = resolve(this.directory, '../..', '..')
    const backend = join(workspace, '.backend-team')
    const runtime = join(backend, 'runtime')
    for (const [path, shouldCreate] of [[backend, create], [runtime, create], [this.directory, create]] as const) {
      try {
        const details = await lstat(path)
        if (details.isSymbolicLink() || !details.isDirectory() || await realpath(path) !== path) throw new Error(`migration review directory is unsafe: ${path}`)
        await chmod(path, 0o700)
      } catch (error: unknown) {
        if (!isMissing(error) || !shouldCreate) throw error
        await mkdir(path, { recursive: false, mode: 0o700 })
      }
    }
  }

  private async assertFile(): Promise<void> {
    const details = await lstat(this.path)
    if (details.isSymbolicLink() || !details.isFile()) throw new Error('pending migration file is not a regular file')
  }
}

function parsePersisted(value: unknown): PersistedMigrationReview {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.approvalId !== 'string' || value.approvalId.length < 8 || typeof value.workspaceId !== 'string' || value.workspaceId.length === 0 || !Number.isSafeInteger(value.revision) || !isRecord(value.request) || !isRecord(value.preview) || typeof value.savedAt !== 'string') throw new Error('pending migration record is malformed')
  const revision = value.revision as number
  if (revision < 0) throw new Error('pending migration record is malformed')
  const approvalId = value.approvalId
  const workspaceId = value.workspaceId
  const savedAt = value.savedAt
  const request = value.request
  const preview = value.preview
  if (request.kind !== 'migration' || typeof request.summary !== 'string' || !isRecord(request.artifactHashes) || typeof request.artifactHashes.migration !== 'string' || !/^[a-f0-9]{64}$/u.test(request.artifactHashes.migration) || Object.values(request.artifactHashes).some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/u.test(item))) throw new Error('pending migration request is malformed')
  const requestSummary = request.summary
  const migrationHash = request.artifactHashes.migration
  if (typeof preview.migrationId !== 'string' || preview.migrationId.length === 0 || typeof preview.sql !== 'string' || typeof preview.sqlSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(preview.sqlSha256) || (preview.risk !== 'standard' && preview.risk !== 'high' && preview.risk !== 'destructive') || (preview.reverseSql !== undefined && typeof preview.reverseSql !== 'string')) throw new Error('pending migration preview is malformed')
  const migrationId = preview.migrationId
  const sql = preview.sql
  const sqlSha256 = preview.sqlSha256
  const risk = preview.risk as MigrationPreview['risk']
  const reverseSql = preview.reverseSql
  if (migrationHash !== sqlSha256 || createHash('sha256').update(sql).digest('hex') !== sqlSha256) throw new Error('pending migration approval hash does not match preview')
  const target = value.target
  if (target !== undefined && (!isRecord(target) || Object.values(target).some(item => typeof item !== 'string' || item.length === 0))) throw new Error('pending migration target is malformed')
  const normalizedTarget = target === undefined ? undefined : Object.freeze({ ...(target as Record<string, string>) })
  const ormSchema = value.ormSchema
  if (ormSchema !== undefined && (!isRecord(ormSchema) || typeof ormSchema.path !== 'string' || ormSchema.path.length === 0 || ormSchema.path.startsWith('/') || ormSchema.path.split('/').includes('..') || typeof ormSchema.afterSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ormSchema.afterSha256) || typeof ormSchema.content !== 'string' || ormSchema.content.length === 0 || ormSchema.content.length > 4 * 1024 * 1024 || (ormSchema.beforeSha256 !== undefined && (typeof ormSchema.beforeSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ormSchema.beforeSha256))))) throw new Error('pending migration ORM schema is malformed')
  const normalizedOrmSchema = ormSchema === undefined ? undefined : (() => { const record = ormSchema as Record<string, unknown>; const path = record.path as string; const beforeSha256 = record.beforeSha256 as string | undefined; const afterSha256 = record.afterSha256 as string; const content = record.content as string; return Object.freeze({ path, ...(beforeSha256 === undefined ? {} : { beforeSha256 }), afterSha256, content }) })()
  if (normalizedOrmSchema === undefined && request.artifactHashes['orm-schema'] !== undefined) throw new Error('pending migration ORM hash has no saved schema')
  if (normalizedOrmSchema !== undefined && request.artifactHashes['orm-schema'] !== normalizedOrmSchema.afterSha256) throw new Error('pending migration ORM hash does not match request')
  return Object.freeze({ schemaVersion: 1, approvalId, workspaceId, revision, request: Object.freeze({ kind: 'migration', summary: requestSummary, artifactHashes: Object.freeze({ ...request.artifactHashes } as Record<string, string>) }), preview: Object.freeze({ migrationId, sql, sqlSha256, risk, ...(reverseSql === undefined ? {} : { reverseSql }) }), ...(normalizedTarget === undefined ? {} : { target: normalizedTarget }), ...(normalizedOrmSchema === undefined ? {} : { ormSchema: normalizedOrmSchema }), savedAt })
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isMissing(error: unknown): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }
