import type { BackendTeamEvent } from '@dsh-backend-team/contracts'
import { BackendTeamControlService } from './control-service.js'
import type { LocalSessionAuthenticator } from './control-service.js'
import type { CoordinatorControlPort } from './coordinator-control-port.js'
import { BackendTeamViewProjector, type ViewProjectorOptions } from './view-model.js'
import { SubscriptionHub } from './subscription-hub.js'

export interface BackendTeamEventFeed {
  read(): Promise<readonly BackendTeamEvent[]>
  subscribe(subscriber: (event: BackendTeamEvent) => void | Promise<void>): () => void
}

export interface BackendTeamControlSurfaceOptions extends Omit<ViewProjectorOptions, 'workspaceName'> {
  readonly workspaceName: string
  readonly events: BackendTeamEventFeed
  readonly coordinator: CoordinatorControlPort
  readonly authenticator: LocalSessionAuthenticator
  /** Optional durable revision source used when the event projection lags state storage. */
  readonly currentRevision?: () => number | Promise<number>
}

export interface BackendTeamControlSurface {
  readonly projector: BackendTeamViewProjector
  readonly subscriptions: SubscriptionHub
  readonly service: BackendTeamControlService
  readonly dispose: () => Promise<void>
}

/**
 * Compose the persisted event feed, read model, subscriptions, and authenticated
 * control service. The event subscription is installed before replay; events
 * arriving during the initial read are buffered and replayed in sequence order.
 */
export async function createBackendTeamControlSurface(options: BackendTeamControlSurfaceOptions): Promise<BackendTeamControlSurface> {
  const projector = new BackendTeamViewProjector(options)
  const subscriptions = new SubscriptionHub()
  let bootstrapping = true
  const pending: BackendTeamEvent[] = []
  const unsubscribe = options.events.subscribe((event) => {
    if (bootstrapping) {
      pending.push(event)
      return
    }
    project(projector, subscriptions, event)
  })
  let unsubscribeDatabase: (() => void) | undefined
  let unsubscribeDevelopment: (() => void) | undefined
  let unsubscribeApprovals: (() => void) | undefined
  try {
    unsubscribeDatabase = options.databaseFeed?.subscribe(() => { if (!bootstrapping) subscriptions.publish(projector.snapshot(), true) })
    unsubscribeDevelopment = options.developmentRun?.subscribe(() => { if (!bootstrapping) subscriptions.publish(projector.snapshot(), true) })
    unsubscribeApprovals = options.approvals?.subscribe(() => {
      if (!bootstrapping) subscriptions.publish(projector.snapshot(), true)
    })
    const persisted = await options.events.read()
    projector.replay([...persisted, ...pending])
    bootstrapping = false
  } catch (error: unknown) {
    unsubscribe()
    unsubscribeDatabase?.()
    unsubscribeApprovals?.()
      unsubscribeDevelopment?.()
    throw error
  }
  const service = new BackendTeamControlService(projector, options.coordinator, options.authenticator, options.currentRevision)
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    disposal = service.closeAndDrain().then(() => {
      bootstrapping = false
      unsubscribe()
      unsubscribeDatabase?.()
      unsubscribeApprovals?.()
      unsubscribeDevelopment?.()
      subscriptions.dispose()
    })
    return disposal
  }
  return Object.freeze({ projector, subscriptions, service, dispose })
}

function project(projector: BackendTeamViewProjector, subscriptions: SubscriptionHub, event: BackendTeamEvent): void {
  const result = projector.replay([event])
  if (result.appliedEventIds.length > 0) subscriptions.publish(projector.snapshot())
}
