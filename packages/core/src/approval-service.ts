import { randomUUID } from 'node:crypto'
import type {
  BackendTeamOrchestrationPort,
  BackendTeamState,
  StateStore,
} from '@dsh-backend-team/contracts'
import { invalidateChangedArtifacts } from './artifact-invalidation.js'
import { assertTransition, phaseAfterApproval, phaseAwaitingApproval, phaseForArtifactPath, type ApprovalGate } from './state-machine.js'
import type { ApprovalSettlementPort } from './control-mediated-approval-port.js'

export interface ArtifactRegistryPort {
  snapshot(): ArtifactSnapshot | Readonly<Record<string, string>> | Promise<ArtifactSnapshot | Readonly<Record<string, string>>>
}

export interface ArtifactSnapshot {
  readonly featureDirectory?: string
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[]
}

export interface ArtifactValidationError {
  readonly code?: string
  readonly file?: string
  readonly heading?: string
  readonly message?: string
}

export interface ArtifactValidationResult {
  readonly valid?: boolean
  readonly errors?: readonly ArtifactValidationError[]
}

export interface ArtifactValidatorPort {
  validateForGate(gate: ApprovalGate): ArtifactValidationResult | Promise<ArtifactValidationResult>
}

export interface ApprovalServiceOptions {
  readonly stateStore: StateStore
  readonly artifactRegistry: ArtifactRegistryPort
  readonly artifactValidator: ArtifactValidatorPort
  readonly orchestration: Pick<BackendTeamOrchestrationPort, 'requestApproval'>
  /** Optional host settlement seam for revision-fenced control responses. */
  readonly settlement?: ApprovalSettlementPort
}

export class ApprovalService {
  private readonly stateStore: StateStore
  private readonly artifactRegistry: ArtifactRegistryPort
  private readonly artifactValidator: ArtifactValidatorPort
  private readonly orchestration: Pick<BackendTeamOrchestrationPort, 'requestApproval'>
  private readonly settlement: ApprovalSettlementPort | undefined

  constructor(options: ApprovalServiceOptions)
  constructor(
    stateStore: StateStore,
    artifactRegistry: ArtifactRegistryPort,
    artifactValidator: ArtifactValidatorPort,
    orchestration: Pick<BackendTeamOrchestrationPort, 'requestApproval'>,
  )
  constructor(
    optionsOrStateStore: ApprovalServiceOptions | StateStore,
    artifactRegistry?: ArtifactRegistryPort,
    artifactValidator?: ArtifactValidatorPort,
    orchestration?: Pick<BackendTeamOrchestrationPort, 'requestApproval'>,
  ) {
    if ('stateStore' in optionsOrStateStore) {
      this.stateStore = optionsOrStateStore.stateStore
      this.artifactRegistry = optionsOrStateStore.artifactRegistry
      this.artifactValidator = optionsOrStateStore.artifactValidator
      this.orchestration = optionsOrStateStore.orchestration
      this.settlement = optionsOrStateStore.settlement
    } else if (artifactRegistry !== undefined && artifactValidator !== undefined && orchestration !== undefined) {
      this.stateStore = optionsOrStateStore
      this.artifactRegistry = artifactRegistry
      this.artifactValidator = artifactValidator
      this.orchestration = orchestration
      this.settlement = undefined
    } else {
      throw new TypeError('ApprovalService dependencies are incomplete')
    }
  }

  requestRequirementsApproval(): Promise<BackendTeamState> {
    return this.requestApproval('requirements')
  }

  requestDesignApproval(): Promise<BackendTeamState> {
    return this.requestApproval('design')
  }

  async verifyActiveApproval(gate: ApprovalGate): Promise<void> {
    const state = await this.requireState()
    const approval = [...state.approvals].reverse().find((candidate) => candidate.kind === gate)
    if (approval === undefined) throw new Error(`${gate} approval is missing`)
    const current = await this.snapshot()
    if (!sameHashes(scopeArtifactHashes(gate, current), scopeArtifactHashes(gate, approval.artifactHashes))) throw new Error('approval is stale')
  }

  /** Return the same snapshot checked against both approvals, for task verification. */
  async verifiedDevelopmentArtifactHashes(): Promise<Readonly<Record<string, string>>> {
    const current = await this.snapshot()
    const state = await this.requireState()
    for (const gate of ['requirements', 'design'] as const) {
      const approval = [...state.approvals].reverse().find(candidate => candidate.kind === gate)
      if (approval === undefined) throw new Error(`${gate} approval is missing`)
      if (!sameHashes(scopeArtifactHashes(gate, current), scopeArtifactHashes(gate, approval.artifactHashes))) throw new Error('approval is stale')
    }
    return current
  }

  async invalidateChangedArtifacts(changedPaths: readonly string[]): Promise<BackendTeamState> {
    const current = await this.requireState()
    const next = invalidateChangedArtifacts(current, changedPaths)
    if (next === current) return current
    return this.stateStore.transact(current.revision, () => next)
  }

  /** Startup-only reconciliation, before any Agent or control request is admitted. */
  async reconcilePersistedApprovals(): Promise<void> {
    const state = await this.requireState()
    if (!state.approvals.some(approval => approval.kind === 'requirements' || approval.kind === 'design')) return
    const hashes = await this.snapshot()
    for (const gate of ['requirements', 'design'] as const) {
      const approval = [...state.approvals].reverse().find(candidate => candidate.kind === gate)
      if (approval === undefined || sameHashes(scopeArtifactHashes(gate, hashes), scopeArtifactHashes(gate, approval.artifactHashes))) continue
      // Rewind using the stale gate, including unknown input additions/removals.
      // The revision fence prevents overwriting a concurrent approval decision.
      await this.stateStore.transact(state.revision, current => invalidateChangedArtifacts(current, [gate === 'requirements' ? 'spec.md' : 'architecture.md']))
      return
    }
  }

  private async requestApproval(gate: ApprovalGate): Promise<BackendTeamState> {
    const current = await this.requireState()
    const waitingPhase = phaseAwaitingApproval(gate)
    if (current.phase !== waitingPhase) throw new Error(`cannot request ${gate} approval in phase ${current.phase}`)
    if (gate === 'design') await this.verifyActiveApproval('requirements')
    const validation = await this.artifactValidator.validateForGate(gate)
    if (!validationPassed(validation)) throw new Error(`${gate} artifacts are invalid`)
    const before = scopeArtifactHashes(gate, await this.snapshot())
    const request = {
      kind: gate,
      summary: gate === 'requirements' ? '请确认需求规格及验收条件' : '请确认实现方案与验收计划',
      artifactHashes: before,
    } as const
    try {
      const decisionPromise = this.orchestration.requestApproval(request, { stateRevision: current.revision })
      this.settlement?.waitForSettlement(request, current.revision)
      const decision = await decisionPromise
      if (decision.effect !== 'approve') {
        // Rejecting is a successful user action, but must stop the awaiting
        // workflow before it can enter the next phase.
        this.settlement?.completeSettlement(request)
        throw new Error(`approval rejected: ${decision.reason}`)
      }
      const after = scopeArtifactHashes(gate, await this.snapshot())
      if (!sameHashes(before, after)) throw new Error('artifacts changed before approval persistence')

      const approval = {
        kind: gate,
        artifactHashes: before,
        approvedAt: new Date().toISOString(),
        tokenId: randomUUID(),
        ...(decision.provenance === undefined ? {} : { provenance: decision.provenance }),
      } as const
      const target = phaseAfterApproval(gate)
      assertTransition(current.phase, target)
      const result = await this.stateStore.transact(current.revision, (state) => {
        if (state.phase !== waitingPhase) throw new Error(`approval phase changed to ${state.phase}`)
        return {
          ...state,
          phase: target,
          approvals: [...state.approvals.filter((candidate) => candidate.kind !== gate), approval],
        }
      })
      this.settlement?.completeSettlement(request)
      return result
    } catch (error: unknown) {
      this.settlement?.failSettlement(request, error)
      throw error
    }
  }

  private async requireState(): Promise<BackendTeamState> {
    const state = await this.stateStore.load()
    if (state === null) throw new Error('backend team state has not been created')
    return state
  }

  private async snapshot(): Promise<Readonly<Record<string, string>>> {
    const value = await this.artifactRegistry.snapshot()
    const entries: [string, string][] = isArtifactSnapshot(value)
      ? value.artifacts.map((artifact) => [artifact.path, artifact.sha256])
      : Object.entries(value)
    entries.sort(([left], [right]) => left.localeCompare(right))
    if (entries.length === 0 || entries.some(([path, hash]) => path.length === 0 || !/^[a-f0-9]{64}$/u.test(hash))) throw new Error('artifact registry snapshot is invalid')
    return Object.freeze(Object.fromEntries(entries))
  }
}

function isArtifactSnapshot(value: ArtifactSnapshot | Readonly<Record<string, string>>): value is ArtifactSnapshot {
  return typeof value === 'object' && value !== null && Array.isArray((value as { readonly artifacts?: unknown }).artifacts)
}

function validationPassed(result: ArtifactValidationResult): boolean {
  return result.valid === true || (result.valid === undefined && (result.errors?.length ?? 0) === 0)
}

function sameHashes(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  return leftEntries.length === rightEntries.length && leftEntries.every(([path, hash]) => right[path] === hash)
}

function scopeArtifactHashes(gate: ApprovalGate, hashes: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(hashes).filter(([path]) => {
    const phase = phaseForArtifactPath(path)
    if (phase === null) return true
    return gate === 'requirements' ? phase === 'SPECIFY' : phase === 'SPECIFY' || phase === 'DESIGN'
  })
  return Object.freeze(Object.fromEntries(entries))
}
