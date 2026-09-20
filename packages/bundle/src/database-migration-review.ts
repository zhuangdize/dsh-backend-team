import { createHash, randomUUID } from 'node:crypto'
import type { ApprovalRequest } from '@dsh-backend-team/contracts'
import type { ControlMediatedApprovalPort } from '@dsh-backend-team/core'
import type { MigrationPreview, OrmSchemaSyncPreview } from '@dsh-backend-team/database'
import type { MigrationReviewStore, PersistedMigrationReview } from './migration-review-store.js'

export interface PreparedDatabaseMigration {
  readonly preview: MigrationPreview
  /** Stable database identities shown in the approval and used during recovery. */
  readonly target?: Readonly<Record<string, string>>
  /** Optional generated ORM source that is reviewed and applied with the migration. */
  readonly ormSchema?: OrmSchemaSyncPreview
  /** Applies the immutable SQL after checking that the source/design are unchanged. */
  apply(): Promise<void>
}

/** Reuses the authenticated control approval; requesting a preview never applies SQL. */
export class DatabaseMigrationReview {
  private pending: { readonly request: ApprovalRequest; readonly prepared: PreparedDatabaseMigration; readonly revision: number; readonly approvalId: string } | undefined
  private preparing = false
  private restoring = false
  constructor(private readonly options: {
    workspaceRoot: string
    approvals: Pick<ControlMediatedApprovalPort, 'listPending' | 'requestApproval' | 'waitForSettlement' | 'completeSettlement' | 'failSettlement'>
    readRevision(): Promise<number>
    prepare(): Promise<PreparedDatabaseMigration>
    /** Rebuilds the exact reviewed operation; the returned preview must hash-match. */
    restore?: (record: PersistedMigrationReview) => Promise<PreparedDatabaseMigration>
    store?: MigrationReviewStore
  }) {}

  assertIdle(): void {
    if (this.preparing || this.restoring || this.pending !== undefined) throw new Error('请先批准或拒绝待确认的数据库迁移')
  }

  async prepare(revision: number): Promise<void> {
    if (this.pending !== undefined && this.pending.revision !== await this.options.readRevision()) {
      this.options.approvals.failSettlement(this.pending.request, new Error('迁移审批已过期'))
      this.pending = undefined
    }
    this.assertIdle()
    if (this.options.approvals.listPending().length > 0) throw new Error('请先处理当前待确认的内容')
    this.preparing = true
    try {
      if (await this.options.readRevision() !== revision) throw new Error('页面状态已改变，请刷新后重试')
      const prepared = await this.options.prepare()
      if (await this.options.readRevision() !== revision || this.options.approvals.listPending().length > 0) throw new Error('生成期间工作流状态已改变，请重新生成迁移')
      if (digest(prepared.preview.sql) !== prepared.preview.sqlSha256) throw new Error('迁移 SQL 摘要不匹配')
      const request: ApprovalRequest = {
        kind: 'migration',
        summary: `数据库迁移已在独立副本验证。请检查 SQL；批准后应用到本项目开发库。风险：${prepared.preview.risk}。`,
        artifactHashes: { migration: prepared.preview.sqlSha256, ...(prepared.ormSchema === undefined ? {} : { 'orm-schema': prepared.ormSchema.afterSha256 }) },
      }
      const approvalId = 'migration-' + randomUUID()
      this.pending = { request, prepared, revision, approvalId }
      try { await this.persist(approvalId, request, prepared, revision) } catch (error: unknown) { this.pending = undefined; throw error }
      try {
        const decision = this.options.approvals.requestApproval(request, { workspaceId: this.options.workspaceRoot, stateRevision: revision, approvalId })
        this.attachDecision(request, prepared, revision, decision)
      } catch (error: unknown) {
        this.pending = undefined
        throw error
      }
    } finally { this.preparing = false }
  }

  /** Recreates a pending migration request after the host/GUI has restarted. */
  async restorePending(): Promise<boolean> {
    if (this.options.store === undefined) return false
    if (this.options.restore === undefined) throw new Error('迁移恢复器尚未配置，不能恢复待审批迁移')
    this.assertIdle()
    let record: PersistedMigrationReview | undefined
    try {
      record = await this.options.store.load()
    } catch (error: unknown) {
      // A malformed or hash-tampered record must not remain as a startup
      // blocker. Clear only through the store's safe regular-file checks;
      // symlinks and unsafe paths are deliberately left untouched.
      await this.options.store.clear().catch(() => undefined)
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`待审批迁移记录无效，已阻止恢复：${reason}`, { cause: error })
    }
    if (record === undefined) return false
    if (record.workspaceId !== this.options.workspaceRoot || await this.options.readRevision() !== record.revision) {
      await this.options.store.clear()
      throw new Error('迁移审批已过期，请重新生成迁移')
    }
    if (this.options.approvals.listPending().length > 0) throw new Error('请先处理当前待确认的内容')
    this.restoring = true
    try {
      const prepared = await this.options.restore(record)
      if (!samePreview(prepared.preview, record.preview) || !sameOrmSchema(prepared.ormSchema, record.ormSchema)) {
        await this.options.store.clear()
        throw new Error('恢复后的迁移与原审批 SQL 不一致，已阻止应用')
      }
      this.pending = { request: record.request, prepared, revision: record.revision, approvalId: record.approvalId }
      try {
        const decision = this.options.approvals.requestApproval(record.request, { workspaceId: this.options.workspaceRoot, stateRevision: record.revision, approvalId: record.approvalId })
        this.attachDecision(record.request, prepared, record.revision, decision)
        return true
      } catch (error: unknown) {
        this.pending = undefined
        throw error
      }
    } finally {
      this.restoring = false
    }
  }

  async preview(hash: string): Promise<{ artifactHash: string; files: readonly { path: string; content: string }[] } | undefined> {
    const pending = this.pending
    if (pending === undefined || pending.prepared.preview.sqlSha256 !== hash) return undefined
    if (await this.options.readRevision() !== pending.revision || !this.options.approvals.listPending().some(item => item.request === pending.request)) throw new Error('迁移审批已过期')
    return { artifactHash: hash, files: [{ path: 'migration.sql', content: pending.prepared.preview.sql }, ...(pending.prepared.ormSchema === undefined ? [] : [{ path: pending.prepared.ormSchema.path, content: pending.prepared.ormSchema.content }])] }
  }

  private async persist(approvalId: string, request: ApprovalRequest, prepared: PreparedDatabaseMigration, revision: number): Promise<void> {
    if (this.options.store === undefined) return
    await this.options.store.save({ schemaVersion: 1, approvalId, workspaceId: this.options.workspaceRoot, revision, request: request as PersistedMigrationReview['request'], preview: prepared.preview, ...(prepared.target === undefined ? {} : { target: prepared.target }), ...(prepared.ormSchema === undefined ? {} : { ormSchema: prepared.ormSchema }), savedAt: new Date().toISOString() })
  }

  private attachDecision(request: ApprovalRequest, prepared: PreparedDatabaseMigration, revision: number, decision: Promise<{ readonly effect: 'approve' | 'reject' | 'edit'; readonly reason: string }>): void {
    void this.options.approvals.waitForSettlement(request, revision).catch(() => undefined)
    // requestApproval returns a promise owned by the approval port. It is
    // intentionally not awaited here: applying SQL remains behind the
    // explicit user decision and host turn timeouts must not cancel it.
    void decision.then(async value => {
      try {
        if (value.effect === 'approve') {
          if (await this.options.readRevision() !== revision || digest(prepared.preview.sql) !== prepared.preview.sqlSha256) throw new Error('审批内容已过期，请重新生成迁移')
          await prepared.apply()
        }
        this.options.approvals.completeSettlement(request)
        await this.options.store?.clear()
      } catch (error: unknown) {
        this.options.approvals.failSettlement(request, error)
      } finally {
        this.pending = undefined
      }
    }, error => {
      this.pending = undefined
      this.options.approvals.failSettlement(request, error)
    })
  }
}

function digest(sql: string): string { return createHash('sha256').update(sql).digest('hex') }
function samePreview(left: MigrationPreview, right: MigrationPreview): boolean {
  // Drizzle assigns a fresh descriptive filename on every generation. It is
  // useful for display, but it is not part of the reviewed operation's
  // identity. The immutable SQL bytes, digest, risk and reverse SQL are.
  return left.sqlSha256 === right.sqlSha256 && left.sql === right.sql && left.risk === right.risk && left.reverseSql === right.reverseSql
}
function sameOrmSchema(left: OrmSchemaSyncPreview | undefined, right: OrmSchemaSyncPreview | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.path === right.path && left.beforeSha256 === right.beforeSha256 && left.afterSha256 === right.afterSha256 && left.content === right.content
}
