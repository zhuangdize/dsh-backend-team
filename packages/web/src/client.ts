/**
 * Public Web Client entry. The concrete Host supplies ClientContext and React;
 * this package keeps the browser half free of Node/process/filesystem access.
 * The structural contracts mirror the pinned rc.6 client declarations so this
 * entry can be type-checked without bundling a second Harness runtime.
 */
export interface ClientSessionEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data?: { readonly teamId?: string; readonly title?: string; readonly phase?: string; readonly status?: 'running' | 'completed' | 'blocked' }
  readonly ignorable?: true
}
export interface ClientConversationMatch {
  readonly event: ClientSessionEvent
  readonly view: unknown
  readonly role: 'start' | 'update'
  readonly location: ConversationLocation
}
export interface ClientConversationNodeContext<State = unknown> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly matches: readonly ClientConversationMatch[]
  readonly start: ClientConversationMatch | undefined
  readonly state: State | undefined
  readonly current: ReadonlyMap<string, unknown>
}
export interface ClientConversationPreviousContext<State = unknown> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly startSeq: number
  readonly state: Readonly<State>
  readonly matches: readonly ClientConversationMatch[]
}
export interface ClientConversationContextReader {
  previous<State>(kind: string): ClientConversationPreviousContext<State> | undefined
}
export interface ClientConversationNodeDefinition<State = unknown> {
  readonly kind: string
  readonly target?: string
  match(event: ClientSessionEvent): { readonly id: string; readonly role: 'start' | 'update' } | null
  start(context: ClientConversationNodeContext<State>, match: ClientConversationMatch, reader: ClientConversationContextReader): State
  update(context: ClientConversationNodeContext<State> & { readonly state: State }, match: ClientConversationMatch): State
  publication?(match: ClientConversationMatch): 'none' | 'animation-frame' | 'immediate'
  buildViewNode?(context: ClientConversationNodeContext<State>): unknown | null
}
export interface ClientConversationEvents { register(definition: ClientConversationNodeDefinition): () => void }
export type ClientSlotDisposer = () => void
export type ClientSlotInjectionEffect = ClientSlotDisposer | Iterable<ClientSlotDisposer>
export interface ClientSlots {
  inject(name: string, factory: () => ClientSlotInjectionEffect): ClientSlotDisposer
  register(definition: { name: string; key?: string; id?: string; order?: number; label?: string; priority?: number; children?: Record<string, { kind: string; scope: string }>; select?: (props: unknown) => unknown }, view: (props: unknown) => unknown): ClientSlotDisposer
}
export type ClientOverlayRenderer = (props: unknown) => unknown
export interface ClientContext { readonly conversationEvents: ClientConversationEvents; readonly slots: ClientSlots; readonly backendTeamOverlayRenderer?: ClientOverlayRenderer; readonly get?: (key: string) => unknown }
interface BackendTeamNodeState { readonly title: string; readonly phase: string; readonly status: 'running' | 'completed' | 'blocked' }
interface ConversationLocation { readonly kind: 'session' | 'unresolved' | 'turn' | 'step'; readonly [key: string]: unknown }
export const inject = ['slots', 'conversationEvents'] as const
export const backendTeamConversationDefinition: ClientConversationNodeDefinition<BackendTeamNodeState> = {
  kind: 'backend-team', target: 'chat',
  match: (event: ClientSessionEvent) => {
    if ((event.type !== 'backend-team/start' && event.type !== 'backend-team/update') || typeof event.data?.teamId !== 'string' || event.data.teamId.length === 0) return null
    return { id: event.data.teamId, role: event.type.endsWith('/start') ? 'start' : 'update' }
  },
  start: (_context: ClientConversationNodeContext<BackendTeamNodeState>, match: ClientConversationMatch, reader: ClientConversationContextReader): BackendTeamNodeState => { void reader; return { title: match.event.data?.title ?? '后端开发任务', phase: match.event.data?.phase ?? 'DISCOVER', status: 'running' } },
  update: (context: ClientConversationNodeContext<BackendTeamNodeState> & { readonly state: BackendTeamNodeState }, match: ClientConversationMatch): BackendTeamNodeState => ({ ...context.state, phase: match.event.data?.phase ?? context.state.phase, status: match.event.data?.status ?? context.state.status }),
  publication: () => 'immediate' as const,
  buildViewNode: (context: ClientConversationNodeContext<BackendTeamNodeState>) => context.state === undefined ? null : ({ key: context.key, kind: 'backend-team', id: context.id, target: 'chat', anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0, location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }, visibility: 'visible', data: context.state }),
}
export function apply(context: ClientContext, overlayRenderer: ClientOverlayRenderer | undefined = context.backendTeamOverlayRenderer): () => void {
  const conversationDispose = context.conversationEvents.register(backendTeamConversationDefinition)
  let disposed = false
  let slotDispose: (() => void) | undefined
  const injectDispose = context.slots.inject('conversation.chat.node', () => {
    if (disposed) return () => undefined
    slotDispose ??= context.slots.register({ name: 'conversation.chat.node', key: 'backend-team' }, (props: unknown) => {
      const node = (props as { node?: { data?: BackendTeamNodeState } }).node
      return node?.data?.title ?? '后端开发任务'
    })
    return slotDispose
  })
  let overlayDispose: (() => void) | undefined
  const overlayInjectDispose = context.slots.inject('conversation.view', () => {
    if (disposed) return () => undefined
    overlayDispose ??= context.slots.register({ name: 'conversation.view', id: 'backend-team-panel', order: 80, label: '团队进度' }, overlayRenderer ?? (() => null))
    return overlayDispose
  })
  return () => {
    if (disposed) return
    disposed = true
    overlayDispose?.()
    overlayInjectDispose()
    slotDispose?.()
    injectDispose()
    conversationDispose()
  }
}
