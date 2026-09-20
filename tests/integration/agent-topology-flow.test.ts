import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentDelegation, AgentResult, AgentTask, BackendTeamState, PolicyDecision, PolicyEngine, StateStore, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { AgentTaskSchema, AgentResultSchema } from '@dsh-backend-team/contracts'
import { BudgetLedger, HandoffStore, OwnershipManager, TaskScheduler, type RuntimeExpertInput } from '@dsh-backend-team/agent-team'
import { TeamRuntime } from '../../packages/agent-team/src/team-runtime.js'
import { MockBackendTeamOrchestrationPort } from '@dsh-backend-team/harness-adapter'
import { TeamCoordinator } from '../../packages/core/src/team-coordinator.js'

const hash = 'a'.repeat(64)
const budget = { maxTokens: 100, maxWallMs: 1000, maxToolCalls: 10, maxRetries: 1, maxChildren: 3 }

describe('Stage 04 agent topology', () => {
  it('bounds depth, concurrency, authority, and durable acknowledgements', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'agent-topology-'))
    const state = memoryState()
    const scripts = Array.from({ length: 3 }, (_, index) => ({ result: result(`expert-${index}`) }))
    const port = new MockBackendTeamOrchestrationPort({ agents: scripts })
    const coordinator = makeCoordinator(root, state, new TaskScheduler({ orchestration: port, ledger: new BudgetLedger() }))
    const runtime = new TeamRuntime({ coordinator })
    const handoffs = await runtime.runExperts(Array.from({ length: 3 }, (_, index) => task(`expert-${index}`)))
    expect(handoffs).toHaveLength(3)
    expect(handoffs.every((handoff) => handoff.parentVerification.status === 'accepted')).toBe(true)
    expect(handoffs.every((handoff) => handoff.taskId.startsWith('expert-'))).toBe(true)
    expect(port.snapshot().spawnRequests).toHaveLength(3)
    expect(runtime.coordinator.unacknowledgedHandoffs()).toEqual([])
    const workerParent = AgentTaskSchema.parse({ ...task('worker-parent'), parentTaskId: 'expert-0', depth: 2, role: 'worker', capabilities: { readProjectFiles: true } })
    await expect(runtime.dispatchWorker(workerParent, task('grandchild'))).rejects.toThrow(/active expert callback|parent.*expert|depth/i)
    rmSync(root, { recursive: true, force: true })
  })

  it('allows a dispatched expert to create one bounded depth-two worker', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'agent-topology-worker-'))
    const state = memoryState()
    let workerHandoff: unknown
    const port = new MockBackendTeamOrchestrationPort({ agents: [
      {
        result: result('expert-0', ['handoff-worker-0']),
        onRun: async (request) => {
          if (request.delegation === undefined) throw new Error('expert delegation callback is missing')
          workerHandoff = await request.delegation.delegateWorker({ ...task('worker-0'), readPaths: ['src/expert-0'], writePaths: ['src/expert-0/worker-0'], budget: { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } })
        },
      },
      { result: result('worker-0') },
    ] })
    const coordinator = makeCoordinator(root, state, new TaskScheduler({ orchestration: port, ledger: new BudgetLedger() }))
    const runtime = new TeamRuntime({ coordinator })
    await runtime.runExperts([task('expert-0')])
    expect(workerHandoff).toMatchObject({ taskId: 'worker-0', parentTaskId: 'expert-0', parentVerification: { status: 'accepted', verifiedBy: 'expert-0' } })
    expect(port.snapshot().spawnRequests).toHaveLength(2)
    expect(port.snapshot().spawnRequests.at(-1)?.delegation).toBeUndefined()
    expect(port.snapshot().spawnRequests.at(-1)?.context).toMatchObject({ taskId: 'worker-0', inputArtifacts: [{ path: 'specs/feature.md', sha256: hash }] })
    expect(port.snapshot().spawnRequests.at(-1)?.agentTask?.capabilities).toMatchObject({ canDelegate: false, canChangePhase: false, canApprove: false, canContactUser: false, canAnnounceCompletion: false, commandExecution: false })
    expect(coordinator.unacknowledgedHandoffs()).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('delivers a narrow delegation callback while the expert spawn is active', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'agent-topology-live-worker-'))
    const state = memoryState()
    let callbackSeen = false
    let workerHandoff: unknown
    let retainedDelegation!: AgentDelegation
    const port = new MockBackendTeamOrchestrationPort({ agents: [
      {
        result: result('expert-live', ['handoff-worker-live']),
        onRun: async (request) => {
          callbackSeen = typeof request.delegation?.delegateWorker === 'function'
          if (request.delegation === undefined) throw new Error('expert delegation callback is missing')
          retainedDelegation = request.delegation
          workerHandoff = await request.delegation.delegateWorker({ ...task('worker-live'), readPaths: ['src/expert-live'], writePaths: ['src/expert-live/worker-live'], budget: { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } })
        },
      },
      { result: result('worker-live') },
    ] })
    const coordinator = makeCoordinator(root, state, new TaskScheduler({ orchestration: port, ledger: new BudgetLedger() }))
    const runtime = new TeamRuntime({ coordinator })
    const [expertHandoff] = await runtime.runExperts([task('expert-live')])

    expect(callbackSeen).toBe(true)
    expect(workerHandoff).toMatchObject({ taskId: 'worker-live', parentTaskId: 'expert-live', parentVerification: { status: 'accepted' } })
    expect(expertHandoff).toMatchObject({ taskId: 'expert-live', parentVerification: { status: 'accepted' } })
    expect(port.snapshot().spawnRequests[0]?.delegation).toBeUndefined()
    expect(port.snapshot().spawnRequests[1]?.delegation).toBeUndefined()
    expect(coordinator.unacknowledgedHandoffs()).toEqual([])
    await expect(retainedDelegation.delegateWorker(task('worker-after'))).rejects.toThrow(/delegation window is closed/i)
    rmSync(root, { recursive: true, force: true })
  })
})

function task(id: string): RuntimeExpertInput & AgentTask { return AgentTaskSchema.parse({ id, parentTaskId: 'coordinator', depth: 1, role: 'developer', objective: `Implement ${id}.`, nonGoals: ['Keep scope bounded.'], inputArtifacts: [{ path: 'specs/feature.md', sha256: hash }], readPaths: [`src/${id}`], writePaths: [`src/${id}`], capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, canDelegate: true }, budget, doneWhen: ['Tests pass.'], verification: [{ id: 'tests', kind: 'test', instruction: 'Run tests.', required: true }], returnSchema: 'handoff-v1' }) }
function result(taskId: string, childResultIds: readonly string[] = []): AgentResult { return AgentResultSchema.parse({ taskId, status: 'passed', summary: 'done', changedPaths: [], commands: [{ argv: ['npm', 'test'], exitCode: 0 }], evidencePaths: [], risks: [], unresolvedItems: [], consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 1, retries: 0, children: 0 }, childResultIds, verification: { status: 'passed', verifiedBy: 'expert', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'tests', outcome: 'passed', evidencePaths: [] }] } }) }
function memoryState(): StateStore { let value: BackendTeamState = { schemaVersion: 1, revision: 0, workspaceRoot: '/workspace', phase: 'BUILD', runs: [], approvals: [{ kind: 'design', artifactHashes: { 'specs/feature.md': hash }, approvedAt: '2026-01-01T00:00:00.000Z', tokenId: 'design-approval-token' }], approvalTokens: [] }; return { load: async () => value, create: async (next) => { value = next }, transact: async (expected, change) => { if (expected !== value.revision) throw new Error('revision conflict'); value = { ...change(value), revision: value.revision + 1 }; return value } } }

function makeCoordinator(root: string, stateStore: StateStore, scheduler: TaskScheduler): TeamCoordinator {
  const workspace: WorkspaceLayout = { root, teamDir: `${root}/.backend-team`, stateDir: `${root}/.backend-team/state`, runtimeDir: `${root}/.backend-team/runtime`, cacheDir: `${root}/.backend-team/cache`, logsDir: `${root}/.backend-team/logs`, locksDir: `${root}/.backend-team/locks`, handoffDir: `${root}/.backend-team/handoff` }
  const policyEngine: PolicyEngine = { authorize: async (): Promise<PolicyDecision> => ({ effect: 'allow', reason: 'test allow', ruleId: 'test-allow' }) }
  return new TeamCoordinator({ stateStore, scheduler, handoffStore: new HandoffStore(root), currentArtifactHashes: { 'specs/feature.md': hash }, workspace, policyEngine, ownershipManager: new OwnershipManager({ workspaceRoot: root, recoveryToken: 'test-recovery-token-123' }) })
}
