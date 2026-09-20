import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FileStateStore } from '../src/state-store.js'
import { RequirementChangeService } from '../src/requirement-change.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'requirement-change-'))); roots.push(root)
  const store = new FileStateStore(root)
  const approvals = ['requirements', 'design'].map(kind => ({ kind: kind as 'requirements' | 'design', artifactHashes: { spec: 'a'.repeat(64) }, approvedAt: new Date().toISOString(), tokenId: 'approved-token-123456' }))
  await store.create({ schemaVersion: 1, revision: 0, workspaceRoot: root, phase: 'BUILD', runs: [], approvals, approvalTokens: [] })
  const options = {
    stateStore: store, stopDevelopment: vi.fn(async () => {}), assertIdle: vi.fn(),
    snapshotDocuments: vi.fn(async () => [{ path: 'spec.md', content: 'old requirements' }]),
    prepareExecutionBaseline: vi.fn(async () => {}),
    archiveCheckpoint: vi.fn(async (id: string) => { void id }), publishApproval: vi.fn(async () => {}),
    generateRequirements: vi.fn(async (text: string) => {
      void text
      const state = (await store.load())!
      expect(state.approvals).toEqual([])
      await store.transact(state.revision, current => ({ ...current, phase: 'AWAIT_REQUIREMENTS_APPROVAL' }))
    }),
  }
  return { store, options, service: new RequirementChangeService(options) }
}
it('preserves evidence and reopens both gates before generating changed requirements', async () => {
  const f = await fixture()
  await f.service.request('增加客户跟进', 0, 'session-human-123456')
  expect(await f.store.load()).toMatchObject({ phase: 'AWAIT_REQUIREMENTS_APPROVAL', approvals: [], runs: [], requirementChanges: [{ text: '增加客户跟进', status: 'awaiting-review', previousDocuments: [{ content: 'old requirements' }], previousApprovals: [{ kind: 'requirements' }, { kind: 'design' }] }] })
  expect(f.options.publishApproval).toHaveBeenCalledOnce()
  expect(f.options.generateRequirements).toHaveBeenCalledWith(expect.stringContaining('增加客户跟进'))
})
it('does not rewrite state if stopping writers fails or revision changes while stopping', async () => {
  const f = await fixture()
  f.options.stopDevelopment.mockRejectedValueOnce(new Error('writer busy'))
  await expect(f.service.request('change', 0, 'session-human-123456')).rejects.toThrow('writer busy')
  expect((await f.store.load())?.phase).toBe('BUILD')
  f.options.stopDevelopment.mockImplementationOnce(async () => { await f.store.transact(0, state => ({ ...state })) })
  await expect(f.service.request('change', 0, 'session-human-123456')).rejects.toThrow()
  expect((await f.store.load())?.approvals).toHaveLength(2)
  expect(f.options.generateRequirements).not.toHaveBeenCalled()
})
it('recovers durable change after archiving fails, including across service recreation', async () => {
  const f = await fixture()
  f.options.archiveCheckpoint.mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(f.service.request('change', 0, 'session-human-123456')).rejects.toThrow('disk unavailable')
  expect(await f.store.load()).toMatchObject({ phase: 'SPECIFY', approvals: [], requirementChanges: [{ status: 'preparing' }] })
  await new RequirementChangeService(f.options).recover()
  expect((await f.store.load())?.phase).toBe('AWAIT_REQUIREMENTS_APPROVAL')
  expect(f.options.archiveCheckpoint.mock.calls[0]?.[0]).toBe(f.options.archiveCheckpoint.mock.calls[1]?.[0])
  expect(f.options.generateRequirements).toHaveBeenCalledOnce()
})
it('recovers after generated documents were persisted without generating them twice', async () => {
  const f = await fixture()
  f.options.generateRequirements.mockImplementationOnce(async () => {
    const state = (await f.store.load())!
    await f.store.transact(state.revision, current => ({ ...current, phase: 'AWAIT_REQUIREMENTS_APPROVAL' }))
    throw new Error('interrupted after persistence')
  })
  await expect(f.service.request('change', 0, 'session-human-123456')).rejects.toThrow('interrupted')
  await new RequirementChangeService(f.options).recover()
  expect(f.options.generateRequirements).toHaveBeenCalledOnce()
  expect(f.options.publishApproval).toHaveBeenCalledOnce()
})
