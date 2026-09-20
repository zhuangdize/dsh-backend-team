import { describe, expect, it } from 'vitest'
import {
  acceptanceScenarios,
  approvedAcceptanceScenarioIds,
  type CleanupAssertion,
  createE2eGate,
  createInMemoryAcceptanceExecutor,
  createUnwiredAcceptanceExecutor,
  executeAcceptanceScenario,
  requiredE2eGateIds,
} from './scenarios.js'

describe('Backend Team final acceptance fixture catalog', () => {
  it('maps each approved scenario to a deterministic, gated acceptance contract', () => {
    expect(acceptanceScenarios.map((scenario) => scenario.id)).toEqual([
      'natural-language-new-backend',
      'existing-postgresql-project',
      'existing-mysql-preservation',
      'cross-phase-recovery',
      'expert-subagent-bounds',
      'production-outside-workspace-blocking',
      'dbgate-to-migration',
      'no-docker-global-pollution',
      'untrusted-harness-provenance',
      'macos-arm64-x64',
    ])
    expect(approvedAcceptanceScenarioIds).toEqual(acceptanceScenarios.map((scenario) => scenario.id))

    for (const scenario of acceptanceScenarios) {
      expect(scenario.initialState.workspace.description).toBeTruthy()
      expect(scenario.initialState.profile.description).toBeTruthy()
      expect(scenario.userActions.length).toBeGreaterThan(0)
      expect(scenario.steps.length).toBeGreaterThan(scenario.userActions.length)
      expect(scenario.expected.phases.length).toBeGreaterThan(0)
      expect(scenario.expected.effects.permitted.length + scenario.expected.effects.forbidden.length).toBeGreaterThan(0)
      expect(scenario.expected.reports.length).toBeGreaterThan(0)
      expect(scenario.cleanup.assertions.length).toBeGreaterThan(0)
      expect(scenario.gates).toHaveLength(requiredE2eGateIds.length)
      expect(scenario.gates.map((gate) => gate.id)).toEqual(requiredE2eGateIds)
      expect(scenario.gates.every((gate) => ['passed', 'blocked', 'not-run'].includes(gate.status))).toBe(true)
    }
  })

  it('keeps the current release proof visibly blocked instead of simulating trusted Harness evidence', () => {
    const allGates = acceptanceScenarios.flatMap((scenario) => scenario.gates)
    expect(allGates.filter((gate) => gate.id === 'harness-provenance').every((gate) => gate.status === 'blocked')).toBe(true)
    expect(allGates.filter((gate) => gate.id === 'browser-codex-chrome').every((gate) => gate.status === 'not-run')).toBe(true)
    expect(allGates.filter((gate) => gate.id === 'real-model-api').every((gate) => gate.status === 'not-run')).toBe(true)
    expect(allGates.filter((gate) => gate.id === 'native-macos-architectures').every((gate) => gate.status === 'not-run')).toBe(true)
    expect(allGates.filter((gate) => gate.id === 'postgresql-artifacts').every((gate) => gate.status === 'blocked')).toBe(true)
  })

  it('executes the MySQL preservation contract against an injected deterministic executor', async () => {
    const scenario = acceptanceScenarios.find((candidate) => candidate.id === 'existing-mysql-preservation')!
    const evidence = await executeAcceptanceScenario(scenario, createInMemoryAcceptanceExecutor())

    expect(evidence.status).toBe('blocked')
    expect(evidence.executedStepIds).toEqual(scenario.steps.map((step) => step.id))
    expect(evidence.phaseEvidence).toEqual(scenario.expected.phases)
    expect(evidence.effectEvidence).toContainEqual(expect.objectContaining({ type: 'workspace', target: 'approved-application-files', constraint: 'approved-write-only', subject: 'write only approved application files' }))
    expect(evidence.assertionEvidence).toContain('forbidden:replace MySQL')
    expect(evidence.cleanupEvidence.map((item) => item.assertionId)).toEqual(scenario.cleanup.assertions.map((assertion) => assertion.id))
  })

  it('preserves scenario-specific recovery and provenance constraints', () => {
    const recovery = acceptanceScenarios.find((candidate) => candidate.id === 'cross-phase-recovery')!
    const provenance = acceptanceScenarios.find((candidate) => candidate.id === 'untrusted-harness-provenance')!

    expect(recovery.initialState.workspace.kind).toBe('matrix')
    expect(recovery.expected.effects.forbidden.map((effect) => effect.subject)).toContain('use stale approval')
    expect(provenance.expected.phases).toEqual(['DISCOVER'])
    expect(provenance.expected.effects.permitted.map((effect) => effect.subject)).toContain('expose read-only diagnostic status and explicit blocked reason')
    expect(provenance.expected.effects.forbidden.map((effect) => effect.subject)).toContain('register production actions')
  })

  it('keeps each approved scenario bound to a typed effect and cleanup constraint', () => {
    const required = [
      ['natural-language-new-backend', 'permitted', 'workspace', 'realpath-under-workspace'],
      ['natural-language-new-backend', 'forbidden', 'network', 'never-deploy'],
      ['existing-postgresql-project', 'permitted', 'database', 'preserve-postgresql-orm'],
      ['existing-postgresql-project', 'forbidden', 'file', 'preserve-bytes'],
      ['existing-mysql-preservation', 'permitted', 'database', 'preserve-mysql-orm'],
      ['existing-mysql-preservation', 'forbidden', 'database', 'never-replace'],
      ['cross-phase-recovery', 'permitted', 'workspace', 'no-duplicate-side-effects'],
      ['cross-phase-recovery', 'forbidden', 'workspace', 'reject-stale'],
      ['expert-subagent-bounds', 'permitted', 'agent', 'within-depth-and-concurrency-budget'],
      ['expert-subagent-bounds', 'forbidden', 'agent', 'deny-unbudgeted-work'],
      ['production-outside-workspace-blocking', 'permitted', 'report', 'denied-action-recorded'],
      ['production-outside-workspace-blocking', 'forbidden', 'network', 'deny-unapproved-external-network'],
      ['dbgate-to-migration', 'permitted', 'listener', 'loopback-only'],
      ['dbgate-to-migration', 'forbidden', 'database', 'review-before-apply'],
      ['no-docker-global-pollution', 'permitted', 'workspace', 'realpath-under-workspace'],
      ['no-docker-global-pollution', 'forbidden', 'snapshot', 'no-global-pollution'],
      ['untrusted-harness-provenance', 'permitted', 'report', 'read-only-block-reason'],
      ['untrusted-harness-provenance', 'forbidden', 'agent', 'no-production-agent-start'],
      ['macos-arm64-x64', 'permitted', 'report', 'checksummed-per-architecture'],
      ['macos-arm64-x64', 'forbidden', 'process', 'native-architecture-match'],
    ] as const
    for (const [id, expectation, type, constraint] of required) {
      const scenario = acceptanceScenarios.find((candidate) => candidate.id === id)!
      const effects = expectation === 'permitted' ? scenario.expected.effects.permitted : scenario.expected.effects.forbidden
      expect(effects.some((effect) => effect.type === type && effect.constraint === constraint)).toBe(true)
    }
    const requiredCleanup = [
      ['natural-language-new-backend', 'temporary-processes', 'stopped'],
      ['existing-postgresql-project', 'user-dirty-files', 'byte-identical'],
      ['existing-mysql-preservation', 'mysql-configuration', 'byte-identical'],
      ['cross-phase-recovery', 'profile-row', 'single-row'],
      ['expert-subagent-bounds', 'parent-child-handoffs', 'no-orphans'],
      ['production-outside-workspace-blocking', 'attack-targets', 'unchanged'],
      ['dbgate-to-migration', 'DbGate', 'removed'],
      ['no-docker-global-pollution', 'host-snapshot', 'no-global-pollution'],
      ['untrusted-harness-provenance', 'target-workspace', 'unchanged'],
      ['macos-arm64-x64', 'host-snapshot', 'no-global-pollution'],
    ] as const
    for (const [id, target, constraint] of requiredCleanup) {
      const scenario = acceptanceScenarios.find((candidate) => candidate.id === id)!
      expect(scenario.cleanup.assertions.some((assertion) => assertion.observed.target === target && assertion.observed.constraint === constraint)).toBe(true)
    }
  })

  it('reports Step 2 as blocked until the production Bundle/Profile/model/browser adapter is wired', async () => {
    const scenario = acceptanceScenarios[0]!
    await expect(executeAcceptanceScenario(scenario, createUnwiredAcceptanceExecutor())).rejects.toMatchObject({ code: 'UNWIRED_ACCEPTANCE_EXECUTOR' })
  })

  it('runs every cleanup and retains observed cleanup evidence after an execution failure', async () => {
    const scenario = acceptanceScenarios[0]!
    const cleanup: string[] = []
    const failingExecutor = {
      prepare: async () => {},
      execute: async () => { throw new Error('injected step failure') },
      assert: async () => {},
      cleanup: async (assertion: CleanupAssertion) => { cleanup.push(assertion.id); return { assertionId: assertion.id, observed: assertion.observed } },
    }
    await expect(executeAcceptanceScenario(scenario, failingExecutor)).rejects.toMatchObject({ code: 'ACCEPTANCE_EXECUTION_FAILED', cleanupEvidence: scenario.cleanup.assertions.map((assertion) => expect.objectContaining({ assertionId: assertion.id })) })
    expect(cleanup).toEqual(scenario.cleanup.assertions.map((assertion) => assertion.id))
  })

  it('rejects cleanup evidence that does not match the declared observation', async () => {
    const scenario = acceptanceScenarios[0]!
    const base = createInMemoryAcceptanceExecutor()
    const forgedCleanupExecutor = {
      ...base,
      cleanup: async (assertion: typeof scenario.cleanup.assertions[number]) => ({
        assertionId: assertion.id,
        observed: { type: 'workspace' as const, target: 'forged-target', constraint: 'forged' },
      }),
    }
    await expect(executeAcceptanceScenario(scenario, forgedCleanupExecutor)).rejects.toMatchObject({ code: 'ACCEPTANCE_EXECUTION_FAILED' })
  })

  it('rejects a passed gate without traceable machine evidence', () => {
    expect(() => createE2eGate({ id: 'browser-codex-chrome', status: 'passed', reason: 'trust me' })).toThrow('evidenceRef')
    expect(createE2eGate({ id: 'browser-codex-chrome', status: 'passed', reason: 'recorded', evidenceRef: 'artifacts/browser/run-1.json' })).toMatchObject({ status: 'passed', evidenceRef: 'artifacts/browser/run-1.json' })
  })
})
