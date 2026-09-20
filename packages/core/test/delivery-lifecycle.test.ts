import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FileStateStore } from '../src/state-store.js'
import { DeliveryLifecycle } from '../src/delivery-lifecycle.js'
import type { FinalVerificationRecord } from '@dsh-backend-team/contracts'

const record: FinalVerificationRecord = { reportSha256: 'a'.repeat(64), delivery: { status: 'ready', reportPath: '.backend-team/report.json', testStatus: 'passed', scope: 'test scope', requirements: [{ requirementId: 'AC-1', status: 'passed', evidenceIds: ['test-1'], missingEvidenceIds: [] }], unresolvedItems: [] } }
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delivery-lifecycle-')))
  const store = new FileStateStore(root)
  await store.create({ schemaVersion: 1, revision: 0, workspaceRoot: root, phase: 'BUILD', runs: [], approvals: [], approvalTokens: [] })
  const approval = vi.fn(async () => {})
  return { root, store, approval, lifecycle: new DeliveryLifecycle(store, approval) }
}
it('persists BUILD to VERIFY to DELIVER and recovers through an independent store', async () => {
  const { root, store, lifecycle, approval } = await setup()
  await expect(lifecycle.finish(record)).rejects.toThrow('not active')
  await lifecycle.begin()
  expect((await store.load())?.phase).toBe('VERIFY')
  await lifecycle.finish(record)
  expect(await new FileStateStore(root).load()).toMatchObject({ phase: 'DELIVER', finalVerification: record })
  await expect(lifecycle.begin()).rejects.toThrow('BUILD or VERIFY')
  await lifecycle.invalidate()
  expect(await store.load()).toMatchObject({ phase: 'VERIFY' })
  expect((await store.load())?.finalVerification).toBeUndefined()
  expect(approval).toHaveBeenCalled()
})
it('retains VERIFY for incomplete evidence and clears old evidence before a retry', async () => {
  const { store, lifecycle } = await setup()
  await lifecycle.begin()
  await lifecycle.finish({ ...record, delivery: { ...record.delivery, status: 'needs-attention', unresolvedItems: ['pending'] } })
  expect((await store.load())?.phase).toBe('VERIFY')
  await lifecycle.begin()
  expect((await store.load())?.finalVerification).toBeUndefined()
  await expect(lifecycle.finish({ ...record, delivery: { ...record.delivery, unresolvedItems: ['pending'] } })).rejects.toThrow()
  expect((await store.load())?.phase).toBe('VERIFY')
})
it('does not deliver after approval revocation', async () => {
  const { store, lifecycle, approval } = await setup()
  await lifecycle.begin()
  approval.mockRejectedValueOnce(new Error('approval stale'))
  await expect(lifecycle.finish(record)).rejects.toThrow('approval stale')
  expect((await store.load())?.phase).toBe('VERIFY')
})
