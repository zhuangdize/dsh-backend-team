import { RequirementChangeService } from '../src/requirement-change.js'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentHandle, AgentSpawnRequest, PolicyDecision, PolicyEngine } from '@dsh-backend-team/contracts'
import { createProductionComposition } from '../src/production-composition.js'

describe('production composition workflow wiring', () => {
  it('publishes the design approval automatically and starts development only after both decisions', async () => {
    const resume = vi.fn(async () => undefined)
    const composition = await createWorkflowComposition({ autoAdvance: true, resume, taskPlanLoader: { load: async () => ({}) } })
    try {
      await composition.workflow!.start('Build a travel API')
      await composition.requestWorkflowApproval('requirements')
      const requirements = composition.approvals.listPending()[0]!
      expect(resume).not.toHaveBeenCalled()
      await composition.approvals.decideAndWait(requirements.id, { effect: 'approve', reason: 'fixture human decision' }, requirements.artifactHash, requirements.stateRevision)
      await vi.waitFor(() => expect(composition.approvals.listPending()[0]?.request.kind).toBe('design'))
      expect(resume).not.toHaveBeenCalled()
      const design = composition.approvals.listPending()[0]!
      await composition.approvals.decideAndWait(design.id, { effect: 'approve', reason: 'fixture human decision' }, design.artifactHash, design.stateRevision)
      await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce())
      expect(await composition.stateStore.load()).toMatchObject({ phase: 'BUILD' })
    } finally { await composition.dispose() }
  })
  it('builds the real specification workflow inside the production composition', async () => {
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'backend-team-composition-workflow-')))
    const commandCalls: string[] = []
    const composition = await createProductionComposition({
      workspaceRoot,
      recoveryToken: 'composition-workflow-recovery-token',
      agents: deterministicAgents(),
      policyEngine: allowingPolicy(),
      specification: {
        commandLoader: {
          async load(command) {
            commandCalls.push(command)
            return {
              id: command,
              prompt: `deterministic ${command}`,
              sourceRealPath: `/fixture/${command}.md`,
              sourceSha256: 'a'.repeat(64),
            }
          },
        },
        artifactRegistry: {
          async snapshot() {
            return {
              featureDirectory: `${workspaceRoot}/specs/001-fixture`,
              artifacts: [{ path: 'spec.md', sha256: 'b'.repeat(64) }],
            }
          },
        },
        artifactValidator: {
          async validateForGate() {
            return { valid: true, errors: [] }
          },
        },
      },
    })

    const start = composition.actions.get('backend_team_start')
    expect(start).toBeDefined()
    const status = await start!.execute({ objective: 'Build a deterministic travel API' })

    expect(status).toMatchObject({ phase: 'AWAIT_REQUIREMENTS_APPROVAL' })
    expect(commandCalls).toEqual(['speckit.specify'])
    expect(composition.specification).toBeDefined()
    expect(composition.workflow).toBeDefined()
    expect((await composition.events.read())).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'phase-changed', phase: 'SPECIFY' }),
      expect.objectContaining({ type: 'run-recorded' }),
      expect.objectContaining({ type: 'phase-changed', phase: 'AWAIT_REQUIREMENTS_APPROVAL' }),
    ]))

    await composition.dispose()
  })

  it('rejects externally preassembled workflow together with specification ports', async () => {
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'backend-team-composition-workflow-conflict-')))
    const workflow = { start: async () => undefined, refine: async () => undefined, approve: async () => undefined, status: () => undefined, resume: async () => undefined }

    await expect(createProductionComposition({
      workspaceRoot,
      recoveryToken: 'composition-workflow-conflict-token',
      agents: deterministicAgents(),
      policyEngine: allowingPolicy(),
      workflow,
      specification: {
        commandLoader: { load: async () => ({ id: 'fixture', prompt: 'fixture', sourceRealPath: '/fixture.md', sourceSha256: 'a'.repeat(64) }) },
        artifactRegistry: { snapshot: async () => ({ featureDirectory: `${workspaceRoot}/specs/001-fixture`, artifacts: [{ path: 'spec.md', sha256: 'b'.repeat(64) }] }) },
        artifactValidator: { validateForGate: async () => ({ valid: true }) },
      },
    })).rejects.toThrow(/workflow.*specification|specification.*workflow/i)
  })

  it('single-flights workflow approval requests and permits a new ID after rejection', async () => {
    const composition = await createWorkflowComposition()
    await composition.workflow!.start('Build a deterministic travel API')
    const first = composition.requestWorkflowApproval('requirements')
    const duplicate = composition.requestWorkflowApproval('requirements')
    expect(duplicate).toBe(first)
    await first

    const pending = composition.approvals.listPending()[0]
    expect(pending?.request.kind).toBe('requirements')
    await expect(composition.approvals.decideAndWait(pending!.id, { effect: 'reject', reason: 'needs edits' }, pending!.artifactHash, pending!.stateRevision)).resolves.toBeUndefined()

    let retry: Promise<void> | undefined
    for (let attempt = 0; attempt < 32 && retry === undefined; attempt += 1) {
      const candidate = composition.requestWorkflowApproval('requirements')
      if (candidate !== first) retry = candidate
      else await Promise.resolve()
    }
    expect(retry).toBeDefined()
    await retry
    const retried = composition.approvals.listPending()[0]
    expect(retried?.id).not.toBe(pending!.id)
    await composition.dispose()
  })

  it('closes workflow approval admission and prevents a late design phase during disposal', async () => {
    const composition = await createWorkflowComposition()
    await composition.workflow!.start('Build a deterministic travel API')
    const request = composition.requestWorkflowApproval('requirements')
    await request
    expect(composition.approvals.listPending()).toHaveLength(1)

    await composition.dispose()
    expect(composition.approvals.listPending()).toEqual([])
    expect(await composition.stateStore.load()).toMatchObject({ phase: 'AWAIT_REQUIREMENTS_APPROVAL' })
    await expect(composition.requestWorkflowApproval('requirements')).rejects.toThrow(/closed|unavailable/i)
  })

  it('fails closed when no internally composed workflow is configured', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-composition-workflow-unconfigured-'))
    const composition = await createProductionComposition({ workspaceRoot, recoveryToken: 'composition-workflow-unconfigured-token', agents: deterministicAgents(), policyEngine: allowingPolicy() })
    await expect(composition.requestWorkflowApproval('requirements')).rejects.toThrow(/unavailable/i)
    await composition.dispose()
  })
})

async function createWorkflowComposition(additions: Partial<import('../src/production-composition.js').ProductionSpecificationOptions> = {}) {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'backend-team-composition-workflow-flight-')))
  return createProductionComposition({
    workspaceRoot,
    recoveryToken: 'composition-workflow-flight-token',
    agents: deterministicAgents(),
    policyEngine: allowingPolicy(),
    specification: {
      commandLoader: { load: async (command) => ({ id: command, prompt: `deterministic ${command}`, sourceRealPath: `/fixture/${command}.md`, sourceSha256: 'a'.repeat(64) }) },
      artifactRegistry: { snapshot: async () => ({ featureDirectory: `${workspaceRoot}/specs/001-fixture`, artifacts: [{ path: 'spec.md', sha256: 'b'.repeat(64) }] }) },
      artifactValidator: { validateForGate: async () => ({ valid: true, errors: [] }) },
      ...additions,
    },
  })
}

function deterministicAgents(): { readonly verifiedProvenance: true; spawnAgent(request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle> } {
  return {
    verifiedProvenance: true,
    async spawnAgent(request) {
      const taskId = request.agentTask?.id ?? 'deterministic-task'
      return {
        id: `deterministic-agent-${taskId}`,
        result: async () => ({
          taskId,
          status: 'passed',
          summary: 'Deterministic fixture result',
          changedPaths: [],
          commands: [],
          evidencePaths: [],
          risks: [],
          unresolvedItems: [],
          consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 1, retries: 0, children: 0 },
          childResultIds: [],
          verification: {
            status: 'passed',
            verifiedBy: 'fixture',
            verifiedAt: '2026-01-01T00:00:00.000Z',
            records: [{ instructionId: 'artifact-review', outcome: 'passed', evidencePaths: [] }],
          },
        }),
        cancel: async () => undefined,
      }
    },
  }
}

function allowingPolicy(): PolicyEngine {
  return { authorize: async (): Promise<PolicyDecision> => ({ effect: 'allow', reason: 'test', ruleId: 'test-allow' }) }
}

it('reopens both real approval gates after a development change and rejects old decisions', async () => {
  const resume = vi.fn(async () => {})
  const composition = await createWorkflowComposition({ autoAdvance: true, resume, taskPlanLoader: { load: async () => ({}) } })
  const approve = async () => {
    const pending = composition.approvals.listPending()[0]!
    await composition.approvals.decideAndWait(pending.id, { effect: 'approve', reason: 'isolated fixture decision' }, pending.artifactHash, pending.stateRevision)
    return pending
  }
  try {
    await composition.workflow!.start('original scope'); await composition.requestWorkflowApproval('requirements')
    const old = await approve()
    await vi.waitFor(() => expect(composition.approvals.listPending()[0]?.request.kind).toBe('design'))
    await approve(); await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce())
    const state = (await composition.stateStore.load())!
    const service = new RequirementChangeService({
      stateStore: composition.stateStore, stopDevelopment: async () => {}, assertIdle: () => {},
      snapshotDocuments: async () => [{ path: 'spec.md', content: 'original scope' }], archiveCheckpoint: async () => {}, prepareExecutionBaseline: async () => {},
      generateRequirements: text => composition.workflow!.start(text), publishApproval: () => composition.requestWorkflowApproval('requirements'),
    })
    await service.request('include customer follow-up', state.revision, 'session-human-123456')
    expect((await composition.stateStore.load())?.approvals).toEqual([])
    expect(composition.approvals.listPending()[0]?.request.kind).toBe('requirements')
    await expect(composition.verifyDevelopmentApproval()).rejects.toThrow()
    await expect(composition.approvals.decideAndWait(old.id, { effect: 'approve', reason: 'stale fixture decision' }, old.artifactHash, old.stateRevision)).rejects.toThrow()
    expect(resume).toHaveBeenCalledOnce()
    await approve()
    await vi.waitFor(() => expect(composition.approvals.listPending()[0]?.request.kind).toBe('design'))
    expect(resume).toHaveBeenCalledOnce()
    await expect(composition.verifyDevelopmentApproval()).rejects.toThrow()
    await approve(); await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2))
    expect((await composition.stateStore.load())?.phase).toBe('BUILD')
    await expect(composition.verifyDevelopmentApproval()).resolves.toBeUndefined()
  } finally { await composition.dispose() }
})
