import type { BackendTeamControlAction } from './control-actions.js'
import { isCoordinatorArtifactPreview, type CoordinatorControlContext, type CoordinatorCommandHandlers, type CoordinatorControlResult } from './coordinator-control-port.js'

type ActionType = BackendTeamControlAction['type']
type ActionOf<T extends ActionType> = Extract<BackendTeamControlAction, { readonly type: T }>

/** Optional effect returned by a real host operation (currently the DbGate URL). */
export interface CoordinatorCommandEffect {
  readonly navigation?: CoordinatorControlResult['navigation']
  readonly artifactPreview?: CoordinatorControlResult['artifactPreview']
}

export type CoordinatorCommandCallback<T extends ActionType> = (
  action: ActionOf<T>,
  context: CoordinatorControlContext,
) => CoordinatorCommandEffect | void | Promise<CoordinatorCommandEffect | void>

/**
 * Concrete side-effect seams supplied by the host/application composition.
 * This adapter deliberately owns no state, files, processes, database clients,
 * or navigation tokens; it only enforces the revision fence around those
 * injected operations.
 */
export interface CoordinatorCommandImplementations {
  readonly prepareDatabaseMigration?: CoordinatorCommandCallback<'prepare-database-migration'>
  readonly createDatabaseSnapshot?: CoordinatorCommandCallback<'create-database-snapshot'>
  readonly restoreDatabaseSnapshot?: CoordinatorCommandCallback<'restore-database-snapshot'>
  readonly currentRevision: () => number | Promise<number>
  readonly submitClarification: CoordinatorCommandCallback<'submit-clarification'>
  readonly decideApproval: CoordinatorCommandCallback<'decide-approval'>
  readonly pauseRun: CoordinatorCommandCallback<'pause-run'>
  readonly resumeRun: CoordinatorCommandCallback<'resume-run'>
  readonly retryFailedStep: CoordinatorCommandCallback<'retry-failed-step'>
  readonly openArtifact: CoordinatorCommandCallback<'open-artifact'>
  readonly startDatabase: CoordinatorCommandCallback<'start-database'>
  readonly stopDatabase: CoordinatorCommandCallback<'stop-database'>
  readonly openDatabaseGui: CoordinatorCommandCallback<'open-database-gui'>
}

/**
 * Builds the complete command table required by CoordinatorControlAdapter.
 * Every invocation rechecks the coordinator revision immediately before and
 * after the injected operation, so a stale browser snapshot cannot reach a
 * write/process/database implementation.
 */
export function createCoordinatorCommandHandlers(options: CoordinatorCommandImplementations): CoordinatorCommandHandlers {
  assertImplementations(options)
  return Object.freeze({
    'prepare-database-migration': (action, context) => run(options, action, context, options.prepareDatabaseMigration ?? (() => { throw new Error('database migration is not configured') })),
    'create-database-snapshot': (action, context) => run(options, action, context, options.createDatabaseSnapshot ?? (() => { throw new Error('database snapshot is not configured') })),
    'restore-database-snapshot': (action, context) => run(options, action, context, options.restoreDatabaseSnapshot ?? (() => { throw new Error('database snapshot restore is not configured') })),
    'submit-clarification': (action, context) => run(options, action, context, options.submitClarification),
    'decide-approval': (action, context) => run(options, action, context, options.decideApproval),
    'pause-run': (action, context) => run(options, action, context, options.pauseRun),
    'resume-run': (action, context) => run(options, action, context, options.resumeRun),
    'retry-failed-step': (action, context) => run(options, action, context, options.retryFailedStep),
    'open-artifact': (action, context) => run(options, action, context, options.openArtifact),
    'start-database': (action, context) => run(options, action, context, options.startDatabase),
    'stop-database': (action, context) => run(options, action, context, options.stopDatabase),
    'open-database-gui': (action, context) => run(options, action, context, options.openDatabaseGui),
  })
}

async function run<T extends ActionType>(
  options: CoordinatorCommandImplementations,
  action: ActionOf<T>,
  context: CoordinatorControlContext,
  callback: CoordinatorCommandCallback<T>,
): Promise<CoordinatorControlResult> {
  assertContext(action, context)
  const before = await readRevision(options.currentRevision)
  if (before !== action.expectedRevision) throw new Error(`stale coordinator revision: expected ${action.expectedRevision}, found ${before}`)
  const effect = await callback(action, context)
  const after = await readRevision(options.currentRevision)
  if (after < action.expectedRevision) throw new Error(`coordinator revision moved backwards: expected at least ${action.expectedRevision}, found ${after}`)
  if (effect === undefined) return { accepted: true, stateRevision: after }
  if (!isEffect(effect, action)) throw new Error('coordinator command returned an invalid effect')
  return {
    accepted: true,
    stateRevision: after,
    ...(effect.navigation === undefined ? {} : { navigation: effect.navigation }),
    ...(effect.artifactPreview === undefined ? {} : { artifactPreview: effect.artifactPreview }),
  }
}

async function readRevision(reader: CoordinatorCommandImplementations['currentRevision']): Promise<number> {
  const value = await reader()
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('coordinator revision is invalid')
  return value
}

function assertContext(action: BackendTeamControlAction, context: CoordinatorControlContext): void {
  if (context.workspaceId !== action.workspaceId) throw new Error('coordinator command workspace mismatch')
  if (context.expectedRevision !== action.expectedRevision) throw new Error('coordinator command revision mismatch')
  if (typeof context.authenticatedSessionId !== 'string' || context.authenticatedSessionId.trim().length === 0) throw new Error('coordinator command session is missing')
}

function isEffect(value: CoordinatorCommandEffect, action: BackendTeamControlAction): value is CoordinatorCommandEffect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'navigation' && key !== 'artifactPreview')) return false
  if (value.navigation !== undefined) {
    const navigation = value.navigation
    if (navigation.kind !== 'one-time-local-url' || typeof navigation.url !== 'string' || typeof navigation.expiresAt !== 'string') return false
    try {
      const url = new URL(navigation.url)
      if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]')) return false
    } catch {
      return false
    }
  }
  if (!isCoordinatorArtifactPreview(value.artifactPreview, action)) return false
  return true
}

function assertImplementations(value: CoordinatorCommandImplementations): void {
  if (typeof value !== 'object' || value === null) throw new TypeError('coordinator command implementations are required')
  if (typeof value.currentRevision !== 'function') throw new TypeError('coordinator currentRevision implementation is required')
  for (const key of ['submitClarification', 'decideApproval', 'pauseRun', 'resumeRun', 'retryFailedStep', 'openArtifact', 'startDatabase', 'stopDatabase', 'openDatabaseGui'] as const) {
    if (typeof value[key] !== 'function') throw new TypeError(`coordinator implementation is missing: ${key}`)
  }
}
