import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { applyDbGateLoginRoute } from '../src/dbgate-login-route.js'

describe('DbGate dedicated login delivery', () => {
  it('requires same-origin authenticated writable ownership before consuming a login', async () => {
    let handler: RequestListener
    let consumed = false
    const session = { sessionId: 'session-owner-123456', workspaceId: 'workspace', loopback: true as const, readOnly: false }
    const remove = applyDbGateLoginRoute({
      server: { verifiedProvenance: true, register: (route) => { handler = route.handler; return () => undefined } },
      workspaceId: 'workspace',
      sessionInput: (request) => request.headers['x-test-session'],
      authenticator: { authenticate: (input) => { if (input !== session.sessionId) throw new Error('not authenticated'); return session } },
      consumeLogin: (id) => { if (id !== session.sessionId || consumed) throw new Error('unavailable'); consumed = true; return { username: 'login-user', password: 'private-password', url: 'http://127.0.0.1:55000/' } },
    })
    const server = createServer((req, res) => { void handler!(req, res) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing address')
    const origin = `http://127.0.0.1:${address.port}`
    const request = (headers: Record<string, string>) => fetch(`${origin}/plugins/backend-team/dbgate-login`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
    try {
      expect((await request({ origin: 'https://evil.test', 'x-test-session': session.sessionId })).status).toBe(403)
      expect((await request({ origin })).status).toBe(401)
      session.readOnly = true
      expect((await request({ origin, 'x-test-session': session.sessionId })).status).toBe(403)
      session.readOnly = false
      session.workspaceId = 'other-workspace'
      expect((await request({ origin, 'x-test-session': session.sessionId })).status).toBe(403)
      session.workspaceId = 'workspace'
      expect(consumed).toBe(false)
      const result = await request({ origin, 'x-test-session': session.sessionId })
      expect(result.status).toBe(200)
      expect(result.headers.get('cache-control')).toBe('no-store')
      expect(await result.json()).toEqual({ username: 'login-user', password: 'private-password', url: 'http://127.0.0.1:55000/' })
      const replay = await request({ origin, 'x-test-session': session.sessionId })
      expect(replay.status).toBe(409)
      expect(await replay.text()).not.toContain('private-password')
    } finally { remove(); server.close(); await once(server, 'close') }
  })
})
