import { DevelopmentCoordinator, type DevelopmentCheckpoint, type DevelopmentCoordinatorOptions, type DevelopmentRunResult } from './development-coordinator.js'
import type { DevelopmentPlan } from './vertical-slice.js'
import type { DeliveryReview } from '@dsh-backend-team/contracts'

export interface DevelopmentRunSnapshot {
  readonly delivery?: DeliveryReview
  readonly message?: string
  readonly status: 'idle' | 'running' | 'pausing' | 'paused' | 'passed' | 'failed' | 'blocked'
}
export interface DevelopmentCheckpointStore {
  load(): Promise<DevelopmentCheckpoint | null>
  save(checkpoint: DevelopmentCheckpoint): Promise<void>
  /** Acquires the workspace-wide run lease for the complete run lifecycle. */
  acquireRun?(): Promise<() => Promise<void>>
}
export interface DevelopmentRunControllerOptions extends Omit<DevelopmentCoordinatorOptions, 'saveCheckpoint'> {
  readonly verifyFinal?: (plan: DevelopmentPlan, result: DevelopmentRunResult) => Promise<{ readonly status: 'passed' | 'failed' | 'blocked'; readonly message: string; readonly delivery?: DeliveryReview }>
  readonly initialSnapshot?: DevelopmentRunSnapshot
  readonly checkpoints: DevelopmentCheckpointStore
  readonly loadPlan: () => Promise<DevelopmentPlan>
  /** Host-serialized recovery of leases left by an ungraceful prior run. */
  readonly recoverAbandonedOwnership?: () => number | Promise<number>
  /** Clears a durable previous-run error immediately before an explicit retry. */
  readonly beforeResume?: () => void | Promise<void>
}

/** Owns background execution; control requests return promptly and observe real settlement. */
export class DevelopmentRunController {
  private readonly coordinator: DevelopmentCoordinator
  private state: DevelopmentRunSnapshot = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private active: Promise<void> | undefined
  private ready: Promise<void> | undefined
  private closed = false
  private pauseRequested = false

  constructor(private readonly options: DevelopmentRunControllerOptions) {
    this.state = structuredClone(options.initialSnapshot ?? { status: 'idle' })
    this.coordinator = new DevelopmentCoordinator({ ...options, saveCheckpoint: checkpoint => options.checkpoints.save(checkpoint) })
  }
  snapshot(): DevelopmentRunSnapshot { return structuredClone(this.state) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  async resume(): Promise<void> {
    if (this.closed) throw new Error('development controller is closed')
    if (this.active !== undefined) throw new Error('development is already running')
    await this.options.beforeResume?.()
    this.pauseRequested = false
    const ready = Promise.withResolvers<void>()
    this.ready = ready.promise
    const operation = Promise.resolve().then(() => this.run(ready))
    this.active = operation
    this.setState('running')
    void operation.finally(() => { if (this.active === operation) this.active = undefined }).catch(() => {})
    await ready.promise
  }

  async pause(): Promise<void> {
    if (this.closed) throw new Error('development controller is closed')
    if (this.active === undefined) throw new Error('development is not running')
    this.pauseRequested = true
    this.setState('pausing')
    await this.ready
    if (this.active !== undefined && this.state.status === 'pausing') void this.coordinator.pause().catch(() => {})
  }

  /** Replanning must wait for writers and final verification to settle. */
  async pauseAndWait(): Promise<void> {
    if (this.closed) throw new Error('development controller is closed')
    if (this.active === undefined) return
    await this.pause()
    await this.active
  }

  async dispose(): Promise<void> {
    this.closed = true
    if (this.active !== undefined) {
      this.pauseRequested = true
      this.setState('pausing')
      await this.ready?.catch(() => {})
      if (this.active !== undefined) await this.coordinator.pause().catch(() => {})
      await this.active
    }
    this.listeners.clear()
  }

  private async run(ready: PromiseWithResolvers<void>): Promise<void> {
    let release: (() => Promise<void>) | undefined
    try {
      release = await this.options.checkpoints.acquireRun?.()
      await this.options.recoverAbandonedOwnership?.()
      const plan = await this.options.loadPlan()
      const checkpoint = await this.options.checkpoints.load()
      const execution: Promise<DevelopmentRunResult> = checkpoint === null ? this.coordinator.execute(plan) : this.coordinator.resume(plan, checkpoint)
      if (this.pauseRequested || this.closed) void this.coordinator.pause().catch(() => {})
      ready.resolve()
      const result = await execution
      if (result.status === 'passed' && this.options.verifyFinal !== undefined && !this.pauseRequested && !this.closed) {
        this.setState('running', '开发与测试员交接已完成，正在执行最后一轮项目测试。')
        const verification = await this.options.verifyFinal(plan, result)
        this.setState(verification.status, verification.message, verification.delivery)
      } else this.setState(result.status === 'passed' && (this.pauseRequested || this.closed) ? 'paused' : result.status, result.slices.at(-1)?.failure?.message)
    } catch (error: unknown) {
      this.setState('failed', error instanceof Error ? error.message : 'development execution failed')
      ready.reject(error)
    } finally {
      try {
        await release?.()
      } catch (error: unknown) {
        this.setState('failed')
        throw error
      }
    }
  }

  private setState(status: DevelopmentRunSnapshot['status'], message?: string, delivery?: DeliveryReview): void {
    this.state = { status, ...(delivery === undefined ? {} : { delivery: structuredClone(delivery) }), ...(message === undefined ? {} : { message: message.slice(0, 1000) }) }
    for (const listener of this.listeners) { try { listener() } catch { /* Observers cannot interrupt execution. */ } }
  }
}
