import type { AgentHandle, AgentSpawnRequest, BackendTeamOrchestrationPort, BackendTeamState, StateStore } from '@dsh-backend-team/contracts'
import { expect, it } from 'vitest'
import { SpecificationCoordinator } from '../../packages/core/src/specification-coordinator.js'

it('runs the user-facing specification flow through two approval gates before task generation', async () => {
  let state: BackendTeamState = { schemaVersion: 1, revision: 0, workspaceRoot: '/fixture', phase: 'SPECIFY', runs: [], approvals: [], approvalTokens: [] }
  const requests: AgentSpawnRequest[] = []
  const store: StateStore = { load: async () => state, create: async (initial) => { state = initial }, transact: async (_revision, change) => { state = { ...change(state), revision: state.revision + 1 }; return state } }
  const orchestration: BackendTeamOrchestrationPort = { requestApproval: async () => ({ effect: 'approve', reason: 'approved' }), spawnAgent: async (request) => { requests.push(request); return agent(request) }, emit: async () => {} }
  const approvals = { requestRequirementsApproval: async () => { state = { ...state, phase: 'DESIGN', revision: state.revision + 1 }; return state }, requestDesignApproval: async () => { state = { ...state, phase: 'PLAN', revision: state.revision + 1 }; return state }, verifyActiveApproval: async () => {} }
  const coordinator = new SpecificationCoordinator({ workspaceRoot: '/fixture', stateStore: store, commandLoader: { load: async (id) => ({ id, prompt: `official ${id}`, sourceRealPath: `/fixture/${id}.md`, sourceSha256: 'a'.repeat(64) }) }, artifactRegistry: { snapshot: async () => ({ featureDirectory: '/fixture/specs/001-order', artifacts: [{ path: 'spec.md', sha256: 'b'.repeat(64) }, { path: 'clarification.md', sha256: 'c'.repeat(64) }] }) }, artifactValidator: { validateForGate: async () => ({ valid: true, errors: [] }) }, taskPlanLoader: { load: async () => ({ tasks: ['dispatch-fixture'] }) }, approvalService: approvals, orchestration })

  await coordinator.start('Build a tenant-aware order API')
  expect(state.phase).toBe('AWAIT_REQUIREMENTS_APPROVAL')
  await coordinator.approveRequirements()
  await coordinator.design()
  expect(state.phase).toBe('AWAIT_DESIGN_APPROVAL')
  await coordinator.approveDesign()
  await coordinator.generateTasks()
  expect(state.phase).toBe('BUILD')
  expect(requests.map(({ role }) => role)).toEqual(['requirements', 'backend-architect', 'database-designer', 'oss-researcher', 'planner'])
  expect(requests[0]?.agentTask).toMatchObject({
    parentTaskId: 'coordinator-specification',
    depth: 1,
    readPaths: ['specs/001-order/spec.md', 'specs/001-order/clarification.md'],
    writePaths: ['specs/001-order/spec.md', 'specs/001-order/clarification.md'],
  })
  expect(requests[1]?.agentTask).toMatchObject({
    role: 'backend-architect',
    writePaths: ['specs/001-order/plan.md', 'specs/001-order/architecture.md', 'specs/001-order/contracts/openapi.yaml'],
  })
  expect(requests[1]?.context).toMatchObject({
    requiredOutputSchema: ['specs/001-order/plan.md', 'specs/001-order/architecture.md', 'specs/001-order/contracts/openapi.yaml'],
    pathOwnership: ['specs/001-order/plan.md', 'specs/001-order/architecture.md', 'specs/001-order/contracts/openapi.yaml'],
  })
})

function agent(request: AgentSpawnRequest): AgentHandle {
  const taskId = request.agentTask?.id ?? 'missing-task-id'
  return {
    id: `agent-${taskId}`,
    result: async () => ({
      taskId,
      status: 'passed',
      summary: 'verified integration fixture result',
      changedPaths: [],
      commands: [],
      evidencePaths: [],
      risks: [],
      unresolvedItems: [],
      consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 1, retries: 0, children: 0 },
      childResultIds: [],
      verification: {
        status: 'passed',
        verifiedBy: 'integration-fixture',
        verifiedAt: '2026-01-01T00:00:00.000Z',
        records: [{ instructionId: 'artifact-review', outcome: 'passed', evidencePaths: [] }],
      },
    }),
    cancel: async () => {},
  }
}

it('validates actual generated task files before BUILD and allows retry after repair', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm, realpath } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { createHash } = await import('node:crypto')
  const { FileDevelopmentPlanLoader } = await import('../../packages/development/src/file-development-plan-loader.js')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'spec-plan-gate-')))
  const directory = join(root, 'specs', '001-plan')
  try {
    await mkdir(join(directory, 'contracts'), { recursive: true })
    const files: Record<string, string> = { 'spec.md': 'AC-001: return health', 'architecture.md': '# Architecture', 'data-model.md': '# Data', 'contracts/openapi.yaml': 'openapi: 3.1.0', 'test-plan.md': 'AC-001: tests', 'tasks.md': '# Empty plan' }
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content)
    const registry = { snapshot: async () => ({ featureDirectory: directory, artifacts: await Promise.all(Object.keys(files).map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(directory, path))).digest('hex') }))) }) }
    let state: BackendTeamState = { schemaVersion: 1, revision: 0, workspaceRoot: root, phase: 'PLAN', runs: [], approvals: [], approvalTokens: [] }
    const store: StateStore = { load: async () => state, create: async value => { state = value }, transact: async (_revision, change) => { state = { ...change(state), revision: state.revision + 1 }; return state } }
    let generated = '# Empty plan'
    const coordinator = new SpecificationCoordinator({ workspaceRoot: root, stateStore: store, artifactRegistry: registry, taskPlanLoader: new FileDevelopmentPlanLoader(root, registry), artifactValidator: { validateForGate: async () => ({ valid: true }) }, commandLoader: { load: async id => ({ id, prompt: 'fixture task', sourceRealPath: join(root, 'prompt.md'), sourceSha256: 'a'.repeat(64) }) }, approvalService: { verifyActiveApproval: async () => {}, requestRequirementsApproval: async () => {}, requestDesignApproval: async () => {} }, orchestration: { spawnAgent: async request => { await writeFile(join(directory, 'tasks.md'), generated); return agent(request) } } })
    await expect(coordinator.generateTasks()).rejects.toThrow('no executable tasks')
    expect(state.phase).toBe('PLAN')
    generated = '<!-- backend-team:task id=T-1 slice=S-1 requirements=AC-001 owner=developer risk=standard layer=domain files=src/health.ts evidence=tests -->\n- [ ] Implement health response'
    await coordinator.generateTasks()
    expect(state.phase).toBe('BUILD')
  } finally { await rm(root, { recursive: true, force: true }) }
})
