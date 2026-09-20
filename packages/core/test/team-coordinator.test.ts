import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentTaskSchema } from '@dsh-backend-team/contracts'
import type { AgentHandle, AgentResult, AgentSpawnRequest, BackendTeamOrchestrationPort, BackendTeamState, PolicyDecision, PolicyEngine, StateStore, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { BudgetLedger, HandoffStore, OwnershipManager, TaskScheduler } from '@dsh-backend-team/agent-team'
import { ApplicationActionCatalog, type ApplicationWorkflowPort } from '../src/application-action-catalog.js'
import { TeamCoordinator, type ExpertDispatchInput } from '../src/team-coordinator.js'

const hash = 'a'.repeat(64)
const budget = { maxTokens: 100, maxWallMs: 1000, maxToolCalls: 10, maxRetries: 1, maxChildren: 3 }
const expert = (id: string): ExpertDispatchInput => ({ id, role: 'developer', objective: `Implement ${id}.`, nonGoals: ['Do not change unrelated code.'], inputArtifacts: [{ path: 'specs/feature.md', sha256: hash }], readPaths: ['src'], writePaths: [`src/${id}`], capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, canDelegate: true }, budget, doneWhen: ['Focused tests pass.'], verification: [{ id: 'tests', kind: 'test', instruction: 'Run focused tests.', required: true }], returnSchema: 'handoff-v1' })

describe('TeamCoordinator', () => {
  it('accepts a verified expert result only after durable handoff persistence', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'team-coordinator-'))
    const state = fixtureState()
    const store = memoryStore(state)
    const port = new ScriptedPort()
    const scheduler = new TaskScheduler({ orchestration: port, ledger: new BudgetLedger() })
    const coordinator = makeCoordinator(root, store, scheduler)

    const handoff = await coordinator.dispatchExpert(expert('users'))
    expect(handoff.parentVerification.status).toBe('accepted')
    expect(coordinator.unacknowledgedHandoffs()).toEqual([])
    expect((await store.load())?.runs).toHaveLength(1)
    expect(port.requests[0]?.context).toMatchObject({ taskId: 'users' })
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps coordinator authority: catalog exposes status only and phase cannot be changed by an agent', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'team-coordinator-'))
    const store = memoryStore(fixtureState())
    const coordinator = makeCoordinator(root, store, new TaskScheduler({ orchestration: new ScriptedPort(), ledger: new BudgetLedger() }))
    const catalog = new ApplicationActionCatalog(coordinator)
    expect(catalog.list().map((tool) => tool.name)).toEqual(['backend_team_status'])
    expect(coordinator).not.toHaveProperty('changePhase')
    expect(await catalog.get('backend_team_status')?.execute({})).toMatchObject({ phase: 'BUILD' })
    rmSync(root, { recursive: true, force: true })
  })

  it('adds user workflow actions only when an explicit workflow port is supplied', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'team-coordinator-workflow-'))
    const store = memoryStore(fixtureState())
    const coordinator = makeCoordinator(root, store, new TaskScheduler({ orchestration: new ScriptedPort(), ledger: new BudgetLedger() }))
    const calls: string[] = []
    const workflow: ApplicationWorkflowPort = {
      start: async (objective) => { calls.push(`start:${objective}`); return { phase: 'SPECIFY' } },
      refine: async (input) => { calls.push(`refine:${input}`); return { phase: 'SPECIFY' } },
      approve: async (gate) => { calls.push(`approve:${gate}`); return { phase: gate === 'requirements' ? 'DESIGN' : 'PLAN' } },
      status: async () => ({ phase: 'SPECIFY' }),
      resume: async () => { calls.push('resume'); return { phase: 'BUILD' } },
    }
    const catalog = new ApplicationActionCatalog(coordinator, workflow)

    expect(catalog.list().map((tool) => tool.name)).toEqual(['backend_team_start', 'backend_team_refine', 'backend_team_approve', 'backend_team_status', 'backend_team_resume'])
    await catalog.get('backend_team_start')!.execute({ objective: '订单接口' })
    await catalog.get('backend_team_refine')!.execute({ text: '增加分页规则' })
    await catalog.get('backend_team_approve')!.execute({ gate: 'requirements' })
    await catalog.get('backend_team_resume')!.execute()
    expect(calls).toEqual(['start:订单接口', 'refine:增加分页规则', 'approve:requirements', 'resume'])
    await expect(catalog.get('backend_team_status')!.execute({})).resolves.toEqual({ phase: 'SPECIFY' })
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects forged tasks and stale input hashes at the coordinator boundary', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'team-coordinator-'))
    const coordinator = makeCoordinator(root, memoryStore(fixtureState()), new TaskScheduler({ orchestration: new ScriptedPort(), ledger: new BudgetLedger() }), { 'specs/feature.md': 'b'.repeat(64) })
    const unregistered = AgentTaskSchema.parse({ ...expert('forged'), id: 'forged', parentTaskId: 'coordinator', depth: 1 })
    const result: AgentResult = new ScriptedPort().resultFor('forged')
    await expect(coordinator.acceptExpertResult(unregistered, result)).rejects.toThrow(/dispatched/i)
    await expect(coordinator.dispatchExpert(expert('stale'))).rejects.toThrow(/stale input/i)
    rmSync(root, { recursive: true, force: true })
  })

  it('redacts credential-like task text before it crosses the orchestration port', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'team-coordinator-'))
    const store = memoryStore(fixtureState())
    const port = new ScriptedPort()
    const coordinator = makeCoordinator(root, store, new TaskScheduler({ orchestration: port, ledger: new BudgetLedger() }))

    await coordinator.dispatchExpert({
      ...expert('secure-boundary'),
      objective: 'Connect with password=super-secret and database_url=postgres://user:pw@example.test/db.',
      nonGoals: ['Do not expose token=another-secret in logs.'],
      doneWhen: ['Use authorization:Bearer-very-secret only through the approved adapter.'],
      returnSchema: 'handoff-v1; private_key=private-material',
      verification: [{ id: 'tests', kind: 'test', instruction: 'Run tests with api_key=third-secret.', required: true }],
    })

    const request = port.requests[0]
    expect(request?.agentTask).toBeDefined()
    const serialized = JSON.stringify(request?.agentTask)
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('another-secret')
    expect(serialized).not.toContain('private-material')
    expect(serialized).not.toContain('third-secret')
    expect(serialized).not.toMatch(/password|database_url|authorization|api_key|private_key/iu)
    rmSync(root, { recursive: true, force: true })
  })

  it('persists a scheduler budget failure so a restarted host can explain and recover it', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'team-coordinator-budget-'))
    const store = memoryStore(fixtureState())
    const scheduler = new TaskScheduler({ orchestration: new OverBudgetPort(), ledger: new BudgetLedger() })
    const coordinator = makeCoordinator(root, store, scheduler)

    await expect(coordinator.dispatchExpert(expert('over-budget'))).rejects.toThrow(/task budget exhausted/i)
    const saved = await store.load()
    expect(saved?.workflowError).toMatch(/task budget exhausted/i)
    expect(saved?.runs).toHaveLength(1)
    expect(saved?.runs[0]).toMatchObject({ id: 'agent-over-budget', status: 'blocked', consumedBudget: { tokens: 101 } })
    rmSync(root, { recursive: true, force: true })
  })

  it('denies expert paths through the policy engine before creating leases or spawning', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'team-coordinator-'))
    const store = memoryStore(fixtureState())
    const port = new ScriptedPort()
    const denyWrites: PolicyEngine = { authorize: async (action): Promise<PolicyDecision> => ({ effect: action.kind === 'write' ? 'deny' : 'allow', reason: 'writes are denied in this fixture', ruleId: 'deny-writes' }) }
    const coordinator = makeCoordinator(root, store, new TaskScheduler({ orchestration: port, ledger: new BudgetLedger() }), undefined, denyWrites)

    await expect(coordinator.dispatchExpert(expert('policy-denied'))).rejects.toThrow(/policy denied expert write/i)
    expect(port.requests).toHaveLength(0)
    await expect(coordinator.status()).resolves.toMatchObject({ activeExperts: 0, activeWriters: 0, queued: 0 })
    rmSync(root, { recursive: true, force: true })
  })
})

class ScriptedPort implements BackendTeamOrchestrationPort {
  readonly requests: AgentSpawnRequest[] = []
  async requestApproval(): Promise<never> { throw new Error('not exposed') }
  async emit(): Promise<void> {}
  async spawnAgent(request: AgentSpawnRequest): Promise<AgentHandle> {
    this.requests.push(request)
    const taskId = request.agentTask?.id ?? request.task
    const result = this.resultFor(taskId)
    return { id: `agent-${taskId}`, result: async () => result, cancel: async () => {} }
  }

  resultFor(taskId: string): AgentResult { return { taskId, status: 'passed', summary: 'done', changedPaths: [], commands: [{ argv: ['npm', 'test'], exitCode: 0 }], evidencePaths: [], risks: [], unresolvedItems: [], consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 1, retries: 0, children: 0 }, childResultIds: [], verification: { status: 'passed', verifiedBy: 'expert', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'tests', outcome: 'passed', evidencePaths: [] }] } } }
}

class OverBudgetPort extends ScriptedPort {
  override resultFor(taskId: string): AgentResult {
    return { ...super.resultFor(taskId), consumedBudget: { tokens: 101, wallMs: 1, toolCalls: 1, retries: 0, children: 0 } }
  }
}

function fixtureState(): BackendTeamState { return { schemaVersion: 1, revision: 0, workspaceRoot: '/workspace', phase: 'BUILD', runs: [], approvals: [{ kind: 'design', artifactHashes: { 'specs/feature.md': hash }, approvedAt: '2026-01-01T00:00:00.000Z', tokenId: 'design-approval-token' }], approvalTokens: [] } }

function makeCoordinator(root: string, stateStore: StateStore, scheduler: TaskScheduler, currentArtifactHashes: Readonly<Record<string, string>> = { 'specs/feature.md': hash }, policyEngine: PolicyEngine = { authorize: async (): Promise<PolicyDecision> => ({ effect: 'allow', reason: 'test allow', ruleId: 'test-allow' }) }): TeamCoordinator {
  const workspace: WorkspaceLayout = { root, teamDir: `${root}/.backend-team`, stateDir: `${root}/.backend-team/state`, runtimeDir: `${root}/.backend-team/runtime`, cacheDir: `${root}/.backend-team/cache`, logsDir: `${root}/.backend-team/logs`, locksDir: `${root}/.backend-team/locks`, handoffDir: `${root}/.backend-team/handoff` }
  return new TeamCoordinator({ stateStore, scheduler, handoffStore: new HandoffStore(root), currentArtifactHashes, workspace, policyEngine, ownershipManager: new OwnershipManager({ workspaceRoot: root, recoveryToken: 'test-recovery-token-123' }) })
}
function memoryStore(initial: BackendTeamState): StateStore {
  let value = initial
  return { load: async () => value, create: async (next) => { value = next }, transact: async (expected, change) => { if (value.revision !== expected) throw new Error('revision conflict'); value = { ...change(value), revision: value.revision + 1 }; return value } }
}
