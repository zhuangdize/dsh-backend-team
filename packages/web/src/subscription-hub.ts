import type { BackendTeamViewState } from './view-model.js'
export type ViewSubscriber = (state: BackendTeamViewState) => void | Promise<void>
interface Subscription { readonly id: string; readonly send: ViewSubscriber; pending: BackendTeamViewState | undefined; delivering: boolean; lastDelivered: number }
export class SubscriptionHub {
  private readonly subscriptions = new Map<string, Subscription>()
  private closed = false
  subscribe(id: string, send: ViewSubscriber, initial: BackendTeamViewState): () => void {
    if (this.closed) throw new Error('subscription hub is closed')
    if (this.subscriptions.has(id)) throw new Error('subscription id already exists')
    const subscription: Subscription = { id, send, pending: undefined, delivering: false, lastDelivered: initial.lastSequence }
    this.subscriptions.set(id, subscription)
    void this.deliver(subscription, initial)
    return () => { if (this.subscriptions.get(id) === subscription) this.subscriptions.delete(id) }
  }
  publish(state: BackendTeamViewState, allowSameSequence = false): void { for (const subscription of this.subscriptions.values()) { if ((allowSameSequence ? state.lastSequence < subscription.lastDelivered : state.lastSequence <= subscription.lastDelivered) || (subscription.pending !== undefined && (allowSameSequence ? state.lastSequence < subscription.pending.lastSequence : state.lastSequence <= subscription.pending.lastSequence))) continue; subscription.pending = state; void this.flush(subscription) } }
  closeIdle(maxLastSequence: number): void { for (const [id, subscription] of this.subscriptions) if (!subscription.delivering && subscription.lastDelivered < maxLastSequence && subscription.pending === undefined) this.subscriptions.delete(id) }
  size(): number { return this.subscriptions.size }
  dispose(): void { this.closed = true; this.subscriptions.clear() }
  private async flush(subscription: Subscription): Promise<void> { if (subscription.delivering || subscription.pending === undefined) return; const next = subscription.pending; subscription.pending = undefined; await this.deliver(subscription, next); if (subscription.pending !== undefined) await this.flush(subscription) }
  private async deliver(subscription: Subscription, state: BackendTeamViewState): Promise<void> {
    if (this.subscriptions.get(subscription.id) !== subscription) return
    subscription.delivering = true
    try {
      await subscription.send(state)
      subscription.lastDelivered = state.lastSequence
    } catch {
      subscription.pending = undefined
      if (this.subscriptions.get(subscription.id) === subscription) this.subscriptions.delete(subscription.id)
    } finally {
      subscription.delivering = false
      if (this.subscriptions.get(subscription.id) === subscription && subscription.pending !== undefined) void this.flush(subscription)
    }
  }
}
