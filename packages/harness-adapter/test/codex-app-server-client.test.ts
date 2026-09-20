import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CodexAppServerClient, type CodexAppServerChild } from '../src/codex-app-server-client.js'

type MutableFakeChild = Omit<CodexAppServerChild, 'exitCode' | 'signalCode'> & {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  emit(event: string, ...args: unknown[]): void
}

function fakeChild(): {
  child: MutableFakeChild
  input: PassThrough
  output: PassThrough
  errorOutput: PassThrough
  killed: string[]
} {
  const input = new PassThrough()
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  const killed: string[] = []
  const child = {
    stdin: input,
    stdout: output,
    stderr: errorOutput,
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      killed.push(signal)
      child.exitCode = 0
      child.signalCode = null
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
      return true
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'exit' || event === 'close' || event === 'error') listeners[event]?.push(listener)
      return child
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      return child.on(event, (...args: unknown[]) => {
        listener(...args)
        const values = listeners[event]
        if (values !== undefined) values.splice(values.indexOf(listener), 1)
      })
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners[event] ?? [])]) listener(...args)
    },
  } as unknown as MutableFakeChild
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = { exit: [], close: [], error: [] }
  return { child, input, output, errorOutput, killed }
}

function readLines(stream: PassThrough): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = []
    let buffer = ''
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') messages.push(JSON.parse(line))
      if (messages.length >= 1) resolve(messages)
    })
  })
}

function sendJson(stream: PassThrough, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`)
}

describe('CodexAppServerClient', () => {
  it('spawns with the bounded app-server stdio command and completes the handshake', async () => {
    const fixture = fakeChild()
    let spawnArgs: readonly string[] | undefined
    const client = new CodexAppServerClient({
      command: 'codex', cwd: '/workspace', args: ['--foo'],
      spawnChild(command, args, options) {
        expect(command).toBe('codex')
        expect(options.cwd).toBe('/workspace')
        expect(options.shell).toBe(false)
        spawnArgs = args
        return fixture.child
      },
    })
    const received = readLines(fixture.input)
    const start = client.start()
    const handshake = await received
    expect(spawnArgs).toEqual(['app-server', '--listen', 'stdio://', '--foo'])
    expect(handshake[0]).toEqual(expect.objectContaining({ id: expect.any(Number), method: 'initialize', params: expect.objectContaining({ clientInfo: expect.objectContaining({ name: 'dsh-backend-team', version: expect.any(String) }), capabilities: { experimentalApi: true } }) }))
    sendJson(fixture.output, { id: (handshake[0] as { id: number }).id, result: { userAgent: 'fixture', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' } })
    await expect(start).resolves.toBeUndefined()
    await client.dispose()
    expect(fixture.killed).toEqual(['SIGTERM'])
  })

  it('handles requests and notifications across split JSONL chunks', async () => {
    const fixture = fakeChild()
    const client = new CodexAppServerClient({ command: 'fixture', cwd: '/workspace', spawnChild: () => fixture.child })
    const notifications: unknown[] = []
    client.onNotification((method, params) => notifications.push({ method, params }))
    const start = client.start()
    await new Promise((resolve) => setImmediate(resolve))
    let input = ''
    fixture.input.on('data', (chunk: Buffer) => { input += chunk.toString('utf8') })
    await new Promise((resolve) => setImmediate(resolve))
    const initialize = JSON.parse(input) as { id: number }
    sendJson(fixture.output, { id: initialize.id, result: { ok: true } })
    await start
    const request = client.request('fixture/request', { value: 7 })
    await new Promise((resolve) => setImmediate(resolve))
    const lines = input.trim().split('\n')
    const wireRequest = JSON.parse(lines.at(-1)!) as { id: number; method: string; params: unknown }
    expect(wireRequest).toMatchObject({ method: 'fixture/request', params: { value: 7 } })
    fixture.output.write(`{"method":"fixture/notification","params":{"ok":true}}\n{"id":${wireRequest.id},`)
    fixture.output.write('"result":{"value":8}}\n')
    await expect(request).resolves.toEqual({ value: 8 })
    expect(notifications).toEqual([{ method: 'fixture/notification', params: { ok: true } }])
    await client.dispose()
  })

  it('times out requests and rejects all pending work when the child exits', async () => {
    const fixture = fakeChild()
    const client = new CodexAppServerClient({ command: 'fixture', cwd: '/workspace', requestTimeoutMs: 20, spawnChild: () => fixture.child })
    const start = client.start()
    await new Promise((resolve) => setImmediate(resolve))
    const initialize = JSON.parse((await new Promise<string>((resolve) => { fixture.input.once('data', (chunk: Buffer) => resolve(chunk.toString())) })).trim()) as { id: number }
    sendJson(fixture.output, { id: initialize.id, result: {} })
    await start
    await expect(client.request('never/answers', {})).rejects.toThrow(/timed out/i)
    const failures: Error[] = []
    client.onFailure((error) => failures.push(error))
    const pending = client.request('pending', {})
    fixture.child.exitCode = 9
    fixture.child.emit('exit', 9, null)
    fixture.child.emit('close', 9, null)
    fixture.child.emit('error', new Error('fixture detail must remain private'))
    await expect(pending).rejects.toThrow(/exited/i)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.message).toMatch(/exited/i)
    await client.dispose()
  })

  it('dispatches server requests and denies unknown methods with JSON-RPC errors', async () => {
    const fixture = fakeChild()
    const client = new CodexAppServerClient({ command: 'fixture', cwd: '/workspace', spawnChild: () => fixture.child })
    const start = client.start()
    const initialize = JSON.parse((await new Promise<string>((resolve) => { fixture.input.once('data', (chunk: Buffer) => resolve(chunk.toString())) })).trim()) as { id: number }
    sendJson(fixture.output, { id: initialize.id, result: {} })
    await start
    const removeHandler = client.onServerRequest(async (method, params) => {
      expect(method).toBe('fixture/ask')
      expect(params).toEqual({ prompt: 'ok' })
      return { answer: 42 }
    })
    const responses: unknown[] = []
    fixture.input.on('data', (chunk: Buffer) => { for (const line of chunk.toString().trim().split('\n')) if (line) responses.push(JSON.parse(line)) })
    sendJson(fixture.output, { id: 91, method: 'fixture/ask', params: { prompt: 'ok' } })
    await new Promise((resolve) => setImmediate(resolve))
    removeHandler()
    sendJson(fixture.output, { id: 92, method: 'fixture/unknown', params: null })
    await new Promise((resolve) => setImmediate(resolve))
    expect(responses).toEqual(expect.arrayContaining([
      { id: 91, result: { answer: 42 } },
      { id: 92, error: { code: -32601, message: 'Method not found' } },
    ]))
    await client.dispose()
  })

  it('does not wait for a hanging server callback and owns cleanup through its child handle', async () => {
    const fixture = fakeChild()
    const client = new CodexAppServerClient({ command: 'fixture', cwd: '/workspace', spawnChild: () => fixture.child })
    const start = client.start()
    const initialize = JSON.parse((await new Promise<string>((resolve) => { fixture.input.once('data', (chunk: Buffer) => resolve(chunk.toString())) })).trim()) as { id: number }
    sendJson(fixture.output, { id: initialize.id, result: {} })
    await start
    client.onServerRequest(() => new Promise(() => undefined))
    sendJson(fixture.output, { id: 1, method: 'fixture/hang', params: {} })
    await client.dispose()
    expect(fixture.killed).toEqual(['SIGTERM'])
  })
})
