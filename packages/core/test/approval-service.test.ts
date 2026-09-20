import type { ApprovalDecision, BackendTeamOrchestrationPort, BackendTeamState, StateStore } from '@dsh-backend-team/contracts'
import { describe, expect, it } from 'vitest'
import { ApprovalService, type ArtifactRegistryPort, type ArtifactValidationResult } from '../src/approval-service.js'
import { ControlMediatedApprovalPort } from '../src/control-mediated-approval-port.js'

const hashes = {
  'spec.md': 'a'.repeat(64),
  'clarification.md': 'b'.repeat(64),
}

describe('ApprovalService', () => {
  it('allows a control caller to await completion of the approval transaction', async () => {
    const fixture = createSettlementFixture()
    const service = new ApprovalService({
      stateStore: fixture.store,
      artifactRegistry: fixture.registry,
      artifactValidator: fixture.validator,
      orchestration: fixture.orchestration,
      settlement: fixture.approvals,
    })
    const servicePromise = service.requestRequirementsApproval()
    const pending = await waitForPending(fixture.approvals)
    const decisionPromise = fixture.approvals.decideAndWait(pending.id, { effect: 'approve', reason: 'approved' }, pending.artifactHash, pending.stateRevision)

    await fixture.transactionStarted
    let settled = false
    void decisionPromise.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    fixture.releaseTransaction()
    await expect(servicePromise).resolves.toMatchObject({ phase: 'DESIGN', revision: 1 })
    await expect(decisionPromise).resolves.toBeUndefined()
  })

  it('drains the real in-flight state transaction before closing approvals', async () => {
    const fixture = createSettlementFixture()
    const service = new ApprovalService({ stateStore: fixture.store, artifactRegistry: fixture.registry, artifactValidator: fixture.validator, orchestration: fixture.orchestration, settlement: fixture.approvals })
    const servicePromise = service.requestRequirementsApproval()
    const pending = await waitForPending(fixture.approvals)
    const decisionPromise = fixture.approvals.decideAndWait(pending.id, { effect: 'approve', reason: 'approved' }, pending.artifactHash, pending.stateRevision)
    await fixture.transactionStarted
    let closed = false
    const closing = fixture.approvals.closeAndDrain().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(await fixture.store.load()).toMatchObject({ revision: 0 })
    fixture.releaseTransaction()
    await Promise.all([servicePromise, decisionPromise, closing])
    expect(closed).toBe(true)
    expect(await fixture.store.load()).toMatchObject({ phase: 'DESIGN', revision: 1 })
  })

  it.each(['rejection', 'changed artifacts', 'transaction failure'] as const)('settles %s without advancing state and reports only actual failures to control', async (failure) => {
    const fixture = createSettlementFixture()
    const registry = { snapshot: () => hashes as Readonly<Record<string, string>> }
    const store = failure === 'transaction failure'
      ? { ...fixture.store, transact: async () => { throw new Error('storage unavailable') } }
      : fixture.store
    const service = new ApprovalService({ stateStore: store, artifactRegistry: registry, artifactValidator: fixture.validator, orchestration: fixture.orchestration, settlement: fixture.approvals })
    const serviceResult = service.requestRequirementsApproval().catch((error: unknown) => error)
    const pending = await waitForPending(fixture.approvals)
    if (failure === 'changed artifacts') registry.snapshot = () => ({ ...hashes, 'spec.md': 'c'.repeat(64) })
    const decisionResult = fixture.approvals.decideAndWait(pending.id, { effect: failure === 'rejection' ? 'reject' : 'approve', reason: 'needs edits' }, pending.artifactHash, pending.stateRevision).catch((error: unknown) => error)
    const error = await serviceResult
    expect(error).toBeInstanceOf(Error)
    expect(await decisionResult).toBe(failure === 'rejection' ? undefined : error)
    expect(await fixture.store.load()).toMatchObject({ phase: 'AWAIT_REQUIREMENTS_APPROVAL', revision: 0, approvals: [] })
    expect(fixture.approvals.listPending()).toEqual([])
  })

  it('persists an approved hash-bound requirements record and advances in one transaction', async () => {
    const fixture = createFixture()
    const service = new ApprovalService(fixture.store, fixture.registry, fixture.validator, fixture.orchestration)

    const next = await service.requestRequirementsApproval()

    expect(fixture.request).toMatchObject({ kind: 'requirements', artifactHashes: hashes })
    expect(next.phase).toBe('DESIGN')
    expect(next.approvals).toHaveLength(1)
    expect(next.approvals[0]).toMatchObject({ kind: 'requirements', artifactHashes: hashes })
    expect(next.approvals[0]!.tokenId).toHaveLength(36)
  })

  it('persists authenticated approval provenance together with the document hashes', async () => {
    const taskId = '11111111-1111-4111-8111-111111111111'
    const fixture = createFixture({ decision: { effect: 'approve', reason: 'approved', provenance: { sessionId: 'session-approval-123456', taskId } } })
    const service = new ApprovalService(fixture.store, fixture.registry, fixture.validator, fixture.orchestration)

    const next = await service.requestRequirementsApproval()

    expect(next.approvals[0]).toMatchObject({
      kind: 'requirements',
      artifactHashes: hashes,
      provenance: { sessionId: 'session-approval-123456', taskId },
    })
  })

  it('does not mutate state when the user rejects an approval', async () => {
    const fixture = createFixture({ decision: { effect: 'reject', reason: 'needs edits' } })
    const service = new ApprovalService(fixture.store, fixture.registry, fixture.validator, fixture.orchestration)

    await expect(service.requestRequirementsApproval()).rejects.toThrow('approval rejected')
    expect(await fixture.store.load()).toMatchObject({ phase: 'AWAIT_REQUIREMENTS_APPROVAL', approvals: [] })
  })

  it('rejects a stale active approval when an approved artifact changes', async () => {
    const fixture = createFixture()
    const service = new ApprovalService(fixture.store, fixture.registry, fixture.validator, fixture.orchestration)
    await service.requestRequirementsApproval()
    fixture.registry.current = { ...hashes, 'spec.md': 'c'.repeat(64) }

    await expect(service.verifyActiveApproval('requirements')).rejects.toThrow('approval is stale')
  })

  it('rejects a stale active approval when a new artifact appears', async () => {
    const fixture = createFixture()
    const service = new ApprovalService(fixture.store, fixture.registry, fixture.validator, fixture.orchestration)
    await service.requestRequirementsApproval()
    fixture.registry.current = { ...hashes, 'new.md': 'd'.repeat(64) }

    await expect(service.verifyActiveApproval('requirements')).rejects.toThrow('approval is stale')
  })

  it.each(['architecture.md', 'contracts/openapi.yaml', 'specs/feature/contracts/openapi.yaml'])('keeps requirements approval valid when design artifact %s is added', async (path) => {
    const fixture = createFixture()
    const service = new ApprovalService(fixture.store, fixture.registry, fixture.validator, fixture.orchestration)
    await service.requestRequirementsApproval()
    fixture.registry.current = { ...hashes, [path]: 'd'.repeat(64) }

    await expect(service.verifyActiveApproval('requirements')).resolves.toBeUndefined()
  })

  it('accepts the feature-artifact snapshot shape from spec-workflow', async () => {
    const fixture = createFixture()
    fixture.registry.snapshot = () => ({
      featureDirectory: '/workspace/specs/001-orders',
      artifacts: Object.entries(hashes).map(([path, sha256]) => ({ path, sha256 })),
    })
    const service = new ApprovalService(fixture.store, fixture.registry, fixture.validator, fixture.orchestration)

    await expect(service.requestRequirementsApproval()).resolves.toMatchObject({ phase: 'DESIGN' })
  })

  it('does not persist an approval if artifacts change while the user is deciding', async () => {
    const fixture = createFixture({ onRequest: () => { fixture.registry.current = { ...hashes, 'spec.md': 'c'.repeat(64) } } })
    const service = new ApprovalService(fixture.store, fixture.registry, fixture.validator, fixture.orchestration)

    await expect(service.requestRequirementsApproval()).rejects.toThrow('artifacts changed')
    expect(await fixture.store.load()).toMatchObject({ phase: 'AWAIT_REQUIREMENTS_APPROVAL', approvals: [] })
  })

  it('forwards the current state revision into the approval boundary', async () => {
    const fixture = createFixture({ initialRevision: 7 })
    const service = new ApprovalService(fixture.store, fixture.registry, fixture.validator, fixture.orchestration)

    await service.requestRequirementsApproval()

    expect(fixture.request.stateRevision).toBe(7)
  })
})

function createFixture(options: { decision?: ApprovalDecision; onRequest?: () => void; initialRevision?: number } = {}) {
  let state = initialState()
  state = { ...state, revision: options.initialRevision ?? state.revision }
  const request: { kind?: string; artifactHashes?: Readonly<Record<string, string>>; stateRevision?: number } = {}
  const registry: ArtifactRegistryPort & { current: Readonly<Record<string, string>> } = {
    current: hashes,
    snapshot: () => registry.current,
  }
  const validator: { validateForGate: () => ArtifactValidationResult } = {
    validateForGate: () => ({ errors: [] }),
  }
  const orchestration: Pick<BackendTeamOrchestrationPort, 'requestApproval'> = {
    requestApproval: async (approval, context) => {
      request.kind = approval.kind
      request.artifactHashes = approval.artifactHashes
      request.stateRevision = context?.stateRevision
      options.onRequest?.()
      return options.decision ?? { effect: 'approve', reason: 'approved' }
    },
  }
  const store: StateStore = {
    load: async () => state,
    create: async (initial) => { state = initial },
    transact: async (expectedRevision, change) => {
      if (state.revision !== expectedRevision) throw new Error('revision conflict')
      state = { ...change(state), revision: state.revision + 1 }
      return state
    },
  }
  return { store, registry, validator, orchestration, request }
}

function initialState(): BackendTeamState {
  return {
    schemaVersion: 1,
    revision: 0,
    workspaceRoot: '/tmp/backend-team-approval-test',
    phase: 'AWAIT_REQUIREMENTS_APPROVAL',
    runs: [],
    approvals: [],
    approvalTokens: [],
  }
}

function createSettlementFixture() {
  let state = initialState()
  let releaseTransaction!: () => void
  let transactionStartedResolve!: () => void
  const transactionStarted = new Promise<void>((resolve) => { transactionStartedResolve = resolve })
  const transactionGate = new Promise<void>((resolve) => { releaseTransaction = resolve })
  const registry: ArtifactRegistryPort = { snapshot: () => hashes }
  const validator: { validateForGate: () => ArtifactValidationResult } = { validateForGate: () => ({ valid: true }) }
  const approvals = new ControlMediatedApprovalPort('/workspace')
  const orchestration: Pick<BackendTeamOrchestrationPort, 'requestApproval'> = {
    requestApproval: (request, context) => approvals.requestApproval(request, { workspaceId: '/workspace', stateRevision: context?.stateRevision ?? 0 }),
  }
  const store: StateStore = {
    load: async () => state,
    create: async (initial) => { state = initial },
    transact: async (expectedRevision, change) => {
      if (state.revision !== expectedRevision) throw new Error('revision conflict')
      transactionStartedResolve()
      await transactionGate
      state = { ...change(state), revision: state.revision + 1 }
      return state
    },
  }
  return { store, registry, validator, orchestration, approvals, transactionStarted, releaseTransaction }
}

async function waitForPending(approvals: ControlMediatedApprovalPort) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const pending = approvals.listPending()[0]
    if (pending !== undefined) return pending
    await Promise.resolve()
  }
  throw new Error('approval request was not created')
}
