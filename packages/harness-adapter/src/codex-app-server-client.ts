import { spawn, type SpawnOptions } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const DISPOSE_GRACE_MS = 500
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + 16 * 1024
const MAX_HEADER_BYTES = 16 * 1024

export interface CodexAppServerChild {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr?: Readable
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: string, listener: (...args: unknown[]) => void): this
  once(event: string, listener: (...args: unknown[]) => void): this
}

export interface CodexAppServerSpawnOptions {
  readonly cwd: string
  readonly shell: false
  readonly stdio: ['pipe', 'pipe', 'pipe']
}

export interface CodexAppServerClientOptions {
  readonly command: string
  readonly cwd: string
  readonly args?: readonly string[]
  readonly requestTimeoutMs?: number
  /** Test and embedding seam; production defaults to node:child_process.spawn. */
  readonly spawnChild?: (command: string, args: readonly string[], options: CodexAppServerSpawnOptions) => CodexAppServerChild
}

export type CodexAppServerNotificationCallback = (method: string, params: unknown) => void
export type CodexAppServerRequestCallback = (method: string, params: unknown) => Promise<unknown>
export type CodexAppServerFailureCallback = (error: Error) => void

export class CodexAppServerError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'CodexAppServerError'
    this.code = code
  }
}

type RequestId = number | string
type PendingRequest = {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (reason?: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}
type WireMessage = Record<string, unknown>

/** A bounded JSONL JSON-RPC client for the Codex app-server stdio endpoint. */
export class CodexAppServerClient {
  private readonly timeoutMs: number
  private readonly args: readonly string[]
  private child: CodexAppServerChild | undefined
  private nextRequestId = 1
  private readonly pending = new Map<RequestId, PendingRequest>()
  private readonly notificationCallbacks = new Set<CodexAppServerNotificationCallback>()
  private readonly serverRequestCallbacks = new Set<CodexAppServerRequestCallback>()
  private readonly failureCallbacks = new Set<CodexAppServerFailureCallback>()
  private inputBuffer = Buffer.alloc(0)
  private frameMode: 'jsonl' | 'content-length' | undefined
  private lifecycle: 'idle' | 'starting' | 'ready' | 'disposing' | 'disposed' | 'failed' = 'idle'
  private startPromise: Promise<void> | undefined
  private disposePromise: Promise<void> | undefined
  private fatalError: Error | undefined

  constructor(private readonly options: CodexAppServerClientOptions) {
    if (options.command.length === 0 || options.cwd.length === 0) throw new Error('Codex app-server command and cwd are required')
    if (options.requestTimeoutMs !== undefined && (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)) throw new Error('Codex app-server requestTimeoutMs must be positive and finite')
    this.timeoutMs = Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS))
    this.args = Object.freeze([...(options.args ?? [])])
  }

  async start(): Promise<void> {
    if (this.lifecycle === 'ready') return
    if (this.lifecycle === 'starting' && this.startPromise !== undefined) return this.startPromise
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') throw new Error('Codex app-server client is disposed')
    if (this.lifecycle === 'failed') throw this.fatalError ?? new Error('Codex app-server client failed')
    this.lifecycle = 'starting'
    this.startPromise = this.startInternal()
    try {
      await this.startPromise
    } catch (error: unknown) {
      this.fail(error)
      throw error
    } finally {
      this.startPromise = undefined
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.lifecycle !== 'ready') throw this.lifecycleError()
    return this.sendRequest(method, params)
  }

  onNotification(callback: CodexAppServerNotificationCallback): () => void {
    if (typeof callback !== 'function') throw new TypeError('notification callback must be a function')
    this.notificationCallbacks.add(callback)
    return () => { this.notificationCallbacks.delete(callback) }
  }

  onServerRequest(callback: CodexAppServerRequestCallback): () => void {
    if (typeof callback !== 'function') throw new TypeError('server request callback must be a function')
    this.serverRequestCallbacks.add(callback)
    return () => { this.serverRequestCallbacks.delete(callback) }
  }

  onFailure(callback: CodexAppServerFailureCallback): () => void {
    if (typeof callback !== 'function') throw new TypeError('failure callback must be a function')
    this.failureCallbacks.add(callback)
    return () => { this.failureCallbacks.delete(callback) }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    if (this.lifecycle === 'disposed') return
    this.lifecycle = 'disposing'
    this.rejectPending(new Error('Codex app-server client disposed'))
    const child = this.child
    this.disposePromise = this.disposeChild(child).finally(() => {
      this.lifecycle = 'disposed'
      this.child = undefined
    })
    return this.disposePromise
  }

  private async startInternal(): Promise<void> {
    const argv = ['app-server', '--listen', 'stdio://', ...this.args]
    const spawnOptions: CodexAppServerSpawnOptions = { cwd: this.options.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }
    const child = this.options.spawnChild?.(this.options.command, argv, spawnOptions) ?? spawn(this.options.command, argv, spawnOptions as SpawnOptions) as unknown as CodexAppServerChild
    this.child = child
    this.attachChild(child)
    await this.sendRequest('initialize', {
      clientInfo: { name: 'dsh-backend-team', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, true)
    if (this.lifecycle !== 'starting') throw this.fatalError ?? new Error('Codex app-server exited during initialization')
    this.writeMessage({ method: 'initialized' })
    this.lifecycle = 'ready'
  }

  private sendRequest(method: string, params: unknown, duringStart = false): Promise<unknown> {
    if (!duringStart && this.lifecycle !== 'ready') return Promise.reject(this.lifecycleError())
    const child = this.child
    if (child === undefined) return Promise.reject(new Error('Codex app-server child is unavailable'))
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.writeMessage({ id, method, params })
      } catch (error: unknown) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private writeMessage(message: WireMessage): void {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') return
    const child = this.child
    if (child === undefined || child.stdin.destroyed) throw new Error('Codex app-server stdin is unavailable')
    let encoded: string
    try { encoded = JSON.stringify(message) } catch { throw new Error('Codex app-server message is not JSON serializable') }
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) throw new Error('Codex app-server message exceeds the frame limit')
    child.stdin.write(`${encoded}\n`)
  }

  private attachChild(child: CodexAppServerChild): void {
    child.stdout.on('data', (chunk: unknown) => this.receive(chunk))
    child.stderr?.on('data', () => undefined)
    child.stdin.on('error', (error: unknown) => this.fail(error))
    child.on('error', (error: unknown) => this.fail(error))
    child.on('exit', (code: unknown, signal: unknown) => this.handleExit(code, signal))
    child.on('close', (code: unknown, signal: unknown) => this.handleExit(code, signal))
  }

  private receive(chunk: unknown): void {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') return
    const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : undefined
    if (bytes === undefined) return this.fail(new Error('Codex app-server emitted an invalid stdout chunk'))
    this.inputBuffer = Buffer.concat([this.inputBuffer, bytes])
    if (this.inputBuffer.length > MAX_BUFFER_BYTES) return this.fail(new Error('Codex app-server input buffer exceeded the limit'))
    try {
      if (this.frameMode === undefined) this.frameMode = this.detectFrameMode()
      if (this.frameMode === 'content-length') this.receiveContentLength()
      else this.receiveJsonLines()
    } catch (error: unknown) { this.fail(error) }
  }

  private detectFrameMode(): 'jsonl' | 'content-length' | undefined {
    const text = this.inputBuffer.toString('utf8')
    if (text.trimStart() === '') return undefined
    const first = text.trimStart()
    if (/^Content(?:-|$)/iu.test(first)) return 'content-length'
    return 'jsonl'
  }

  private receiveJsonLines(): void {
    while (true) {
      const lineEnd = this.inputBuffer.indexOf(0x0a)
      if (lineEnd < 0) {
        if (this.inputBuffer.length > MAX_FRAME_BYTES) throw new Error('Codex app-server JSONL frame exceeded the limit')
        return
      }
      const line = this.inputBuffer.subarray(0, lineEnd)
      this.inputBuffer = this.inputBuffer.subarray(lineEnd + 1)
      const text = line.toString('utf8').replace(/\r$/u, '').trim()
      if (text === '') continue
      this.dispatch(this.parseMessage(text))
    }
  }

  private receiveContentLength(): void {
    while (true) {
      const separator = this.inputBuffer.indexOf(Buffer.from('\r\n\r\n'))
      if (separator < 0) {
        if (this.inputBuffer.length > MAX_HEADER_BYTES) throw new Error('Codex app-server frame header exceeded the limit')
        return
      }
      if (separator > MAX_HEADER_BYTES) throw new Error('Codex app-server frame header exceeded the limit')
      const headerText = this.inputBuffer.subarray(0, separator).toString('ascii')
      const match = /^Content-Length\s*:\s*(\d+)\r?$/imu.exec(headerText)
      if (match === null) throw new Error('Codex app-server frame has invalid Content-Length')
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) throw new Error('Codex app-server frame exceeded the limit')
      const bodyStart = separator + 4
      if (this.inputBuffer.length < bodyStart + length) return
      const body = this.inputBuffer.subarray(bodyStart, bodyStart + length)
      this.inputBuffer = this.inputBuffer.subarray(bodyStart + length)
      this.dispatch(this.parseMessage(body.toString('utf8')))
    }
  }

  private parseMessage(text: string): WireMessage {
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error('Codex app-server emitted malformed JSON') }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Codex app-server emitted a malformed JSON-RPC message')
    const message = value as WireMessage
    if (typeof message.method !== 'undefined' && typeof message.method !== 'string') throw new Error('Codex app-server message method is invalid')
    if (typeof message.id !== 'undefined' && !isRequestId(message.id)) throw new Error('Codex app-server message id is invalid')
    return message
  }

  private dispatch(message: WireMessage): void {
    const hasId = Object.hasOwn(message, 'id')
    const method = message.method
    if (hasId && typeof method === 'string') return void this.dispatchServerRequest(message.id as RequestId, method, message.params)
    if (hasId) return void this.dispatchResponse(message.id as RequestId, message)
    if (typeof method === 'string') {
      for (const callback of [...this.notificationCallbacks]) {
        try { callback(method, message.params) } catch { /* callbacks are isolated from transport */ }
      }
      return
    }
    throw new Error('Codex app-server emitted an unclassifiable JSON-RPC message')
  }

  private dispatchResponse(id: RequestId, message: WireMessage): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (Object.hasOwn(message, 'error')) {
      const remoteError = isRecord(message.error) ? message.error : undefined
      const code = remoteError !== undefined && typeof remoteError.code === 'number' && Number.isSafeInteger(remoteError.code) ? remoteError.code : undefined
      pending.reject(new CodexAppServerError(`Codex app-server request failed: ${pending.method}`, code))
    }
    else if (Object.hasOwn(message, 'result')) pending.resolve(message.result)
    else pending.reject(new Error(`Codex app-server returned an invalid response: ${pending.method}`))
  }

  private dispatchServerRequest(id: RequestId, method: string, params: unknown): void {
    const callback = [...this.serverRequestCallbacks][0]
    if (callback === undefined) {
      this.sendError(id, -32601, 'Method not found')
      return
    }
    let result: Promise<unknown>
    try { result = callback(method, params) } catch { this.sendError(id, -32000, 'Server request failed'); return }
    Promise.resolve(result).then(
      (value) => {
        if (this.lifecycle !== 'ready') return
        try { this.sendResult(id, value) } catch { this.sendError(id, -32000, 'Server request failed') }
      },
      () => { if (this.lifecycle === 'ready') this.sendError(id, -32000, 'Server request failed') },
    ).catch(() => undefined)
  }

  private sendResult(id: RequestId, result: unknown): void { this.writeMessage({ id, result: result === undefined ? null : result }) }
  private sendError(id: RequestId, code: number, message: string): void { this.writeMessage({ id, error: { code, message } }) }

  private handleExit(code: unknown, signal: unknown): void {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') return
    const suffix = typeof signal === 'string' ? ` (${signal})` : typeof code === 'number' ? ` (code ${code})` : ''
    this.fail(undefined, `Codex app-server exited${suffix}`)
  }

  private fail(cause: unknown, safeMessage?: string): void {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') return
    if (this.fatalError !== undefined) return
    this.fatalError = new CodexAppServerError(safeMessage ?? 'Codex app-server transport failed')
    this.lifecycle = 'failed'
    this.rejectPending(this.fatalError)
    for (const callback of [...this.failureCallbacks]) {
      try { callback(this.fatalError) } catch { /* failure observers cannot affect transport cleanup */ }
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private lifecycleError(): Error {
    if (this.lifecycle === 'failed' && this.fatalError !== undefined) return this.fatalError
    return new Error(`Codex app-server client is not ready (${this.lifecycle})`)
  }

  private async disposeChild(child: CodexAppServerChild | undefined): Promise<void> {
    if (child === undefined) return
    if (child.exitCode !== null || child.signalCode !== null) return
    try { child.stdin.end() } catch { /* process may already have closed */ }
    if (await waitForExit(child, DISPOSE_GRACE_MS)) return
    try { child.kill('SIGTERM') } catch { /* child handle is still the only target */ }
    if (await waitForExit(child, DISPOSE_GRACE_MS)) return
    try { child.kill('SIGKILL') } catch { /* best effort after bounded graceful cleanup */ }
    await waitForExit(child, DISPOSE_GRACE_MS)
  }
}

function isRequestId(value: unknown): value is RequestId {
  return (typeof value === 'number' && Number.isSafeInteger(value)) || typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function waitForExit(child: CodexAppServerChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(exited) } }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', () => finish(true))
    child.once('close', () => finish(true))
  })
}
