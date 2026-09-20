import { describe, expect, it } from 'vitest'
import { ControlMediatedApprovalPort, MemoryPersistedEventStore, PersistedEventPort, createProductionOrchestrationPort } from '../src/index.js'
import { AgentResultSchema, type AgentHandle, type AgentResult, type AgentTask, type BackendTeamEvent } from '@dsh-backend-team/contracts'
import type { PersistedEventStore } from '../src/index.js'

describe('production orchestration boundary', () => {
  it('rejects a mock production implementation', () => { expect(() => createProductionOrchestrationPort({ orchestration: { constructor: { name: 'MockBackendTeamOrchestrationPort' } } })).toThrow(/cannot use mocks/i) })
  it('persists events before notifying subscribers', async () => {
    const store = new MemoryPersistedEventStore(); const events = new PersistedEventPort('/workspace', store); let persisted = false; events.subscribe(async () => { persisted = (await store.read('/workspace')).length === 1 })
    await events.emit({ id: 'event-1', sequence: 1, occurredAt: '2026-08-28T00:00:00.000Z', type: 'phase-changed', revision: 1, phase: 'SPECIFY' }); expect(persisted).toBe(true)
  })
  it('requires verified agent provenance', () => { expect(() => createProductionOrchestrationPort({ workspaceId: '/workspace', events: new PersistedEventPort('/workspace', new MemoryPersistedEventStore()), approvals: new ControlMediatedApprovalPort('/workspace'), agents: { verifiedProvenance: false as true, spawnAgent: async () => ({}) as AgentHandle } })).toThrow(/verified Agent provenance/i) })

  it('forwards the caller state revision into pending approval records', async () => {
    const approvals = new ControlMediatedApprovalPort('/workspace')
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace',
      events: new PersistedEventPort('/workspace', new MemoryPersistedEventStore()),
      approvals,
      agents: { verifiedProvenance: true as const, spawnAgent: async () => ({}) as AgentHandle },
    })
    const decision = port.requestApproval({ kind: 'requirements', summary: 'review', artifactHashes: { 'spec.md': 'a'.repeat(64) } }, { stateRevision: 9 })
    await Promise.resolve()
    const pending = approvals.listPending()[0]
    expect(pending).toMatchObject({ stateRevision: 9, artifactHash: 'a'.repeat(64) })
    approvals.decide(pending!.id, { effect: 'approve', reason: 'approved' }, 'a'.repeat(64), 9)
    await expect(decision).resolves.toEqual({ effect: 'approve', reason: 'approved' })
  })

  it('persists a completed Agent run before returning its result', async () => {
    const store = new MemoryPersistedEventStore()
    const events = new PersistedEventPort('/workspace', store)
    const result = agentResult('task-1')
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace',
      events,
      approvals: new ControlMediatedApprovalPort('/workspace'),
      agents: {
        verifiedProvenance: true as const,
        spawnAgent: async () => ({ id: 'agent-1', result: async () => result, cancel: async () => {} }),
      },
    })

    const handle = await port.spawnAgent({ task: 'implement', role: 'developer', context: {} })
    await expect(events.read()).resolves.toContainEqual(expect.objectContaining({
      type: 'run-recorded',
      run: expect.objectContaining({ id: 'agent-agent-1', status: 'running', completedAt: null }),
    }))
    await expect(handle.result()).resolves.toEqual(result)
    await expect(events.read()).resolves.toContainEqual(expect.objectContaining({
      type: 'run-recorded',
      run: expect.objectContaining({ id: 'agent-agent-1', status: 'passed', consumedBudget: result.consumedBudget }),
    }))
  })

  it('records an over-budget Agent result as blocked before the scheduler rejects it', async () => {
    const store = new MemoryPersistedEventStore()
    const events = new PersistedEventPort('/workspace', store)
    const result = AgentResultSchema.parse({ ...agentResult('task-over-budget'), consumedBudget: { tokens: 11, wallMs: 4, toolCalls: 1, retries: 0, children: 0 } })
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace',
      events,
      approvals: new ControlMediatedApprovalPort('/workspace'),
      agents: {
        verifiedProvenance: true as const,
        spawnAgent: async () => ({ id: 'agent-over-budget', result: async () => result, cancel: async () => {} }),
      },
    })

    const handle = await port.spawnAgent({ task: 'implement', role: 'developer', context: {}, agentTask: { budget: { maxTokens: 10, maxWallMs: 10, maxToolCalls: 10, maxRetries: 0, maxChildren: 0 } } as AgentTask })
    await expect(handle.result()).resolves.toEqual(result)
    await expect(events.read()).resolves.toContainEqual(expect.objectContaining({
      type: 'run-recorded',
      run: expect.objectContaining({ id: 'agent-agent-over-budget', status: 'blocked', summary: expect.stringContaining('tokens used 11 > limit 10'), consumedBudget: result.consumedBudget }),
    }))
  })

  it('persists an interrupted Agent run after cancellation', async () => {
    const events = new PersistedEventPort('/workspace', new MemoryPersistedEventStore())
    let cancelled = false
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace',
      events,
      approvals: new ControlMediatedApprovalPort('/workspace'),
      agents: {
        verifiedProvenance: true as const,
        spawnAgent: async () => ({ id: 'agent-2', result: async () => undefined, cancel: async () => { cancelled = true } }),
      },
    })

    const handle = await port.spawnAgent({ task: 'implement', role: 'developer', context: {} })
    await handle.cancel()
    expect(cancelled).toBe(true)
    await expect(events.read()).resolves.toContainEqual(expect.objectContaining({
      type: 'run-recorded',
      run: expect.objectContaining({ id: 'agent-agent-2', status: 'interrupted', summary: 'Agent cancelled' }),
    }))
  })

  it('keeps a cancellation race interrupted when the Agent result has no text', async () => {
    const events = new PersistedEventPort('/workspace', new MemoryPersistedEventStore())
    let rejectResult: ((reason: unknown) => void) | undefined
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace',
      events,
      approvals: new ControlMediatedApprovalPort('/workspace'),
      agents: {
        verifiedProvenance: true as const,
        spawnAgent: async () => ({
          id: 'agent-cancel-race',
          result: async () => new Promise<never>((_resolve, reject) => { rejectResult = reject }),
          cancel: async () => { rejectResult?.(new Error('assistant result has no text content')) },
        }),
      },
    })

    const handle = await port.spawnAgent({ task: 'implement', role: 'developer', context: {} })
    const result = handle.result()
    await handle.cancel()
    await expect(result).rejects.toThrow(/no text content/i)
    await expect(events.read()).resolves.toContainEqual(expect.objectContaining({
      type: 'run-recorded',
      run: expect.objectContaining({ id: 'agent-agent-cancel-race', status: 'interrupted', summary: 'Agent cancelled' }),
    }))
  })

  it('persists a wall-clock exhaustion as blocked with the consumed budget', async () => {
    const events = new PersistedEventPort('/workspace', new MemoryPersistedEventStore())
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace', events, approvals: new ControlMediatedApprovalPort('/workspace'),
      agents: {
        verifiedProvenance: true as const,
        spawnAgent: async () => ({ id: 'agent-wall-timeout', result: async () => { throw new Error('managed Agent wall-time budget exhausted') }, cancel: async () => {} }),
      },
    })

    const handle = await port.spawnAgent({ task: 'implement', role: 'developer', context: {}, agentTask: { budget: { maxTokens: 100, maxWallMs: 25, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 } } as AgentTask })
    await expect(handle.result()).rejects.toThrow(/wall-time budget exhausted/i)
    await expect(events.read()).resolves.toContainEqual(expect.objectContaining({
      type: 'run-recorded',
      run: expect.objectContaining({ id: 'agent-agent-wall-timeout', status: 'blocked', summary: 'Agent wall-clock budget exhausted', consumedBudget: { tokens: 0, wallMs: 25, toolCalls: 0, retries: 0, children: 0 } }),
    }))
  })

  it('cancels a newly spawned Agent when its start event cannot be persisted', async () => {
    let cancelled = false
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace',
      events: new PersistedEventPort('/workspace', new FailingEventStore()),
      approvals: new ControlMediatedApprovalPort('/workspace'),
      agents: {
        verifiedProvenance: true as const,
        spawnAgent: async () => ({ id: 'agent-3', result: async () => undefined, cancel: async () => { cancelled = true } }),
      },
    })

    await expect(port.spawnAgent({ task: 'implement', role: 'developer', context: {} })).rejects.toThrow(/persist/i)
    expect(cancelled).toBe(true)
  })

  it('coalesces concurrent result reads into one underlying Agent read', async () => {
    let reads = 0
    const result = agentResult('task-4')
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace',
      events: new PersistedEventPort('/workspace', new MemoryPersistedEventStore()),
      approvals: new ControlMediatedApprovalPort('/workspace'),
      agents: {
        verifiedProvenance: true as const,
        spawnAgent: async () => ({ id: 'agent-4', result: async () => { reads += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return result }, cancel: async () => {} }),
      },
    })

    const handle = await port.spawnAgent({ task: 'implement', role: 'developer', context: {} })
    await expect(Promise.all([handle.result(), handle.result()])).resolves.toEqual([result, result])
    expect(reads).toBe(1)
  })

  it('coalesces concurrent cancellation into one underlying Agent cancel', async () => {
    let cancels = 0
    const events = new PersistedEventPort('/workspace', new MemoryPersistedEventStore())
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace',
      events,
      approvals: new ControlMediatedApprovalPort('/workspace'),
      agents: {
        verifiedProvenance: true as const,
        spawnAgent: async () => ({ id: 'agent-5', result: async () => undefined, cancel: async () => { cancels += 1; await new Promise((resolve) => setTimeout(resolve, 5)) } }),
      },
    })

    const handle = await port.spawnAgent({ task: 'implement', role: 'developer', context: {} })
    await Promise.all([handle.cancel(), handle.cancel()])
    expect(cancels).toBe(1)
    const terminal = (await events.read()).filter((event) => event.type === 'run-recorded' && event.run.completedAt !== null)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ run: { status: 'interrupted' } })
  })

  it('does not cancel an Agent after its terminal result has been persisted', async () => {
    let cancels = 0
    const result = agentResult('task-6')
    const port = createProductionOrchestrationPort({
      workspaceId: '/workspace',
      events: new PersistedEventPort('/workspace', new MemoryPersistedEventStore()),
      approvals: new ControlMediatedApprovalPort('/workspace'),
      agents: {
        verifiedProvenance: true as const,
        spawnAgent: async () => ({ id: 'agent-6', result: async () => result, cancel: async () => { cancels += 1 } }),
      },
    })

    const handle = await port.spawnAgent({ task: 'implement', role: 'developer', context: {} })
    await handle.result()
    await handle.cancel()
    expect(cancels).toBe(0)
  })

  it('rejects duplicate pending approval ids without orphaning the first request', async () => {
    const approvals = new ControlMediatedApprovalPort('/workspace')
    const request = { kind: 'requirements' as const, summary: 'review', artifactHashes: { 'spec.md': 'a'.repeat(64) } }
    const first = approvals.requestApproval(request, { workspaceId: '/workspace', stateRevision: 1, approvalId: 'approval-fixed' })
    expect(() => approvals.requestApproval(request, { workspaceId: '/workspace', stateRevision: 1, approvalId: 'approval-fixed' })).toThrow(/already pending/i)
    expect(approvals.listPending()).toHaveLength(1)
    approvals.decide('approval-fixed', { effect: 'approve', reason: 'approved' }, 'a'.repeat(64), 1)
    await expect(first).resolves.toMatchObject({ effect: 'approve' })
  })

  it('rejects pending approvals when the host composition is disposed', async () => {
    const approvals = new ControlMediatedApprovalPort('/workspace')
    const pending = approvals.requestApproval({ kind: 'design', summary: 'review', artifactHashes: { 'architecture.md': 'b'.repeat(64) } }, { workspaceId: '/workspace', stateRevision: 2 })
    approvals.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'ApprovalPortClosedError' })
    expect(approvals.listPending()).toEqual([])
    await expect(approvals.requestApproval({ kind: 'design', summary: 'review', artifactHashes: { 'architecture.md': 'b'.repeat(64) } })).rejects.toMatchObject({ name: 'ApprovalPortClosedError' })
    approvals.dispose()
  })
})

function agentResult(taskId: string): AgentResult {
  return AgentResultSchema.parse({
    taskId,
    status: 'passed',
    summary: 'completed',
    changedPaths: [],
    commands: [],
    evidencePaths: [],
    risks: [],
    unresolvedItems: [],
    consumedBudget: { tokens: 3, wallMs: 4, toolCalls: 1, retries: 0, children: 0 },
    childResultIds: [],
    verification: { status: 'passed', verifiedBy: 'agent-1', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'tests', outcome: 'passed', evidencePaths: [] }] },
  })
}

class FailingEventStore implements PersistedEventStore {
  async append(workspaceId: string, event: BackendTeamEvent): Promise<void> { void workspaceId; void event; throw new Error('persist failed') }
  async read(workspaceId: string): Promise<readonly BackendTeamEvent[]> { void workspaceId; return [] }
}
