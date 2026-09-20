import type { ApprovalRequest } from '@dsh-backend-team/contracts'
import { describe, expect, it } from 'vitest'
import { ControlMediatedApprovalPort } from '../src/control-mediated-approval-port.js'

const request: ApprovalRequest = { kind: 'requirements', summary: 'review', artifactHashes: { 'spec.md': 'a'.repeat(64) } }

describe('ControlMediatedApprovalPort settlement lifecycle', () => {
  it('notifies live observers without letting them interrupt approval settlement', async () => {
    const approvals = new ControlMediatedApprovalPort('/workspace')
    const snapshots: number[] = []
    const remove = approvals.subscribe(() => { snapshots.push(approvals.listPending().length) })
    approvals.subscribe(() => { throw new Error('broken observer') })
    const decision = approvals.requestApproval(request)
    await Promise.resolve()
    expect(snapshots).toEqual([1])
    approvals.decide('approval-1', { effect: 'approve', reason: 'approved' }, 'a'.repeat(64), 0)
    await decision
    expect(snapshots).toEqual([1, 0])
    remove()
    await approvals.closeAndDrain()
  })

  it('keeps an explicit approval id reserved until its settlement completes', async () => {
    const approvals = new ControlMediatedApprovalPort('/workspace')
    const first = approvals.requestApproval(request, { workspaceId: '/workspace', stateRevision: 3, approvalId: 'approval-fixed' })
    const settlement = approvals.waitForSettlement(request, 3)
    approvals.decide('approval-fixed', { effect: 'approve', reason: 'approved' }, 'a'.repeat(64), 3)

    expect(() => approvals.requestApproval(request, { workspaceId: '/workspace', stateRevision: 3, approvalId: 'approval-fixed' })).toThrow(/already pending or settling/i)
    approvals.completeSettlement(request)
    await expect(Promise.all([first, settlement])).resolves.toEqual([{ effect: 'approve', reason: 'approved' }, undefined])
  })

  it('drains decided transactions while rejecting new and undecided approvals', async () => {
    const approvals = new ControlMediatedApprovalPort('/workspace')
    const decided = approvals.requestApproval(request, { workspaceId: '/workspace', stateRevision: 3 })
    const decidedSettlement = approvals.waitForSettlement(request, 3)
    const undecided = approvals.requestApproval({ ...request, summary: 'second' }, { workspaceId: '/workspace', stateRevision: 3 })
    approvals.decide('approval-1', { effect: 'approve', reason: 'approved' }, 'a'.repeat(64), 3)

    const drain = approvals.closeAndDrain()
    await expect(undecided).rejects.toMatchObject({ name: 'ApprovalPortClosedError' })
    await expect(approvals.requestApproval(request)).rejects.toMatchObject({ name: 'ApprovalPortClosedError' })
    let drained = false
    void drain.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)

    approvals.completeSettlement(request)
    await expect(drain).resolves.toBeUndefined()
    await expect(decided).resolves.toMatchObject({ effect: 'approve' })
    await expect(decidedSettlement).resolves.toBeUndefined()
  })
})
