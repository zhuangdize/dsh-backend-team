import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ControlMediatedApprovalPort } from '@dsh-backend-team/core'
import { DatabaseMigrationReview } from '../src/database-migration-review.js'
import { FileMigrationReviewStore } from '../src/migration-review-store.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture() {
  const sql = 'CREATE TABLE example(id integer);'
  const hash = createHash('sha256').update(sql).digest('hex')
  const approvals = new ControlMediatedApprovalPort('/workspace')
  const apply = vi.fn(async () => undefined)
  let revision = 1
  const review = new DatabaseMigrationReview({ workspaceRoot: '/workspace', approvals, readRevision: async () => revision, prepare: async () => ({ preview: Object.freeze({ sql, sqlSha256: hash, migrationId: 'example', risk: 'standard' }), apply }) })
  return { review, approvals, apply, hash, setRevision: (value: number) => { revision = value } }
}

it('shows exact SQL and waits for application to settle after authenticated approval', async () => {
  const f = fixture()
  await f.review.prepare(1)
  expect(f.apply).not.toHaveBeenCalled()
  expect((await f.review.preview(f.hash))?.files[0]?.content).toBe('CREATE TABLE example(id integer);')
  expect(() => f.review.assertIdle()).toThrow('待确认')
  const pending = f.approvals.listPending()[0]!
  await f.approvals.decideAndWait(pending.id, { effect: 'approve', reason: 'test' }, f.hash, 1)
  expect(f.apply).toHaveBeenCalledTimes(1)
  expect(await f.review.preview(f.hash)).toBeUndefined()
})

it('rejects without applying SQL and permits a fresh preview', async () => {
  const f = fixture(); await f.review.prepare(1)
  await expect(f.review.prepare(1)).rejects.toThrow('待确认')
  await f.approvals.decideAndWait(f.approvals.listPending()[0]!.id, { effect: 'reject', reason: 'test' }, f.hash, 1)
  expect(f.apply).not.toHaveBeenCalled()
  await f.review.prepare(1)
  f.approvals.dispose()
})

it('fails a stale approval before database application', async () => {
  const f = fixture(); await f.review.prepare(1); f.setRevision(2)
  await expect(f.approvals.decideAndWait(f.approvals.listPending()[0]!.id, { effect: 'approve', reason: 'test' }, f.hash, 1)).rejects.toThrow('过期')
  expect(f.apply).not.toHaveBeenCalled()
})

it('replaces a hidden obsolete approval when the workflow revision changes', async () => {
  const f = fixture(); await f.review.prepare(1); f.setRevision(2)
  await f.review.prepare(2)
  expect(f.approvals.listPending()).toHaveLength(1)
  expect(f.approvals.listPending()[0]?.stateRevision).toBe(2)
  expect(f.apply).not.toHaveBeenCalled()
  f.approvals.dispose()
})

it('propagates database failure through the approval response', async () => {
  const f = fixture(); f.apply.mockRejectedValueOnce(new Error('schema changed'))
  await f.review.prepare(1)
  await expect(f.approvals.decideAndWait(f.approvals.listPending()[0]!.id, { effect: 'approve', reason: 'test' }, f.hash, 1)).rejects.toThrow('schema changed')
  expect(f.approvals.listPending()).toHaveLength(0)
})

it('restores a hash-bound migration approval after a host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-migration-review-'))
  try {
    const sql = 'CREATE TABLE example(id integer);'
    const hash = createHash('sha256').update(sql).digest('hex')
    const firstApprovals = new ControlMediatedApprovalPort(root)
    const firstApply = vi.fn(async () => undefined)
    const store = new FileMigrationReviewStore(root)
    const first = new DatabaseMigrationReview({ workspaceRoot: root, approvals: firstApprovals, readRevision: async () => 4, store, prepare: async () => ({ preview: Object.freeze({ sql, sqlSha256: hash, migrationId: 'example', risk: 'standard' }), apply: firstApply }) })
    await first.prepare(4)
    expect(JSON.parse(await readFile(join(root, '.backend-team/runtime/postgresql/pending-migration.json'), 'utf8'))).toMatchObject({ revision: 4, preview: { sqlSha256: hash } })
    firstApprovals.dispose()

    const restoredApprovals = new ControlMediatedApprovalPort(root)
    const restoredApply = vi.fn(async () => undefined)
    const restored = new DatabaseMigrationReview({ workspaceRoot: root, approvals: restoredApprovals, readRevision: async () => 4, store, restore: async record => ({ preview: { ...record.preview, migrationId: 'regenerated_name' }, apply: restoredApply }) , prepare: async () => { throw new Error('must restore saved migration') } })
    await expect(restored.restorePending()).resolves.toBe(true)
    const pending = restoredApprovals.listPending()[0]!
    await restoredApprovals.decideAndWait(pending.id, { effect: 'approve', reason: 'restart' }, hash, 4)
    expect(restoredApply).toHaveBeenCalledTimes(1)
    await expect(store.load()).resolves.toBeUndefined()
    restoredApprovals.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('clears a saved migration when its durable revision is stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-migration-review-'))
  try {
    const sql = 'CREATE TABLE example(id integer);'; const hash = createHash('sha256').update(sql).digest('hex'); const store = new FileMigrationReviewStore(root); const approvals = new ControlMediatedApprovalPort(root)
    const review = new DatabaseMigrationReview({ workspaceRoot: root, approvals, readRevision: async () => 1, store, prepare: async () => ({ preview: Object.freeze({ sql, sqlSha256: hash, migrationId: 'example', risk: 'standard' }), apply: async () => undefined }) })
    await review.prepare(1); approvals.dispose()
    const restarted = new DatabaseMigrationReview({ workspaceRoot: root, approvals: new ControlMediatedApprovalPort(root), readRevision: async () => 2, store, restore: async record => ({ preview: record.preview, apply: async () => undefined }), prepare: async () => { throw new Error('not used') } })
    await expect(restarted.restorePending()).rejects.toThrow('过期')
    await expect(store.load()).resolves.toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('clears a hash-tampered pending migration before reporting the recovery error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-migration-review-'))
  try {
    const sql = 'CREATE TABLE example(id integer);'
    const hash = createHash('sha256').update(sql).digest('hex')
    const store = new FileMigrationReviewStore(root)
    const approvals = new ControlMediatedApprovalPort(root)
    const review = new DatabaseMigrationReview({ workspaceRoot: root, approvals, readRevision: async () => 3, store, prepare: async () => ({ preview: Object.freeze({ sql, sqlSha256: hash, migrationId: 'example', risk: 'standard' }), apply: async () => undefined }) })
    await review.prepare(3)
    approvals.dispose()
    const path = join(root, '.backend-team/runtime/postgresql/pending-migration.json')
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { preview: { sql: string } }
    persisted.preview.sql = 'CREATE TABLE tampered(id integer);'
    await writeFile(path, `${JSON.stringify(persisted)}\n`, { mode: 0o600 })

    const restartedApprovals = new ControlMediatedApprovalPort(root)
    const restarted = new DatabaseMigrationReview({ workspaceRoot: root, approvals: restartedApprovals, readRevision: async () => 3, store, restore: async record => ({ preview: record.preview, apply: async () => undefined }), prepare: async () => { throw new Error('not used') } })
    await expect(restarted.restorePending()).rejects.toThrow('待审批迁移记录无效，已阻止恢复')
    await expect(store.load()).resolves.toBeUndefined()
    restartedApprovals.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('isolates pending migration records by conversation task while retaining the legacy path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-migration-review-'))
  try {
    const sql = 'CREATE TABLE isolated(id integer);'
    const hash = createHash('sha256').update(sql).digest('hex')
    const record = {
      schemaVersion: 1 as const,
      approvalId: 'migration-isolated-1',
      workspaceId: root,
      revision: 1,
      request: { kind: 'migration' as const, summary: 'isolated', artifactHashes: { migration: hash } },
      preview: { migrationId: 'isolated', sql, sqlSha256: hash, risk: 'standard' as const },
      savedAt: new Date().toISOString(),
    }
    const first = new FileMigrationReviewStore(root, '11111111-1111-4111-8111-111111111111')
    const second = new FileMigrationReviewStore(root, '22222222-2222-4222-8222-222222222222')
    const legacy = new FileMigrationReviewStore(root)
    await first.save(record)
    await second.save({ ...record, approvalId: 'migration-isolated-2' })
    await legacy.save({ ...record, approvalId: 'migration-legacy' })
    expect(await first.load()).toMatchObject({ approvalId: 'migration-isolated-1' })
    expect(await second.load()).toMatchObject({ approvalId: 'migration-isolated-2' })
    expect(await legacy.load()).toMatchObject({ approvalId: 'migration-legacy' })
    expect(await readFile(join(root, '.backend-team/runtime/postgresql/pending-migration-11111111-1111-4111-8111-111111111111.json'), 'utf8')).toContain('migration-isolated-1')
  } finally { await rm(root, { recursive: true, force: true }) }
})
