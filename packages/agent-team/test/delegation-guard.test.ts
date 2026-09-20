import { describe, expect, it } from 'vitest'
import { AgentTaskSchema, type AgentTask, type PolicyContext, type PolicyDecision, type PolicyEngine } from '@dsh-backend-team/contracts'
import { AgentFactory } from '../src/agent-factory.js'
import { DelegationGuard, type DelegationSnapshot } from '../src/delegation-guard.js'
import type { ExpertPreset } from '../src/preset-loader.js'

const hash = 'a'.repeat(64)
const artifact = { path: 'specs/feature.md', sha256: hash }

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return AgentTaskSchema.parse({
    id: 'expert-1',
    parentTaskId: 'coordinator-1',
    depth: 1,
    role: 'developer',
    objective: 'Implement the owned service change.',
    nonGoals: ['Do not change unrelated paths.'],
    inputArtifacts: [artifact],
    readPaths: ['src'],
    writePaths: ['src/users'],
    capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, testCodeWrite: true, commandExecution: true, canDelegate: true },
    budget: { maxTokens: 1000, maxWallMs: 1000, maxToolCalls: 10, maxRetries: 1, maxChildren: 3 },
    doneWhen: ['Focused tests pass.'],
    verification: [{ id: 'focused-test', kind: 'test', instruction: 'Run focused tests.', required: true }],
    returnSchema: 'handoff-v1',
    ...overrides,
  })
}

const preset: ExpertPreset = {
  role: 'developer', purpose: 'Implement an approved bounded change.', allowedPhases: ['BUILD', 'VERIFY'],
  defaultCapabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, testCodeWrite: true, commandExecution: true, canDelegate: true },
  readPathPatterns: ['src'], writePathPatterns: ['src/users'], requiredInputs: ['approved design'], requiredOutputs: ['handoff'], nonGoals: ['Do not install packages.'],
  defaultBudget: { maxTokens: 800, maxWallMs: 800, maxToolCalls: 8, maxRetries: 1, maxChildren: 3 },
  verification: [{ id: 'focused-test', kind: 'test', instruction: 'Run focused tests.', required: true }],
}

const policyContext: PolicyContext = {
  phase: 'BUILD',
  workspace: { root: '/workspace', teamDir: '/workspace/.backend-team', stateDir: '/workspace/.backend-team/state', runtimeDir: '/workspace/.backend-team/runtime', cacheDir: '/workspace/.backend-team/cache', logsDir: '/workspace/.backend-team/logs', locksDir: '/workspace/.backend-team/locks', handoffDir: '/workspace/.backend-team/handoff' },
}

class AllowingPolicy implements PolicyEngine {
  async authorize(): Promise<PolicyDecision> { return { effect: 'allow', reason: 'test allow', ruleId: 'allow-test' } }
}

function snapshot(overrides: Partial<DelegationSnapshot> = {}): DelegationSnapshot {
  return {
    phase: 'BUILD', designApproved: true, childCount: 0, artifactHashes: [artifact], remainingBudget: { maxTokens: 900, maxWallMs: 900, maxToolCalls: 9, maxRetries: 1, maxChildren: 3 },
    ownedWritePaths: ['src/users'], occupiedWritePaths: [], policyContext,
    ...overrides,
  }
}

describe('DelegationGuard', () => {
  it('rewrites an expert proposal into a bounded depth-two worker', async () => {
    const parent = task()
    const proposed = task({ id: 'untrusted-child', parentTaskId: 'forged-parent', depth: 1, role: 'developer', writePaths: ['src/users/profile.ts'], readPaths: ['src/users'] })
    const guard = new DelegationGuard({ preset, snapshot: snapshot(), policyEngine: new AllowingPolicy() })

    const decision = await guard.authorizeChild(parent, proposed)

    expect(decision.effect).toBe('allow')
    expect(decision.task).toMatchObject({ id: 'untrusted-child', parentTaskId: 'expert-1', depth: 2, role: 'worker' })
    expect(decision.task.capabilities.canDelegate).toBe(false)
    expect(decision.task.capabilities.commandExecution).toBe(false)
    expect(decision.task.budget).toEqual({ maxTokens: 800, maxWallMs: 800, maxToolCalls: 8, maxRetries: 1, maxChildren: 0 })
  })

  it('denies delegation from a worker before trusting the proposed grandchild', async () => {
    const worker = task({ id: 'worker-1', parentTaskId: 'expert-1', depth: 2, role: 'worker', capabilities: { readProjectFiles: true, canDelegate: false }, budget: { maxTokens: 100, maxWallMs: 100, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } })
    const guard = new DelegationGuard({ preset, snapshot: snapshot(), policyEngine: new AllowingPolicy() })

    await expect(guard.authorizeChild(worker, task({ id: 'grandchild' }))).rejects.toThrow(/maximum agent depth/i)
  })

  it('denies stale artifacts, fourth children, unowned writes, and policy-denied paths', async () => {
    const parent = task()
    const proposal = task({ id: 'child-2', writePaths: ['src/users/profile.ts'], readPaths: ['src/users'] })
    const stale = new DelegationGuard({ preset, snapshot: snapshot({ artifactHashes: [{ ...artifact, sha256: 'b'.repeat(64) }] }), policyEngine: new AllowingPolicy() })
    const full = new DelegationGuard({ preset, snapshot: snapshot({ childCount: 3 }), policyEngine: new AllowingPolicy() })
    const unowned = new DelegationGuard({ preset, snapshot: snapshot(), policyEngine: new AllowingPolicy() })

    await expect(stale.authorizeChild(parent, proposal)).rejects.toThrow(/artifact/i)
    await expect(full.authorizeChild(parent, proposal)).rejects.toThrow(/children/i)
    await expect(unowned.authorizeChild(parent, task({ id: 'child-3', writePaths: ['src/admin'] }))).rejects.toThrow(/owned|write/i)
  })

  it('returns a deterministic deny result from the factory instead of copying forged topology', async () => {
    const parent = task()
    const factory = new AgentFactory({ parent, preset, guard: new DelegationGuard({ preset, snapshot: snapshot({ designApproved: false }), policyEngine: new AllowingPolicy() }) })
    const forged = { ...task({ id: 'child-4' }), parentTaskId: 'forged', depth: 0, role: 'coordinator' } as AgentTask

    await expect(factory.spawn(forged)).resolves.toEqual({ effect: 'deny', reason: 'design approval is required before delegation' })
  })

  it('enforces tester-only writes, sensitive-path denial, and non-self parenting', async () => {
    const testerParent = task({
      id: 'tester-1', role: 'tester', writePaths: ['src'],
      capabilities: { readProjectFiles: true, writeOwnedFiles: true, testCodeWrite: true, canDelegate: true },
    })
    const testerPreset: ExpertPreset = {
      ...preset,
      role: 'tester',
      defaultCapabilities: { readProjectFiles: true, writeOwnedFiles: true, testCodeWrite: true, commandExecution: true, canDelegate: true },
      writePathPatterns: ['src'],
    }
    const guard = new DelegationGuard({ preset: testerPreset, snapshot: snapshot({ ownedWritePaths: ['src'] }), policyEngine: new AllowingPolicy() })

    await expect(guard.authorizeChild(testerParent, task({ id: 'tester-child', role: 'tester', writePaths: ['src/app.ts'] }))).rejects.toThrow(/write/i)
    await expect(guard.authorizeChild(testerParent, task({ id: 'tester-child', role: 'tester', readPaths: ['src/.env'] }))).rejects.toThrow(/unsafe|sensitive|path/i)
    await expect(guard.authorizeChild(testerParent, task({ id: 'tester-1', role: 'tester' }))).rejects.toThrow(/ID|parent/i)
    await expect(new DelegationGuard({ preset: testerPreset, snapshot: snapshot({ artifactHashes: [{ path: 'secrets/token', sha256: hash }] }), policyEngine: new AllowingPolicy() }).authorizeChild(testerParent, task({ id: 'tester-child', role: 'tester' }))).rejects.toThrow(/unsafe|artifact|path/i)
  })
})
