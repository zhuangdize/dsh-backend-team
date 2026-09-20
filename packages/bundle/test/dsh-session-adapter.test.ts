import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDshLocalSessionInput, createVerifiedDshHostPort, createVerifiedDshSessionPort } from '../src/production.js'

describe('DSH local session adapter', () => {
  it('accepts a live session whose cwd matches the managed workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-session-'))
    const sessionId = 'session-1234567890'
    const input = createDshLocalSessionInput({
      context: {
        sessions: { get: (id: string) => id === sessionId ? { id, header: { cwd: workspaceRoot } } : undefined },
        agents: { get: (id: string) => id === sessionId ? { id } : undefined },
      },
      workspaceId: workspaceRoot,
      workspaceRoot,
    })({ method: 'GET', path: 'state', query: { sessionId }, headers: {}, remoteAddress: '127.0.0.1' })

    expect(input).toEqual({ sessionId, workspaceId: await realpath(workspaceRoot), loopback: true, readOnly: false })
  })

  it('rejects absent, non-loopback, unknown, and cross-workspace sessions', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-session-'))
    const sessionId = 'session-1234567890'
    const options = {
      context: { sessions: { get: () => ({ id: sessionId, header: { cwd: workspaceRoot } }) }, agents: { get: () => ({ id: sessionId }) } },
      workspaceId: workspaceRoot,
      workspaceRoot,
    }
    const extract = createDshLocalSessionInput(options)
    expect(() => extract({ method: 'GET', path: 'state', query: {}, headers: {}, remoteAddress: '127.0.0.1' })).toThrow(/session/i)
    expect(() => extract({ method: 'GET', path: 'state', query: { sessionId }, headers: {}, remoteAddress: '192.0.2.1' })).toThrow(/loopback/i)
    expect(() => createDshLocalSessionInput({ ...options, context: { sessions: { get: () => undefined }, agents: { get: () => undefined } } })({ method: 'GET', path: 'state', query: { sessionId }, headers: {}, remoteAddress: '127.0.0.1' })).toThrow(/session/i)
    expect(() => createDshLocalSessionInput({ ...options, context: { sessions: { get: () => ({ id: sessionId, header: { cwd: `${workspaceRoot}-other` } }) }, agents: { get: () => ({ id: sessionId }) } } })({ method: 'GET', path: 'state', query: { sessionId }, headers: {}, remoteAddress: '127.0.0.1' })).toThrow(/workspace/i)
  })

  it('requires both host session and agent stores', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-session-'))
    expect(() => createDshLocalSessionInput({ context: {}, workspaceId: workspaceRoot, workspaceRoot })).toThrow(/sessions/i)
  })

  it('verifies the official loopback WebServer before exposing the Host port', () => {
    const registrations: unknown[] = []
    const host = createVerifiedDshHostPort({ webServer: { host: '127.0.0.1', register: (route: unknown) => { registrations.push(route); return () => undefined } } })
    expect(host.verifiedProvenance).toBe(true)
    host.server.register({ kind: 'prefix', path: '/x', handler: () => undefined })
    expect(registrations).toHaveLength(1)
    expect(() => createVerifiedDshHostPort({ webServer: { host: '0.0.0.0', register: () => () => undefined } })).toThrow(/loopback/i)
  })

  it('exposes Session authentication only when both official stores are present', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-session-port-'))
    const sessionId = 'session-1234567890'
    const port = createVerifiedDshSessionPort({
      sessions: { get: (id: string) => id === sessionId ? { id, header: { cwd: workspaceRoot } } : undefined },
      agents: { get: (id: string) => id === sessionId ? { id } : undefined },
      workspaceId: workspaceRoot,
      workspaceRoot,
    })
    expect(port.verifiedProvenance).toBe(true)
    expect(port.input({ method: 'GET', path: 'state', query: { sessionId }, headers: {}, remoteAddress: '127.0.0.1' })).toMatchObject({ sessionId, loopback: true })
    expect(() => createVerifiedDshSessionPort({ sessions: { get: () => undefined }, workspaceId: workspaceRoot, workspaceRoot })).toThrow(/agents/i)
  })
})

it('authenticates only this host extractor output and rechecks live session identity', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'backend-team-auth-port-'))
  const sessionId = 'session-1234567890'
  let live = true
  const port = createVerifiedDshSessionPort({ workspaceRoot, workspaceId: workspaceRoot, sessions: { get: () => ({ id: sessionId, header: { cwd: workspaceRoot } }) }, agents: { get: () => live ? { id: sessionId } : undefined } })
  const input = port.input({ method: 'GET', path: 'state', query: { sessionId }, headers: {}, remoteAddress: '127.0.0.1' })
  expect(port.authenticator.authenticate(input)).toMatchObject({ sessionId })
  expect(() => port.authenticator.authenticate(JSON.parse(JSON.stringify(input)))).toThrow('host session input')
  live = false
  expect(() => port.authenticator.authenticate(input)).toThrow('not live')
})
