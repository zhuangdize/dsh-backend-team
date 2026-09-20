import { z } from 'zod'
import type { BackendTeamControlAction } from './control-actions.js'
import { BackendTeamControlActionSchema } from './control-actions.js'
import { createBackendTeamApprovalInteraction, createBackendTeamPanelModel } from './panel-model.js'
import type { BackendTeamApprovalInteraction, BackendTeamPanelApproval, BackendTeamPanelModel } from './panel-model.js'
import { isCoordinatorArtifactPreview, type CoordinatorArtifactPreview, type CoordinatorControlResult } from './coordinator-control-port.js'
import { BackendTeamViewStateSchema } from './view-model.js'
import type { BackendTeamViewState } from './view-model.js'

const NavigationSchema = z.object({
  kind: z.literal('one-time-local-url'),
  url: z.string().min(1),
  expiresAt: z.string().min(1),
}).strict()

const ArtifactPreviewSchema = z.object({
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
  files: z.array(z.object({ path: z.string().min(1), content: z.string() }).strict()).min(1).max(10),
}).strict()

const ControlResultSchema = z.object({
  accepted: z.literal(true),
  stateRevision: z.number().int().nonnegative(),
  navigation: NavigationSchema.optional(),
  artifactPreview: ArtifactPreviewSchema.optional(),
}).strict()

export interface BackendTeamControlTransport {
  getState(): Promise<unknown>
  dispatch(action: BackendTeamControlAction): Promise<unknown>
}

export interface BackendTeamControlClientOptions {
  readonly workspaceId: string
  readonly transport: BackendTeamControlTransport
}

export type BackendTeamControlClientErrorCode =
  | 'STATE_NOT_LOADED'
  | 'INVALID_STATE'
  | 'STALE_SNAPSHOT'
  | 'INVALID_ACTION'
  | 'WORKSPACE_MISMATCH'
  | 'STALE_VIEW'
  | 'NO_PENDING_APPROVAL'
  | 'APPROVAL_NOT_INSPECTED'
  | 'APPROVAL_MISMATCH'
  | 'INVALID_RESPONSE'

export class BackendTeamControlClientError extends Error {
  constructor(readonly code: BackendTeamControlClientErrorCode, readonly currentRevision?: number) {
    super(code)
    this.name = 'BackendTeamControlClientError'
  }
}

export interface BackendTeamControlDispatchResult {
  readonly response: CoordinatorControlResult
  readonly state: BackendTeamViewState
}

export interface BackendTeamControlClient {
  snapshot(): BackendTeamViewState | undefined
  model(): BackendTeamPanelModel | undefined
  applySnapshot(input: unknown): BackendTeamViewState
  refresh(): Promise<BackendTeamViewState>
  inspectApproval(): BackendTeamPanelApproval
  resetApproval(): BackendTeamPanelApproval
  dispatch(input: unknown): Promise<BackendTeamControlDispatchResult>
}

/**
 * Host-neutral browser bridge. It owns no credentials or network implementation;
 * the host transport is responsible for same-origin/session handling. The
 * server remains authoritative, while this client prevents stale or unseen
 * approval decisions from being sent accidentally.
 */
export function createBackendTeamControlClient(options: BackendTeamControlClientOptions): BackendTeamControlClient {
  if (typeof options.workspaceId !== 'string' || options.workspaceId.length === 0) throw new TypeError('workspaceId is required')
  if (options.transport === null || typeof options.transport !== 'object' || typeof options.transport.getState !== 'function' || typeof options.transport.dispatch !== 'function') throw new TypeError('control transport is required')

  let state: BackendTeamViewState | undefined
  let interaction: BackendTeamApprovalInteraction | undefined
  let interactionKey: string | undefined

  const setState = (next: BackendTeamViewState): void => {
    const approval = next.pendingApproval
    const nextKey = approval === undefined ? undefined : `${approval.id}:${approval.artifactHash}:${next.stateRevision}`
    if (nextKey !== interactionKey) {
      interaction = undefined
      interactionKey = nextKey
    }
    state = next
  }

  const acceptSnapshot = (next: BackendTeamViewState): BackendTeamViewState => {
    if (state?.taskId !== next.taskId) { interaction = undefined; interactionKey = undefined; state = undefined }
    if (state !== undefined && (next.lastSequence < state.lastSequence || next.stateRevision < state.stateRevision)) throw new BackendTeamControlClientError('STALE_SNAPSHOT', state.stateRevision)
    if (state !== undefined && next.lastSequence === state.lastSequence && next.stateRevision === state.stateRevision && JSON.stringify({ ...next, pendingApproval: undefined, developmentRun: undefined, database: undefined, taskHistory: undefined }) !== JSON.stringify({ ...state, pendingApproval: undefined, developmentRun: undefined, database: undefined, taskHistory: undefined })) throw new BackendTeamControlClientError('INVALID_STATE', state.stateRevision)
    setState(next)
    return next
  }

  const applySnapshot = (input: unknown): BackendTeamViewState => {
    const parsed = BackendTeamViewStateSchema.safeParse(input)
    if (!parsed.success) throw new BackendTeamControlClientError('INVALID_STATE', state?.stateRevision)
    return acceptSnapshot(parsed.data)
  }

  const refresh = async (): Promise<BackendTeamViewState> => applySnapshot(await options.transport.getState())

  const requireState = (): BackendTeamViewState => {
    if (state === undefined) throw new BackendTeamControlClientError('STATE_NOT_LOADED')
    return state
  }

  const requireInteraction = (): BackendTeamApprovalInteraction => {
    const current = requireState()
    if (current.pendingApproval === undefined) throw new BackendTeamControlClientError('NO_PENDING_APPROVAL')
    if (interaction === undefined) {
      interaction = createBackendTeamApprovalInteraction(current)
      interactionKey = `${current.pendingApproval.id}:${current.pendingApproval.artifactHash}:${current.stateRevision}`
    }
    return interaction
  }

  return Object.freeze({
    snapshot: () => state,
    model: () => {
      if (state === undefined) return undefined
      const model = createBackendTeamPanelModel(state)
      return model.approval === undefined || interaction === undefined ? model : { ...model, approval: interaction.snapshot() }
    },
    applySnapshot,
    refresh,
    inspectApproval: () => requireInteraction().inspect(),
    resetApproval: () => requireInteraction().reset(),
    dispatch: async (input: unknown): Promise<BackendTeamControlDispatchResult> => {
      const current = requireState()
      const parsedAction = BackendTeamControlActionSchema.safeParse(input)
      if (!parsedAction.success) throw new BackendTeamControlClientError('INVALID_ACTION', current.stateRevision)
      const action = parsedAction.data
      if (action.taskId !== current.taskId) throw new BackendTeamControlClientError('STALE_VIEW', current.stateRevision)
      if (action.workspaceId !== options.workspaceId) throw new BackendTeamControlClientError('WORKSPACE_MISMATCH', current.stateRevision)
      if (action.expectedRevision !== current.stateRevision) throw new BackendTeamControlClientError('STALE_VIEW', current.stateRevision)
      if (action.type === 'decide-approval') assertApproval(current, action.approvalId, action.artifactHash, action.expectedRevision, interaction)
      if (action.type === 'open-artifact') assertArtifactOpen(current, action.artifactId, action.expectedRevision)

      const parsedResult = ControlResultSchema.safeParse(await options.transport.dispatch(action))
      if (!parsedResult.success || parsedResult.data.stateRevision < action.expectedRevision || (parsedResult.data.navigation !== undefined && action.type !== 'open-database-gui') || (parsedResult.data.navigation !== undefined && !isLoopbackUrl(parsedResult.data.navigation.url)) || !isCoordinatorArtifactPreview(parsedResult.data.artifactPreview, action)) throw new BackendTeamControlClientError('INVALID_RESPONSE', current.stateRevision)
      const response: CoordinatorControlResult = parsedResult.data.navigation === undefined
        ? { accepted: true, stateRevision: parsedResult.data.stateRevision, ...(parsedResult.data.artifactPreview === undefined ? {} : { artifactPreview: parsedResult.data.artifactPreview as CoordinatorArtifactPreview }) }
        : { accepted: true, stateRevision: parsedResult.data.stateRevision, navigation: parsedResult.data.navigation, ...(parsedResult.data.artifactPreview === undefined ? {} : { artifactPreview: parsedResult.data.artifactPreview as CoordinatorArtifactPreview }) }
      const next = await refresh()
      if (next.stateRevision < response.stateRevision) throw new BackendTeamControlClientError('INVALID_RESPONSE', next.stateRevision)
      return { response, state: next }
    },
  })
}

function assertApproval(state: BackendTeamViewState, approvalId: string, artifactHash: string, expectedRevision: number, interaction: BackendTeamApprovalInteraction | undefined): void {
  const pending = state.pendingApproval
  if (pending === undefined || pending.id !== approvalId || pending.artifactHash !== artifactHash || expectedRevision !== state.stateRevision) throw new BackendTeamControlClientError('APPROVAL_MISMATCH', state.stateRevision)
  if (interaction === undefined || !interaction.snapshot().canConfirm) throw new BackendTeamControlClientError('APPROVAL_NOT_INSPECTED', state.stateRevision)
}

function assertArtifactOpen(state: BackendTeamViewState, artifactId: string, expectedRevision: number): void {
  const pending = state.pendingApproval
  if (pending === undefined || pending.artifactHash !== artifactId || expectedRevision !== state.stateRevision) throw new BackendTeamControlClientError('APPROVAL_MISMATCH', state.stateRevision)
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.username === '' && url.password === '' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    return false
  }
}
