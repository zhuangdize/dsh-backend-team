import { BackendTeamControlActionSchema } from './control-actions.js'
import type { BackendTeamControlAction } from './control-actions.js'
export interface CoordinatorControlContext { readonly workspaceId: string; readonly expectedRevision: number; readonly authenticatedSessionId: string }
export interface CoordinatorArtifactPreviewFile { readonly path: string; readonly content: string }
export interface CoordinatorArtifactPreview { readonly artifactHash: string; readonly files: readonly CoordinatorArtifactPreviewFile[] }
export type CoordinatorControlResult = { readonly accepted: true; readonly stateRevision: number; readonly navigation?: { readonly kind: 'one-time-local-url'; readonly url: string; readonly expiresAt: string }; readonly artifactPreview?: CoordinatorArtifactPreview }
export interface CoordinatorControlPort { dispatch(action: BackendTeamControlAction, context: CoordinatorControlContext): Promise<CoordinatorControlResult> }

export const COORDINATOR_ACTION_TYPES = Object.freeze([
  'submit-clarification',
  'decide-approval',
  'pause-run',
  'resume-run',
  'retry-failed-step',
  'open-artifact',
  'start-database',
  'stop-database',
  'open-database-gui',
  'prepare-database-migration',
  'create-database-snapshot',
  'restore-database-snapshot',
] as const)

type ActionType = (typeof COORDINATOR_ACTION_TYPES)[number]
type ActionOf<T extends ActionType> = Extract<BackendTeamControlAction, { readonly type: T }>
export type CoordinatorActionHandler<T extends ActionType> = (action: ActionOf<T>, context: CoordinatorControlContext) => Promise<CoordinatorControlResult>
export type CoordinatorCommandHandlers = { readonly [T in Exclude<ActionType, 'prepare-database-migration' | 'create-database-snapshot' | 'restore-database-snapshot'>]: CoordinatorActionHandler<T> } & { readonly 'prepare-database-migration'?: CoordinatorActionHandler<'prepare-database-migration'>; readonly 'create-database-snapshot'?: CoordinatorActionHandler<'create-database-snapshot'>; readonly 'restore-database-snapshot'?: CoordinatorActionHandler<'restore-database-snapshot'> }

/**
 * Routes browser commands to coordinator-owned handlers without owning state
 * or side effects itself. This is the only place where the discriminated
 * client action union is converted into coordinator commands.
 */
export class CoordinatorControlAdapter implements CoordinatorControlPort {
  private readonly handlers: CoordinatorCommandHandlers

  constructor(handlers: CoordinatorCommandHandlers) {
    this.handlers = validateHandlers(handlers)
  }

  async dispatch(input: BackendTeamControlAction, context: CoordinatorControlContext): Promise<CoordinatorControlResult> {
    const action = BackendTeamControlActionSchema.parse(input)
    if (action.workspaceId !== context.workspaceId) throw new Error('coordinator command workspace mismatch')
    if (action.expectedRevision !== context.expectedRevision) throw new Error('coordinator command revision mismatch')
    const handler = this.handlers[action.type] as CoordinatorActionHandler<typeof action.type>
    const result = await handler(action, context)
    if (result.accepted !== true || !Number.isSafeInteger(result.stateRevision) || result.stateRevision < 0 || !isCoordinatorArtifactPreview(result.artifactPreview, action)) throw new Error('coordinator command returned an invalid result')
    return result
  }
}

export function isCoordinatorArtifactPreview(value: unknown, action?: BackendTeamControlAction): value is CoordinatorArtifactPreview | undefined {
  if (value === undefined) return true
  if (action === undefined || action.type !== 'open-artifact' || typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const preview = value as Record<string, unknown>
  if (preview.artifactHash !== action.artifactId || typeof preview.artifactHash !== 'string' || !/^[a-f0-9]{64}$/u.test(preview.artifactHash)) return false
  if (!Array.isArray(preview.files) || preview.files.length === 0 || preview.files.length > 10) return false
  const paths = new Set<string>(); let total = 0
  for (const candidate of preview.files) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false
    const file = candidate as Record<string, unknown>
    if (typeof file.path !== 'string' || file.path.length === 0 || file.path.length > 4096 || file.path.startsWith('/') || file.path.startsWith('\\') || file.path.includes('\\') || file.path.includes('\0') || file.path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') || paths.has(file.path) || typeof file.content !== 'string') return false
    paths.add(file.path)
    total += new TextEncoder().encode(file.content).byteLength
    if (total > 1024 * 1024) return false
  }
  return true
}

function validateHandlers(input: CoordinatorCommandHandlers): CoordinatorCommandHandlers {
  if (typeof input !== 'object' || input === null) throw new TypeError('coordinator command handlers are required')
  const copy: Record<string, CoordinatorActionHandler<ActionType>> = {}
  for (const type of COORDINATOR_ACTION_TYPES) {
    let handler: unknown
    try { handler = Reflect.get(input, type) } catch { throw new TypeError(`coordinator handler is unavailable: ${type}`) }
    if (handler === undefined && type === 'prepare-database-migration') handler = async () => { throw new Error('database migration is not configured') }
    if (handler === undefined && type === 'create-database-snapshot') handler = async () => { throw new Error('database snapshot is not configured') }
    if (handler === undefined && type === 'restore-database-snapshot') handler = async () => { throw new Error('database snapshot restore is not configured') }
    if (typeof handler !== 'function') throw new TypeError(`coordinator handler is missing: ${type}`)
    copy[type] = handler as CoordinatorActionHandler<ActionType>
  }
  return Object.freeze(copy) as CoordinatorCommandHandlers
}
