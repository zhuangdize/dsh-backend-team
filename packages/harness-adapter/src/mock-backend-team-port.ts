import { BackendTeamEventSchema } from '@dsh-backend-team/contracts'
import type {
  AgentHandle,
  AgentSpawnRequest,
  ApprovalDecision,
  ApprovalRequest,
  BackendTeamEvent,
  BackendTeamOrchestrationPort,
} from '@dsh-backend-team/contracts'

export class MockBackendTeamScriptExhaustedError extends Error {
  constructor(script: 'approval' | 'agent') {
    super(`Mock backend team ${script} script exhausted`)
    this.name = 'MockBackendTeamScriptExhaustedError'
  }
}

export class MockBackendTeamAgentCancelledError extends Error {
  constructor(id: string) {
    super(`Mock backend team agent cancelled: ${id}`)
    this.name = 'MockBackendTeamAgentCancelledError'
  }
}

export interface MockBackendTeamAgentScript {
  readonly result: unknown
  readonly pendingMs?: number
  /** Delay before the handle is returned; abort must reject this pending spawn. */
  readonly spawnPendingMs?: number
  /** Optional scripted callback that runs while the agent handle is executing. */
  readonly onRun?: (request: AgentSpawnRequest) => void | Promise<void>
}

export interface MockBackendTeamOrchestrationPortOptions {
  readonly approvals?: readonly ApprovalDecision[]
  readonly agents?: readonly MockBackendTeamAgentScript[]
}

export interface MockBackendTeamOrchestrationSnapshot {
  readonly events: readonly BackendTeamEvent[]
  readonly approvalRequests: readonly ApprovalRequest[]
  readonly spawnRequests: readonly AgentSpawnRequest[]
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isLosslessJsonValue(value: unknown, active = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object') return false
  if (active.has(value)) return false
  try {
    active.add(value)
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isLosslessJsonValue(value[index], active)) return false
      }
      return true
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype) return false
    if (!Reflect.ownKeys(value).every((key) => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key))) return false
    for (const key of Object.keys(value)) if (!isLosslessJsonValue(Reflect.get(value, key), active)) return false
    return true
  } catch {
    return false
  } finally {
    active.delete(value)
  }
}

function assertJsonObject(value: unknown): asserts value is Record<string, unknown> {
  if (!isLosslessJsonValue(value) || typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('agent context must be a lossless JSON object')
  }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
  }
  return value
}

interface Waiter {
  timer: ReturnType<typeof setTimeout>
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  cleanup: () => void
  settled: boolean
}

class MockBackendTeamAgentHandle implements AgentHandle {
  readonly id: string
  readonly #resultValue: unknown
  readonly #pendingMs: number
  readonly #request: AgentSpawnRequest
  readonly #onRun: ((request: AgentSpawnRequest) => void | Promise<void>) | undefined
  readonly #waiters = new Set<Waiter>()
  #cancelled = false
  #runStarted = false

  constructor(id: string, script: MockBackendTeamAgentScript, request: AgentSpawnRequest) {
    this.id = id
    this.#resultValue = clone(script.result)
    this.#pendingMs = script.pendingMs ?? 0
    this.#request = request
    this.#onRun = script.onRun
    if (!Number.isFinite(this.#pendingMs) || this.#pendingMs < 0) throw new TypeError('pendingMs must be a non-negative finite number')
  }

  async result(signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError()
    if (this.#cancelled) throw new MockBackendTeamAgentCancelledError(this.id)
    if (!this.#runStarted) {
      this.#runStarted = true
      if (this.#onRun !== undefined) await this.#onRun(this.#request)
    }
    if (this.#pendingMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          timer: undefined as unknown as ReturnType<typeof setTimeout>,
          resolve,
          reject,
          settled: false,
          cleanup: () => {},
        }
        const onAbort = () => {
          if (waiter.settled) return
          waiter.settled = true
          this.#waiters.delete(waiter)
          clearTimeout(waiter.timer)
          waiter.cleanup()
          reject(abortError())
        }
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return
          waiter.settled = true
          this.#waiters.delete(waiter)
          waiter.cleanup()
          resolve()
        }, this.#pendingMs)
        waiter.cleanup = () => signal?.removeEventListener('abort', onAbort)
        this.#waiters.add(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (this.#cancelled) this.rejectWaiter(waiter)
      })
    }
    if (signal?.aborted) throw abortError()
    if (this.#cancelled) throw new MockBackendTeamAgentCancelledError(this.id)
    return clone(this.#resultValue)
  }

  async cancel(): Promise<void> {
    if (this.#cancelled) return
    this.#cancelled = true
    for (const waiter of [...this.#waiters]) this.rejectWaiter(waiter)
  }

  private rejectWaiter(waiter: Waiter): void {
    if (waiter.settled) return
    waiter.settled = true
    this.#waiters.delete(waiter)
    clearTimeout(waiter.timer)
    waiter.cleanup()
    waiter.reject(new MockBackendTeamAgentCancelledError(this.id))
  }
}

function abortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  return error
}

function cloneSpawnRequest(request: AgentSpawnRequest): AgentSpawnRequest {
  return {
    task: request.task,
    role: request.role,
    context: clone(request.context),
    ...(request.agentTask === undefined ? {} : { agentTask: clone(request.agentTask) }),
  }
}

/**
 * Application-layer scripted port. It is deliberately separate from the
 * production DeepSeek Harness adapter and its official `ctx.tools` surface.
 */
export class MockBackendTeamOrchestrationPort implements BackendTeamOrchestrationPort {
  readonly #events: BackendTeamEvent[] = []
  readonly #approvalRequests: ApprovalRequest[] = []
  readonly #spawnRequests: AgentSpawnRequest[] = []
  readonly #approvals: ApprovalDecision[]
  readonly #agents: MockBackendTeamAgentScript[]
  #agentSequence = 0

  constructor(options: MockBackendTeamOrchestrationPortOptions = {}) {
    this.#approvals = (options.approvals ?? []).map(clone)
    this.#agents = (options.agents ?? []).map((script) => ({
      result: clone(script.result),
      ...(script.pendingMs === undefined ? {} : { pendingMs: script.pendingMs }),
      ...(script.spawnPendingMs === undefined ? {} : { spawnPendingMs: script.spawnPendingMs }),
      ...(script.onRun === undefined ? {} : { onRun: script.onRun }),
    }))
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.#approvalRequests.push(clone(request))
    const decision = this.#approvals.shift()
    if (!decision) throw new MockBackendTeamScriptExhaustedError('approval')
    return clone(decision)
  }

  async spawnAgent(request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle> {
    if (signal?.aborted) throw abortError()
    assertJsonObject(request.context)
    const script = this.#agents.shift()
    if (!script) throw new MockBackendTeamScriptExhaustedError('agent')
    this.#spawnRequests.push(cloneSpawnRequest(request))
    await waitForSpawn(script.spawnPendingMs ?? 0, signal)
    this.#agentSequence += 1
    return new MockBackendTeamAgentHandle(`mock-agent-${this.#agentSequence}`, script, request)
  }

  async emit(event: BackendTeamEvent): Promise<void> {
    const parsed = BackendTeamEventSchema.parse(clone(event))
    this.#events.push(clone(parsed))
  }

  snapshot(): MockBackendTeamOrchestrationSnapshot {
    return freezeDeep({
      events: clone(this.#events),
      approvalRequests: clone(this.#approvalRequests),
      spawnRequests: this.#spawnRequests.map(cloneSpawnRequest),
    })
  }
}

async function waitForSpawn(delay: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(delay) || delay < 0) throw new TypeError('spawnPendingMs must be a non-negative finite number')
  if (delay === 0) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }, delay)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
