import type { AgentHandle, AgentSpawnRequest, ApprovalDecision, BackendTeamOrchestrationPort, BackendTeamState, StateStore } from '@dsh-backend-team/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { SpecificationCoordinator, type ArtifactRegistryPort, type ArtifactValidatorPort, type SpecKitCommandLoaderPort } from '../src/specification-coordinator.js'

describe('SpecificationCoordinator', () => {
  afterEach(() => {})

  it('starts a fresh workspace from DISCOVER before generating requirements', async () => {
    const fixture = createFixture({ initialPhase: 'DISCOVER' })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await coordinator.start('Build a tenant-aware order API')

    expect(fixture.loader.calls).toEqual(['speckit.specify'])
    expect((await fixture.store.load())?.phase).toBe('AWAIT_REQUIREMENTS_APPROVAL')
  })

  it('reopens the requirements gate for a clarification and does not approve it automatically', async () => {
    const fixture = createFixture()
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await coordinator.start('Build an order API')
    await coordinator.refine('分页默认值为 20，最大值为 100')

    expect(fixture.loader.calls).toEqual(['speckit.specify', 'speckit.clarify'])
    expect(fixture.spawns.map((request) => request.role)).toEqual(['requirements', 'requirements'])
    expect((await fixture.store.load())?.phase).toBe('AWAIT_REQUIREMENTS_APPROVAL')
    expect(fixture.approvals).toEqual([])
  })

  it('requires a non-empty clarification while waiting for requirements approval', async () => {
    const fixture = createFixture()
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await coordinator.start('Build an order API')
    await expect(coordinator.refine('   ')).rejects.toThrow(/clarification/i)
    expect(fixture.loader.calls).toEqual(['speckit.specify'])
    expect((await fixture.store.load())?.phase).toBe('AWAIT_REQUIREMENTS_APPROVAL')
  })

  it('stops after requirements generation, then designs only after requirements approval', async () => {
    const fixture = createFixture()
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await coordinator.start('Build a tenant-aware order API')
    expect(fixture.loader.calls).toEqual(['speckit.specify'])
    expect(fixture.spawns.map((request) => request.role)).toEqual(['requirements'])
    expect((await fixture.store.load())?.phase).toBe('AWAIT_REQUIREMENTS_APPROVAL')
    expect(fixture.spawns[0]?.context).toMatchObject({ pathOwnership: ['specs/001-orders/spec.md', 'specs/001-orders/clarification.md'] })

    await expect(coordinator.generateTasks()).rejects.toThrow(/design approval|phase/i)
    await coordinator.approveRequirements()
    await coordinator.design()
    expect(fixture.loader.calls).toEqual(['speckit.specify', 'speckit.plan'])
    expect(fixture.spawns.map((request) => request.role)).toEqual(['requirements', 'backend-architect', 'database-designer', 'oss-researcher'])
    expect((await fixture.store.load())?.phase).toBe('AWAIT_DESIGN_APPROVAL')
    expect(fixture.spawns[1]?.context).toMatchObject({ budget: { maxAgents: 3 } })
    expect(fixture.spawns[1]?.agentTask).toMatchObject({
      role: 'backend-architect',
      writePaths: ['specs/001-orders/plan.md', 'specs/001-orders/architecture.md', 'specs/001-orders/contracts/openapi.yaml'],
    })
    expect(fixture.spawns[1]?.context).toMatchObject({
      requiredOutputSchema: ['specs/001-orders/plan.md', 'specs/001-orders/architecture.md', 'specs/001-orders/contracts/openapi.yaml'],
      pathOwnership: ['specs/001-orders/plan.md', 'specs/001-orders/architecture.md', 'specs/001-orders/contracts/openapi.yaml'],
    })
    expect(fixture.spawns[2]?.agentTask?.writePaths).toEqual(['specs/001-orders/data-model.md', 'specs/001-orders/test-plan.md'])
    expect(fixture.spawns[3]?.agentTask?.writePaths).toEqual(['specs/001-orders/research.md', 'specs/001-orders/decisions.md'])
    expect(fixture.validator.gates).toEqual(['requirements', 'design'])
  })

  it('does not advance to design approval when design artifacts fail validation', async () => {
    const fixture = createFixture({ designValid: false })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)
    await coordinator.start('Build an order API')
    await coordinator.approveRequirements()
    await expect(coordinator.design()).rejects.toThrow(/design artifacts/i)
    expect((await fixture.store.load())?.phase).toBe('DESIGN')
  })

  it('waits for design approval before generating tasks', async () => {
    const fixture = createFixture()
    const coordinator = new SpecificationCoordinator({ ...fixture.dependencies, taskPlanLoader: { load: async () => ({ tasks: ['unit-fixture'] }) } })
    await coordinator.start('Build an order API')
    await coordinator.approveRequirements()
    await coordinator.design()
    await expect(coordinator.generateTasks()).rejects.toThrow(/design approval|phase/i)
    await coordinator.approveDesign()
    await coordinator.generateTasks()
    expect(fixture.loader.calls).toEqual(['speckit.specify', 'speckit.plan', 'speckit.tasks'])
    expect(fixture.spawns.at(-1)?.role).toBe('planner')
    expect((await fixture.store.load())?.phase).toBe('BUILD')
  })

  it('dispatches a bounded structured task with feature-relative ownership and artifacts', async () => {
    const fixture = createFixture()
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await coordinator.start('Build an order API')

    const request = fixture.spawns[0]!
    expect(request.agentTask).toMatchObject({
      parentTaskId: 'coordinator-specification',
      depth: 1,
      role: 'requirements',
      objective: 'Refine the request into complete requirements and clarification artifacts.',
      inputArtifacts: [
        { path: 'specs/001-orders/spec.md', sha256: 'b'.repeat(64) },
        { path: 'specs/001-orders/clarification.md', sha256: 'c'.repeat(64) },
      ],
      readPaths: ['specs/001-orders/spec.md', 'specs/001-orders/clarification.md'],
      writePaths: ['specs/001-orders/spec.md', 'specs/001-orders/clarification.md'],
      capabilities: {
        readProjectFiles: true,
        writeOwnedFiles: true,
        businessCodeWrite: false,
        testCodeWrite: false,
        configurationWrite: false,
        commandExecution: false,
        networkHosts: [],
        install: false,
        migration: false,
        canDelegate: false,
        canChangePhase: false,
        canApprove: false,
        canContactUser: false,
        canAnnounceCompletion: false,
      },
      budget: { maxTokens: 131072, maxWallMs: 180000, maxToolCalls: 24, maxRetries: 1, maxChildren: 0 },
      returnSchema: 'AgentResult',
    })
    expect(request.agentTask?.id).toMatch(/^coordinator-specification-[0-9a-f-]{36}-requirements-\d+$/u)
    expect(request.context).toMatchObject({
      objective: 'Build an order API',
      requiredOutputSchema: ['specs/001-orders/spec.md', 'specs/001-orders/clarification.md'],
      pathOwnership: ['specs/001-orders/spec.md', 'specs/001-orders/clarification.md'],
      artifactHashes: {
        'specs/001-orders/spec.md': 'b'.repeat(64),
        'specs/001-orders/clarification.md': 'c'.repeat(64),
      },
    })
  })

  it('uses configured token and wall-clock ceilings for each task', async () => {
    const fixture = createFixture({ budget: { maxAgents: 2, maxSteps: 7, maxTokens: 4096, maxWallMs: 5000 } })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await coordinator.start('Build an order API')

    expect(fixture.spawns[0]?.agentTask?.budget).toMatchObject({ maxTokens: 4096, maxWallMs: 5000, maxToolCalls: 7, maxRetries: 1, maxChildren: 0 })
  })

  it.each([
    ['maxAgents', 0],
    ['maxSteps', 0],
    ['maxTokens', 0],
    ['maxWallMs', 0],
    ['maxTokens', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid configured budget %s', (key, value) => {
    const fixture = createFixture({ budget: { maxAgents: 3, maxSteps: 24, [key]: value } })

    expect(() => new SpecificationCoordinator(fixture.dependencies)).toThrow(/budget/i)
  })

  it('requires a successful result for the exact task before advancing', async () => {
    const fixture = createFixture({ resultStatus: 'failed' })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await expect(coordinator.start('Build an order API')).rejects.toThrow(/requirements agent|result|successful/i)
    expect((await fixture.store.load())?.phase).toBe('SPECIFY')
  })

  it('rejects a result whose consumed budget exceeds the task ceiling', async () => {
    const fixture = createFixture({ resultTokens: 131073 })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await expect(coordinator.start('Build an order API')).rejects.toThrow(/consumed budget|tokens/i)
    expect((await fixture.store.load())?.phase).toBe('SPECIFY')
  })

  it('does not double-prefix paths that are already workspace-relative', async () => {
    const fixture = createFixture({ registryPathsAreWorkspaceRelative: true })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await coordinator.start('Build an order API')

    expect(fixture.spawns[0]?.agentTask?.inputArtifacts.map(({ path }) => path)).toEqual([
      'specs/001-orders/spec.md',
      'specs/001-orders/clarification.md',
    ])
  })

  it('rejects an artifact snapshot outside the workspace feature directory', async () => {
    const fixture = createFixture({ registryFeatureDirectory: '/outside/specs/001-orders' })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await expect(coordinator.start('Build an order API')).rejects.toThrow(/feature directory|workspace|outside/i)
    expect(fixture.spawns).toHaveLength(0)
  })

  it('rejects nested feature directories before dispatch', async () => {
    const fixture = createFixture({ registryFeatureDirectory: '/workspace/specs/001-orders/nested' })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await expect(coordinator.start('Build an order API')).rejects.toThrow(/exactly|feature directory/i)
    expect(fixture.spawns).toHaveLength(0)
  })

  it('reports unsupported registry artifacts instead of filtering them from task inputs', async () => {
    const fixture = createFixture({ includeUnsupportedArtifact: true })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await expect(coordinator.start('Build an order API')).rejects.toThrow(/artifact registry.*unsupported.*notes/i)
    expect(fixture.spawns).toHaveLength(0)
  })

  it('accepts the legitimate nested OpenAPI artifact as read-only input', async () => {
    const fixture = createFixture({ includeOpenApiArtifact: true })
    const coordinator = new SpecificationCoordinator(fixture.dependencies)

    await coordinator.start('Build an order API')

    expect(fixture.spawns[0]?.agentTask).toMatchObject({
      inputArtifacts: expect.arrayContaining([{ path: 'specs/001-orders/contracts/openapi.yaml', sha256: 'd'.repeat(64) }]),
      readPaths: expect.arrayContaining(['specs/001-orders/contracts/openapi.yaml']),
      writePaths: ['specs/001-orders/spec.md', 'specs/001-orders/clarification.md'],
    })
  })
})

function createFixture(options: { designValid?: boolean; initialPhase?: BackendTeamState['phase']; resultStatus?: 'passed' | 'failed'; resultTokens?: number; registryPathsAreWorkspaceRelative?: boolean; registryFeatureDirectory?: string; includeUnsupportedArtifact?: boolean; includeOpenApiArtifact?: boolean; budget?: { maxAgents: number; maxSteps: number; maxTokens?: number; maxWallMs?: number } } = {}) {
  let state = initialState(options.initialPhase)
  const spawns: AgentSpawnRequest[] = []
  const loader: SpecKitCommandLoaderPort & { calls: string[] } = { calls: [], load: async (id) => { loader.calls.push(id); return { id, prompt: `official ${id}`, sourceRealPath: `/workspace/${id}.md`, sourceSha256: 'a'.repeat(64) } } }
  const registry: ArtifactRegistryPort = { snapshot: async () => ({ featureDirectory: options.registryFeatureDirectory ?? '/workspace/specs/001-orders', artifacts: [{ path: options.registryPathsAreWorkspaceRelative ? 'specs/001-orders/spec.md' : 'spec.md', sha256: 'b'.repeat(64) }, { path: options.registryPathsAreWorkspaceRelative ? 'specs/001-orders/clarification.md' : 'clarification.md', sha256: 'c'.repeat(64) }, ...(options.includeUnsupportedArtifact ? [{ path: 'notes.md', sha256: 'd'.repeat(64) }] : []), ...(options.includeOpenApiArtifact ? [{ path: 'contracts/openapi.yaml', sha256: 'd'.repeat(64) }] : [])] }) }
  const validator: ArtifactValidatorPort & { gates: string[] } = { gates: [], validateForGate: async (gate) => { validator.gates.push(gate); return { valid: gate === 'requirements' || options.designValid !== false, errors: [] } } }
  const approvals: string[] = []
  const approvalService = { requestRequirementsApproval: async () => { approvals.push('requirements'); state = transition(state, 'DESIGN'); return state }, requestDesignApproval: async () => { approvals.push('design'); state = transition(state, 'PLAN'); return state }, verifyActiveApproval: async () => {} }
  const orchestration: BackendTeamOrchestrationPort = { requestApproval: async (): Promise<ApprovalDecision> => ({ effect: 'approve', reason: 'approved' }), spawnAgent: async (request) => { spawns.push(request); return handle(request.agentTask?.id ?? 'missing', options.resultStatus ?? 'passed', options.resultTokens) }, emit: async () => {} }
  const store: StateStore = { load: async () => state, create: async (initial) => { state = initial }, transact: async (expected, change) => { if (state.revision !== expected) throw new Error('revision conflict'); state = { ...change(state), revision: state.revision + 1 }; return state } }
  const dependencies = { workspaceRoot: '/workspace', stateStore: store, commandLoader: loader, artifactRegistry: registry, artifactValidator: validator, approvalService, orchestration, ...(options.budget === undefined ? {} : { budget: options.budget }) }
  return { dependencies, store, loader, validator, spawns, approvals }
}

function initialState(phase: BackendTeamState['phase'] = 'SPECIFY'): BackendTeamState { return { schemaVersion: 1, revision: 0, workspaceRoot: '/workspace', phase, runs: [], approvals: [], approvalTokens: [] } }
function transition(state: BackendTeamState, phase: BackendTeamState['phase']): BackendTeamState { return { ...state, phase, revision: state.revision + 1 } }
function handle(taskId: string, status: 'passed' | 'failed', tokens = 1): AgentHandle { return { id: `agent-${taskId}`, result: async () => ({ taskId, status, summary: status === 'passed' ? 'done' : 'failed', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: status === 'passed' ? [] : ['agent failed'], consumedBudget: { tokens, wallMs: 1, toolCalls: 1, retries: 0, children: 0 }, childResultIds: [], verification: { status: status === 'passed' ? 'passed' : 'failed', verifiedBy: 'agent', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'artifact-review', outcome: status, evidencePaths: [] }] } }), cancel: async () => {} } }

it('fails closed before dispatch when no task plan loader is configured', async () => {
  const fixture = createFixture({ initialPhase: 'PLAN' })
  const coordinator = new SpecificationCoordinator(fixture.dependencies)
  await expect(coordinator.generateTasks()).rejects.toThrow('task plan loader is required')
  expect(fixture.spawns).toHaveLength(0)
  expect((await fixture.store.load())?.phase).toBe('PLAN')
})

it('keeps PLAN when the generated task document cannot be loaded', async () => {
  const fixture = createFixture({ initialPhase: 'PLAN' })
  let calls = 0
  const coordinator = new SpecificationCoordinator({ ...fixture.dependencies, taskPlanLoader: { load: async () => { calls++; throw new Error('development plan has no executable tasks') } } })
  await expect(coordinator.generateTasks()).rejects.toThrow('no executable tasks')
  expect(calls).toBe(2)
  expect(fixture.spawns).toHaveLength(2)
  expect((await fixture.store.load())?.phase).toBe('PLAN')
})

it('lets the planner correct a rejected executable plan before entering BUILD', async () => {
  const fixture = createFixture({ initialPhase: 'PLAN' })
  let calls = 0
  const coordinator = new SpecificationCoordinator({ ...fixture.dependencies, taskPlanLoader: { load: async () => { if (++calls === 1) throw new Error('files contains a directory'); return {} } } })
  await coordinator.generateTasks()
  expect(calls).toBe(2)
  expect(fixture.spawns).toHaveLength(2)
  expect(fixture.spawns[1]?.task).toContain('host validation error')
  expect((await fixture.store.load())?.phase).toBe('BUILD')
})

it('supplies document requirements separately from the unchanged official prompt', async () => {
  const fixture = createFixture()
  const coordinator = new SpecificationCoordinator({ ...fixture.dependencies, taskPlanLoader: { load: async () => ({}) } })
  await coordinator.start('Build health API')
  expect(fixture.spawns[0]?.context.outputInstructions).toContain('Acceptance Criteria')
  expect(fixture.spawns[0]?.context.outputInstructions).toContain('AC-001')
  expect(fixture.spawns[0]?.context.prompt).toMatchObject({ prompt: 'official speckit.specify', sourceSha256: 'a'.repeat(64) })
  await coordinator.approveRequirements()
  await coordinator.design()
  expect(fixture.spawns.find(request => request.role === 'backend-architect')?.context.outputInstructions).toContain('OpenAPI 3.1')
  await coordinator.approveDesign()
  await coordinator.generateTasks()
  expect(fixture.spawns.at(-1)?.context.outputInstructions).toContain('backend-team:task')
  expect(fixture.spawns.at(-1)?.context.outputInstructions).toContain('immediately')
})

it('rejects duplicate document generation before dispatching a second set of experts', async () => {
  const fixture = createFixture({ initialPhase: 'DESIGN' })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const loader = fixture.dependencies.commandLoader
  const coordinator = new SpecificationCoordinator({ ...fixture.dependencies, commandLoader: { load: async (command, text) => { entered.resolve(); await release.promise; return loader.load(command, text) } } })
  const first = coordinator.design()
  await entered.promise
  const second = coordinator.design().catch((error: unknown) => error)
  release.resolve()
  await first
  expect(await second).toMatchObject({ message: 'specification operation is already running' })
  expect(fixture.spawns).toHaveLength(3)
})

it('keeps a restarted architecture review focused on requirements and its owned design outputs', async () => {
  const fixture = createFixture({ initialPhase: 'DESIGN' })
  const paths = ['spec.md', 'clarification.md', 'plan.md', 'architecture.md', 'contracts/openapi.yaml', 'data-model.md', 'test-plan.md', 'research.md', 'decisions.md', 'tasks.md']
  const coordinator = new SpecificationCoordinator({ ...fixture.dependencies, artifactRegistry: { snapshot: async () => ({featureDirectory: '/workspace/specs/001-orders', artifacts: paths.map(path => ({path, sha256: 'a'.repeat(64)}))}) } })
  await coordinator.design()
  expect(fixture.spawns[0]?.agentTask?.readPaths).toEqual(['specs/001-orders/spec.md', 'specs/001-orders/clarification.md', 'specs/001-orders/plan.md', 'specs/001-orders/architecture.md', 'specs/001-orders/contracts/openapi.yaml'])
  for (const spawn of fixture.spawns) expect(spawn.agentTask?.readPaths).not.toContain('specs/001-orders/tasks.md')
})
