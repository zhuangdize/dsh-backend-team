import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentTaskSchema, type AgentHandle, type AgentResult, type AgentTask, type PolicyDecision, type PolicyEngine } from '@dsh-backend-team/contracts'
import type { HarnessCreateAgentOptions } from '@dsh-backend-team/harness-adapter'
import { createProductionActivation } from '../src/backend-team-plugin.js'
import { createBackendTeamControlSurface, createBackendTeamProductionHost, createCoordinatorControlAdapter, createDshProductionHost } from '../src/production.js'

describe('production Bundle activation gate', () => {
  it('applies the managed test gate only to tasks that declare a required test', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-activation-test-gate-'))
    const makeAgent = () => {
      const events = [{ seq: 0, time: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{}' }] }, usage: { inputTokens: 1, outputTokens: 1 } } }]
      return {
        id: 'agent-test-gate', session: { events }, followup() { events.push({ seq: 1, time: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{}' }] }, usage: { inputTokens: 1, outputTokens: 1 } } }) }, cancel() {}, whenIdle: async () => undefined,
      } as unknown as AgentHandle
    }
    const result = (taskId: string, instructionId: string): AgentResult => ({
      taskId, status: 'passed', summary: 'inspection complete', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [], childResultIds: [],
      consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 0, retries: 0, children: 0 },
      verification: { status: 'passed', verifiedBy: 'fixture', verifiedAt: '2026-09-16T00:00:00.000Z', records: [{ instructionId, outcome: 'passed', evidencePaths: [] }] },
    })
    const create = async (task: AgentTask) => createProductionActivation({
      context: { agents: { create: async () => ({ agent: makeAgent(), dispose: async () => undefined }) } },
      workspaceRoot, recoveryToken: `test-gate-${task.id}`, policyEngine: allowingPolicy(), enableManagedNodeTests: true,
      decodeResult: () => result(task.id, task.verification[0]!.id),
    })

    const inspectionTask = taskForGate('inspection')
    const inspectionActivation = await create(inspectionTask)
    expect(inspectionActivation.mode).toBe('supported')
    if (inspectionActivation.mode === 'supported') await expect((await inspectionActivation.agentPort.spawnAgent({ role: 'developer', task: inspectionTask.objective, context: {}, agentTask: inspectionTask })).result()).resolves.toMatchObject({ status: 'passed', commands: [] })
    await inspectionActivation.dispose()

    const testTask = taskForGate('required-test', 'test')
    const testActivation = await create(testTask)
    expect(testActivation.mode).toBe('supported')
    if (testActivation.mode === 'supported') await expect((await testActivation.agentPort.spawnAgent({ role: 'developer', task: testTask.objective, context: {}, agentTask: testTask })).result()).rejects.toThrow('passing development result requires a real successful test')
    await testActivation.dispose()
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('installs mandatory production setup even when the caller provides no setup hook', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-required-setup-'))
    let setupCalled = false
    let published = false
    const activation = await createProductionActivation({
      context: { agents: { create: async (options: HarnessCreateAgentOptions) => {
        expect(options.setup).toBeTypeOf('function')
        setupCalled = true
        await options.setup!({ agent: {}, tools: { presentAs: () => () => {}, register: () => () => {}, guard: () => () => {} } })
        published = true
        throw new Error('unrestricted Agent must never be published')
      } } },
      workspaceRoot,
      recoveryToken: 'mandatory-setup-recovery-token',
      policyEngine: allowingPolicy(),
    })
    try {
      expect(activation.mode).toBe('supported')
      if (activation.mode !== 'supported') throw new Error('expected supported composition')
      await expect(activation.agentPort.spawnAgent({ role: 'worker', task: 'Unstructured write', context: {} })).rejects.toThrow()
      expect(setupCalled).toBe(true)
      expect(published).toBe(false)
    } finally {
      await activation.dispose()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
  it('rejects an incomplete coordinator handler table at host assembly time', () => {
    expect(() => createCoordinatorControlAdapter({})).toThrow(/handler/i)
  })

  it('exposes the projected control surface through the opt-in production entry', async () => {
    const surface = await createBackendTeamControlSurface({
      events: { read: async () => [], subscribe: () => () => undefined },
      workspaceName: 'demo',
      coordinator: { dispatch: async (_action, context) => ({ accepted: true, stateRevision: (context as { expectedRevision: number }).expectedRevision }) },
      authenticator: { authenticate: (input) => input },
    })

    expect(surface.projector.snapshot()).toMatchObject({ workspaceName: 'demo', phase: 'DISCOVER' })
    await surface.dispose()
  })

  it('stays read-only without explicit host capabilities and credentials', async () => {
    const activation = await createProductionActivation({})

    expect(activation).toMatchObject({
      mode: 'read-only',
      missing: ['agents', 'workspaceRoot', 'recoveryToken', 'policyEngine'],
    })
    expect(activation.composition).toBeUndefined()
    await expect(activation.dispose()).resolves.toBeUndefined()
  })

  it('creates the durable production composition only after every required input is present', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-activation-'))
    const activation = await createProductionActivation({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot,
      recoveryToken: 'activation-test-recovery-token',
      policyEngine: allowingPolicy(),
    })

    expect(activation.mode).toBe('supported')
    expect(activation.composition?.layout.root).toBe(await realpath(workspaceRoot))
    expect(activation.agentPort?.verifiedProvenance).toBe(true)
    await expect(activation.dispose()).resolves.toBeUndefined()
  })

  it('accepts a verified workflow port and exposes its gated action catalog', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-activation-workflow-'))
    const workflow = {
      start: async () => undefined,
      refine: async () => undefined,
      approve: async () => undefined,
      status: async () => ({ phase: 'DISCOVER' }),
      resume: async () => undefined,
    }
    const activation = await createProductionActivation({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot,
      recoveryToken: 'activation-workflow-recovery-token',
      policyEngine: allowingPolicy(),
      workflow,
    })

    expect(activation.mode).toBe('supported')
    if (activation.mode !== 'supported') throw new Error('expected supported activation')
    expect(activation.composition.actions.list().map((action) => (action as { name: string }).name)).toEqual([
      'backend_team_start', 'backend_team_refine', 'backend_team_approve', 'backend_team_status', 'backend_team_resume',
    ])
    await activation.dispose()
  })

  it('passes structural specification ports into the internally composed workflow', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-activation-specification-'))
    const activation = await createProductionActivation({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot,
      recoveryToken: 'activation-specification-recovery-token',
      policyEngine: allowingPolicy(),
      specification: specificationPorts(),
    })

    expect(activation.mode).toBe('supported')
    if (activation.mode !== 'supported') throw new Error('expected supported activation')
    expect(activation.composition.specification).toBeDefined()
    expect(activation.composition.workflow).toBeDefined()
    expect(activation.composition.actions.list().map((action) => (action as { name: string }).name)).toEqual([
      'backend_team_start', 'backend_team_refine', 'backend_team_approve', 'backend_team_status', 'backend_team_resume',
    ])
    await activation.dispose()
  })

  it('fails closed for malformed or conflicting specification workflow inputs', async () => {
    const malformedRoot = await mkdtemp(join(tmpdir(), 'backend-team-activation-invalid-specification-'))
    const base = {
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot: malformedRoot,
      recoveryToken: 'activation-invalid-specification-token',
      policyEngine: allowingPolicy(),
    }
    const malformed = await createProductionActivation({ ...base, specification: {} as never })
    expect(malformed).toMatchObject({ mode: 'read-only', missing: ['specification'] })
    await expect(access(join(malformedRoot, '.backend-team'))).rejects.toMatchObject({ code: 'ENOENT' })

    for (const overrides of [{ maxTokens: 0 }, { maxWallMs: -1 }, { maxTokens: Number.NaN }, { maxWallMs: 1.5 }]) {
      const invalidBudget = await createProductionActivation({ ...base, specification: { ...specificationPorts(), budget: { maxAgents: 1, maxSteps: 24, ...overrides } } })
      expect(invalidBudget).toMatchObject({ mode: 'read-only', missing: ['specification'] })
      await expect(access(join(malformedRoot, '.backend-team'))).rejects.toMatchObject({ code: 'ENOENT' })
    }

    const conflictRoot = await mkdtemp(join(tmpdir(), 'backend-team-activation-conflicting-specification-'))
    const conflict = await createProductionActivation({
      ...base,
      workspaceRoot: conflictRoot,
      workflow: { start: async () => undefined, refine: async () => undefined, approve: async () => undefined, status: async () => undefined, resume: async () => undefined },
      specification: specificationPorts(),
    })
    expect(conflict).toMatchObject({ mode: 'read-only', reasons: ['workflow-and-specification-are-mutually-exclusive'] })
    await expect(access(join(conflictRoot, '.backend-team'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when an optional workflow port is malformed', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-activation-invalid-workflow-'))
    const activation = await createProductionActivation({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot,
      recoveryToken: 'activation-invalid-workflow-token',
      policyEngine: allowingPolicy(),
      workflow: {} as never,
    })

    expect(activation).toMatchObject({ mode: 'read-only', missing: ['workflow'] })
    await expect(access(join(workspaceRoot, '.backend-team'))).rejects.toMatchObject({ code: 'ENOENT' })
    await activation.dispose()
  })

  it('composes the production activation, control surface, and loopback route as one disposable host', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-host-'))
    const registrations: unknown[] = []
    const server = {
      register(route: unknown) {
        registrations.push(route)
        return () => {
          const index = registrations.indexOf(route)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    }
    const host = await createBackendTeamProductionHost({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot,
      recoveryToken: 'production-host-recovery-token',
      policyEngine: allowingPolicy(),
      server: { verifiedProvenance: true as const, register: server.register },
      sessionInput: () => ({ sessionId: 'session-1234567890', workspaceId: workspaceRoot, loopback: true, readOnly: false }),
      authenticator: { authenticate: (input) => input },
      workspaceName: 'demo',
      coordinatorHandlers: completeHandlers(),
    })

    expect(host.mode).toBe('supported')
    if (host.mode !== 'supported') throw new Error('expected supported production host')
    expect(host.surface.projector.snapshot()).toMatchObject({ workspaceName: 'demo', phase: 'DISCOVER' })
    expect(registrations).toHaveLength(1)
    await host.dispose()
    await host.dispose()
    expect(registrations).toHaveLength(0)
  })

  it('does not register a route when activation cannot prove production capabilities', async () => {
    const registrations: unknown[] = []
    const host = await createBackendTeamProductionHost({
      server: { verifiedProvenance: true as const, register: (route) => { registrations.push(route); return () => undefined } },
      sessionInput: () => undefined,
      authenticator: { authenticate: (input) => input },
      workspaceName: 'demo',
      coordinatorHandlers: completeHandlers(),
    })

    expect(host.mode).toBe('read-only')
    expect(host.reasons).toContain('explicit-production-inputs-required')
    expect(registrations).toHaveLength(0)
    await host.dispose()
  })

  it('keeps an incomplete activation read-only even when no command table is supplied', async () => {
    const registrations: unknown[] = []
    const host = await createBackendTeamProductionHost({
      server: { verifiedProvenance: true as const, register: (route) => { registrations.push(route); return () => undefined } },
      sessionInput: () => undefined,
      authenticator: { authenticate: (input) => input },
      workspaceName: 'demo',
    })

    expect(host.mode).toBe('read-only')
    expect(registrations).toHaveLength(0)
    await host.dispose()
  })

  it('builds the coordinator handler table from explicit revision-fenced implementations', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-host-implementations-'))
    const revision = 0
    const callback = async () => undefined
    const host = await createBackendTeamProductionHost({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot,
      recoveryToken: 'production-host-implementations-token',
      policyEngine: allowingPolicy(),
      server: { verifiedProvenance: true as const, register: () => () => undefined },
      sessionInput: () => ({ sessionId: 'session-1234567890', workspaceId: workspaceRoot, loopback: true, readOnly: false }),
      authenticator: { authenticate: (input) => input },
      workspaceName: 'demo',
      coordinatorImplementations: {
        currentRevision: () => revision,
        submitClarification: callback,
        decideApproval: callback,
        pauseRun: callback,
        resumeRun: callback,
        retryFailedStep: callback,
        openArtifact: callback,
        startDatabase: callback,
        stopDatabase: callback,
        openDatabaseGui: callback,
      },
    })

    expect(host.mode).toBe('supported')
    await host.dispose()
  })

  it('rejects missing coordinator implementations before creating workspace state', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-host-missing-handlers-'))

    await expect(createBackendTeamProductionHost({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot,
      recoveryToken: 'production-host-missing-handlers-token',
      policyEngine: allowingPolicy(),
      server: { verifiedProvenance: true as const, register: () => () => undefined },
      sessionInput: () => undefined,
      authenticator: { authenticate: (input) => input },
      workspaceName: 'demo',
    })).rejects.toThrow(/handlers or implementations are required/i)
    await expect(access(join(workspaceRoot, '.backend-team'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fills revision-fenced database commands from the verified database port', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-host-database-port-'))
    const canonicalRoot = await realpath(workspaceRoot)
    const calls: string[] = []
    const host = await createBackendTeamProductionHost({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot,
      recoveryToken: 'production-host-database-port-token',
      policyEngine: allowingPolicy(),
      server: { verifiedProvenance: true as const, register: () => () => undefined },
      sessionInput: () => ({ sessionId: 'session-1234567890', workspaceId: canonicalRoot, loopback: true, readOnly: false }),
      authenticator: { authenticate: (input) => input },
      workspaceName: 'demo',
      databasePort: {
        verifiedProvenance: true as const,
        start: async () => { calls.push('start') },
        prepare: async () => { calls.push('prepare') },
        stop: async () => { calls.push('stop') },
        openGui: async () => { calls.push('gui'); return { url: 'http://127.0.0.1:55234/', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
      },
      coordinatorImplementations: {
        currentRevision: () => 0,
        submitClarification: async () => undefined,
        decideApproval: async () => undefined,
        pauseRun: async () => undefined,
        resumeRun: async () => undefined,
        retryFailedStep: async () => undefined,
        openArtifact: async () => undefined,
      },
    })

    expect(host.mode).toBe('supported')
    if (host.mode !== 'supported') throw new Error('expected supported production host')
    const state = host.surface.projector.snapshot() as { workspaceId?: string; stateRevision?: number }
    await expect(host.surface.service.dispatch(
      { sessionId: 'session-1234567890', workspaceId: canonicalRoot, loopback: true, readOnly: false },
      { type: 'start-database', workspaceId: state.workspaceId ?? workspaceRoot, expectedRevision: state.stateRevision ?? 0 },
    )).resolves.toMatchObject({ accepted: true })
    expect(calls).toEqual(['start', 'prepare'])
    await expect(host.surface.service.dispatch(
      { sessionId: 'session-1234567890', workspaceId: canonicalRoot, loopback: true, readOnly: false },
      { type: 'open-database-gui', workspaceId: canonicalRoot, expectedRevision: 0 },
    )).resolves.toMatchObject({ accepted: true, navigation: { kind: 'one-time-local-url', url: 'http://127.0.0.1:55234/' } })
    await host.dispose()
    expect(calls).toEqual(['start', 'prepare', 'gui', 'stop'])
  })

  it('creates handlers against the actual activated composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backend-team-host-factory-'))
    let factoryRoot: string | undefined
    const unavailable = async () => { throw new Error('operation unavailable in this fixture') }
    const host = await createBackendTeamProductionHost({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot: root, recoveryToken: 'factory-recovery-token', policyEngine: allowingPolicy(),
      server: { verifiedProvenance: true, register: () => () => undefined }, sessionInput: () => undefined,
      authenticator: { authenticate: input => input }, workspaceName: 'factory',
      coordinatorImplementationFactory: composition => {
        factoryRoot = composition.layout.root
        return {
          currentRevision: async () => (await composition.stateStore.load())!.revision,
          submitClarification: unavailable, decideApproval: unavailable, pauseRun: unavailable, resumeRun: unavailable,
          retryFailedStep: unavailable, openArtifact: unavailable, startDatabase: unavailable, stopDatabase: unavailable, openDatabaseGui: unavailable,
        }
      },
    })
    expect(host.mode).toBe('supported')
    expect(factoryRoot).toBe(await realpath(root))
    await host.dispose()
  })

  it('retries an interrupted database stop on subsequent host disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backend-team-host-stop-retry-'))
    let attempts = 0
    const host = await createBackendTeamProductionHost({
      context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
      workspaceRoot: root, recoveryToken: 'host-stop-retry-recovery', policyEngine: allowingPolicy(),
      server: { verifiedProvenance: true, register: () => () => undefined }, sessionInput: () => undefined,
      authenticator: { authenticate: input => input }, workspaceName: 'retry', coordinatorHandlers: completeHandlers(),
      databasePort: { verifiedProvenance: true, start: async () => undefined, stop: async () => { attempts++; if (attempts === 1) throw new Error('stop interrupted') }, openGui: async () => { throw new Error('not used') } },
    })
    const first = host.dispose()
    expect(host.dispose()).toBe(first)
    await expect(first).rejects.toThrow('production host disposal failed')
    await expect(host.dispose()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('derives the real Host and Session ports from one DSH context', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-dsh-host-'))
    const canonicalRoot = await realpath(workspaceRoot)
    const sessionId = 'session-1234567890'
    const registrations: unknown[] = []
    const host = await createDshProductionHost({
      context: {
        webServer: { host: '127.0.0.1', port: 3080, register: (route: unknown) => { registrations.push(route); return () => undefined } },
        sessions: { get: (id: string) => id === sessionId ? { id, header: { cwd: canonicalRoot } } : undefined },
        agents: {
          get: (id: string) => id === sessionId ? { id } : undefined,
          create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle),
        },
      },
      workspaceRoot,
      recoveryToken: 'dsh-host-recovery-token',
      policyEngine: allowingPolicy(),
      authenticator: { authenticate: (input) => input },
      workspaceName: 'demo',
      coordinatorHandlers: completeHandlers(),
    })

    expect(host.mode).toBe('supported')
    expect(registrations).toHaveLength(1)
    await host.dispose()
  })
})

function taskForGate(id: string, kind: 'inspection' | 'test' = 'inspection'): AgentTask {
  return AgentTaskSchema.parse({
    id, parentTaskId: 'coordinator', depth: 1, role: 'developer', objective: 'Check source', nonGoals: ['do not deploy'], inputArtifacts: [], readPaths: ['src'], writePaths: [],
    capabilities: { readProjectFiles: true, writeOwnedFiles: false, businessCodeWrite: false, testCodeWrite: false, configurationWrite: false, commandExecution: false, networkHosts: [], install: false, migration: false, canDelegate: false, canChangePhase: false, canApprove: false, canContactUser: false, canAnnounceCompletion: true },
    budget: { maxTokens: 1_000, maxWallMs: 15_000, maxToolCalls: 10, maxRetries: 0, maxChildren: 0 }, doneWhen: ['checked'], verification: [{ id: kind, kind, instruction: `run ${kind}`, required: true }], returnSchema: 'AgentResult',
  })
}

function allowingPolicy(): PolicyEngine {
  return { authorize: async (): Promise<PolicyDecision> => ({ effect: 'allow', reason: 'test', ruleId: 'test-allow' }) }
}

function completeHandlers(): Record<string, (action: unknown, context: { expectedRevision: number }) => Promise<{ accepted: true; stateRevision: number }>> {
  const handler = async (_action: unknown, context: { expectedRevision: number }) => ({ accepted: true as const, stateRevision: context.expectedRevision })
  return {
    'submit-clarification': handler,
    'decide-approval': handler,
    'pause-run': handler,
    'resume-run': handler,
    'retry-failed-step': handler,
    'open-artifact': handler,
    'start-database': handler,
    'stop-database': handler,
    'open-database-gui': handler,
  }
}

function specificationPorts() {
  return {
    commandLoader: { load: async () => ({ id: 'fixture', prompt: 'fixture', sourceRealPath: '/fixture.md', sourceSha256: 'a'.repeat(64) }) },
    artifactRegistry: { snapshot: async () => ({ featureDirectory: '/fixture', artifacts: [{ path: 'spec.md', sha256: 'b'.repeat(64) }] }) },
    artifactValidator: { validateForGate: async () => ({ valid: true }) },
  }
}

it('wires development commands and live status from the activated run factory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-run-control-'))
  const canonicalRoot = await realpath(root)
  const calls: string[] = []
  let status: 'idle' | 'running' | 'pausing' | 'paused' = 'idle'
  const listeners = new Set<() => void>()
  const unavailable = async () => { throw new Error('fixture unavailable') }
  const host = await createBackendTeamProductionHost({
    context: { agents: { create: async () => ({ id: 'agent', dispose: async () => undefined } as unknown as AgentHandle) } },
    workspaceRoot: root, recoveryToken: 'run-control-factory-token', policyEngine: allowingPolicy(),
    server: { verifiedProvenance: true, register: () => () => {} }, sessionInput: () => undefined,
    authenticator: { authenticate: input => input }, workspaceName: 'fixture',
    developmentRunFactory: composition => {
      expect(composition.coordinator.dispatchExpert).toBeTypeOf('function')
      return { snapshot: () => ({ status }), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
        resume: async () => { calls.push('resume'); status = 'running'; listeners.forEach(listener => listener()) },
        pause: async () => { calls.push('pause-request'); status = 'pausing'; listeners.forEach(listener => listener()) },
        pauseAndWait: async () => { calls.push('pause-and-wait'); status = 'paused'; listeners.forEach(listener => listener()) },
        dispose: async () => { calls.push('dispose') },
      }
    },
    coordinatorImplementationFactory: composition => ({ currentRevision: async () => (await composition.stateStore.load())!.revision,
      submitClarification: unavailable, decideApproval: unavailable, retryFailedStep: unavailable, openArtifact: unavailable,
      startDatabase: unavailable, stopDatabase: unavailable, openDatabaseGui: unavailable,
    }),
  })
  if (host.mode !== 'supported') throw new Error('expected supported host')
  const session = { sessionId: 'run-control-session-123456', workspaceId: canonicalRoot, loopback: true, readOnly: false }
  try {
    await host.surface.service.dispatch(session, { type: 'resume-run', workspaceId: canonicalRoot, expectedRevision: 0 })
    expect(host.surface.projector.snapshot()).toMatchObject({ developmentRun: { status: 'running' } })
    await host.surface.service.dispatch(session, { type: 'pause-run', workspaceId: canonicalRoot, expectedRevision: 0 })
    expect(host.surface.projector.snapshot()).toMatchObject({ developmentRun: { status: 'paused' } })
    await expect(host.surface.service.dispatch(session, { type: 'resume-run', workspaceId: canonicalRoot, expectedRevision: 99 })).rejects.toThrow()
    expect(calls).toEqual(['resume', 'pause-and-wait'])
  } finally { await host.dispose() }
  expect(calls).toEqual(['resume', 'pause-and-wait', 'dispose'])
})

it('seeds the control revision from durable state even without matching event history', async () => {
  const { FileStateStore } = await import('@dsh-backend-team/core')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-state-revision-')))
  try {
    const store = new FileStateStore(root)
    await store.create({ schemaVersion: 1, revision: 7, workspaceRoot: root, phase: 'DISCOVER', runs: [], approvals: [], approvalTokens: [] })
    const unavailable = async () => { throw new Error('test operation unavailable') }
    const host = await createBackendTeamProductionHost({ context: { agents: { create: async () => { throw new Error('not used') } } }, workspaceRoot: root, workspaceName: 'resume', recoveryToken: 'resume-host-recovery-key', policyEngine: allowingPolicy(), server: { verifiedProvenance: true, register: () => () => {} }, sessionInput: () => ({}), authenticator: { authenticate: input => input }, coordinatorImplementations: { currentRevision: async () => 7, submitClarification: unavailable, decideApproval: unavailable, pauseRun: unavailable, resumeRun: unavailable, retryFailedStep: unavailable, openArtifact: unavailable, startDatabase: unavailable, stopDatabase: unavailable, openDatabaseGui: unavailable } })
    try { expect(host.surface?.projector.snapshot()).toMatchObject({ phase: 'DISCOVER', stateRevision: 7 }) }
    finally { await host.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
