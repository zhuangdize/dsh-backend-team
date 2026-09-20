import { AsyncLocalStorage } from 'node:async_hooks'
import { BackendTeamControlActionSchema } from './control-actions.js'
import type { BackendTeamViewProjector, BackendTeamViewState } from './view-model.js'
import { isCoordinatorArtifactPreview, type CoordinatorControlPort, type CoordinatorControlResult } from './coordinator-control-port.js'
import { AuthenticatedLocalSessionSchema, type AuthenticatedLocalSession } from './remote-contract.js'

/** Host-owned identity boundary; schema validation alone is not authentication. */
export interface LocalSessionAuthenticator {
  authenticate(input: unknown): AuthenticatedLocalSession
}

export class ControlServiceError extends Error { constructor(readonly code: 'UNAUTHENTICATED' | 'STALE_VIEW' | 'READ_ONLY' | 'WORKSPACE_MISMATCH' | 'INVALID_NAVIGATION' | 'INVALID_ARTIFACT_PREVIEW' | 'UNAVAILABLE', readonly currentRevision?: number) { super(code); this.name = 'ControlServiceError' } }
export class BackendTeamControlService {
  private lifecycle: 'open' | 'closing' | 'closed' = 'open'
  private readonly activeDispatches = new Set<ActiveDispatch>()
  private readonly dispatchContext = new AsyncLocalStorage<ActiveDispatch>()
  private drainPromise: Promise<void> | undefined
  constructor(private readonly projector: BackendTeamViewProjector, private readonly coordinator: CoordinatorControlPort, private readonly authenticator: LocalSessionAuthenticator, private readonly currentRevision?: () => number | Promise<number>) {}
  getState(sessionInput: unknown): BackendTeamViewState {
    this.assertOpen()
    const session = this.session(sessionInput)
    const current = this.projector.snapshot()
    this.assertWorkspace(session, current)
    return current
  }
  async dispatch(sessionInput: unknown, input: unknown): Promise<CoordinatorControlResult> {
    this.assertOpen()
    const session = this.session(sessionInput); if (session.readOnly) throw new ControlServiceError('READ_ONLY')
    const current = this.projector.snapshot()
    this.assertWorkspace(session, current)
    if (current.compatibility.mode === 'read-only') throw new ControlServiceError('READ_ONLY')
    const action = BackendTeamControlActionSchema.parse(input); if (action.workspaceId !== session.workspaceId) throw new ControlServiceError('WORKSPACE_MISMATCH')
    const revision = this.currentRevision === undefined ? current.stateRevision : await readRevision(this.currentRevision)
    if (action.expectedRevision !== revision) throw new ControlServiceError('STALE_VIEW', revision)
    const operation = this.beginDispatch()
    try {
      const result = await this.dispatchContext.run(operation, () => this.coordinator.dispatch(action, { workspaceId: session.workspaceId, expectedRevision: action.expectedRevision, authenticatedSessionId: session.sessionId }))
      if (result.navigation !== undefined && (action.type !== 'open-database-gui' || !isLoopbackUrl(result.navigation.url))) throw new ControlServiceError('INVALID_NAVIGATION')
      if (!isCoordinatorArtifactPreview(result.artifactPreview, action)) throw new ControlServiceError('INVALID_ARTIFACT_PREVIEW')
      return result
    } finally {
      operation.finish()
    }
  }
  /** Reject new work and wait for already entered coordinator handlers. */
  closeAndDrain(): Promise<void> {
    if (this.drainPromise !== undefined) return this.drainPromise
    if (this.lifecycle !== 'open') return Promise.resolve()
    this.lifecycle = 'closing'
    // Snapshot only handlers already entered. The drain promise itself is
    // intentionally not part of this set, avoiding a self-wait cycle.
    const current = this.dispatchContext.getStore()
    const active = [...this.activeDispatches].filter((operation) => operation !== current).map((operation) => operation.promise)
    this.drainPromise = Promise.allSettled(active).then(() => {
      this.lifecycle = 'closed'
    })
    return this.drainPromise
  }
  private assertWorkspace(session: AuthenticatedLocalSession, state: BackendTeamViewState): void {
    if (state.workspaceId !== undefined && state.workspaceId !== session.workspaceId) throw new ControlServiceError('WORKSPACE_MISMATCH')
  }
  private assertOpen(): void {
    if (this.lifecycle !== 'open') throw new ControlServiceError('UNAVAILABLE')
  }
  private beginDispatch(): ActiveDispatch {
    let finish!: () => void
    const operation: ActiveDispatch = {
      promise: new Promise<void>((resolve) => {
        finish = () => {
          this.activeDispatches.delete(operation)
          resolve()
        }
      }),
      finish: () => finish(),
    }
    this.activeDispatches.add(operation)
    return operation
  }
  private session(input: unknown): AuthenticatedLocalSession {
    try {
      return AuthenticatedLocalSessionSchema.parse(this.authenticator.authenticate(input))
    } catch {
      throw new ControlServiceError('UNAUTHENTICATED')
    }
  }
}

async function readRevision(reader: () => number | Promise<number>): Promise<number> {
  const value = await reader()
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('control revision is invalid')
  return value
}

interface ActiveDispatch {
  readonly promise: Promise<void>
  readonly finish: () => void
}
function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.username === '' && url.password === '' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    return false
  }
}
