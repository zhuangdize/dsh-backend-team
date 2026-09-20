import { describe, expect, it } from 'vitest'
import { buildPostgresqlConfig, assertLocalEndpoint } from '../src/index.js'

describe('PostgreSQL config', () => {
  it('configures only workspace socket and loopback TCP with SCRAM', () => {
    const config = buildPostgresqlConfig('/workspace/.backend-team/runtime/postgresql', { socketDirectory: '/workspace/.backend-team/runtime/postgresql/socket', port: 55432 })
    expect(config.postgresqlConf).toContain("listen_addresses = '127.0.0.1'")
    expect(config.postgresqlConf).toContain("unix_socket_directories = '/workspace/.backend-team/runtime/postgresql/socket'")
    expect(config.pgHbaConf).not.toContain(' trust')
    expect(config.pgHbaConf).toContain('scram-sha-256')
  })
  it('omits the TCP port until the allocator assigns one', () => {
    const config = buildPostgresqlConfig('/workspace/.backend-team/runtime/postgresql', { socketDirectory: '/workspace/.backend-team/runtime/postgresql/socket' })
    expect(config.postgresqlConf).not.toContain('port = 0')
  })
  it('rejects non-loopback endpoints', () => { expect(() => assertLocalEndpoint({ host: '0.0.0.0' as '127.0.0.1', socketDirectory: '/tmp/socket', database: 'app', user: 'backend_team', credentialRef: 'ref' })).toThrow(/loopback/) })
})

it('uses loopback TCP when the Unix socket path exceeds the macOS byte limit', () => {
  const config = buildPostgresqlConfig('/runtime', { socketDirectory: '/工作区/'.repeat(12) })
  expect(config.postgresqlConf).toContain("unix_socket_directories = ''")
  expect(config.postgresqlConf).toContain("listen_addresses = '127.0.0.1'")
  expect(config.pgHbaConf).toContain('scram-sha-256')
  expect(config.pgHbaConf).not.toContain(' trust')
})
