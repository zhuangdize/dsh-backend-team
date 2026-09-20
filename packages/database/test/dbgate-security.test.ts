import { describe, expect, it } from 'vitest'
import { buildDbGateEnvironment, assertDbGatePath, assertLoopbackListeners } from '../src/index.js'

describe('DbGate security policy', () => {
  it('disables shell features and confines user data to the runtime', () => {
    const env = buildDbGateEnvironment({ runtimeRoot: '/workspace/.backend-team/runtime/dbgate', username: 'team_test', password: 'secret', port: 55234, endpoint: { host: '127.0.0.1', port: 55123, database: 'design_0123456789abcdef', user: 'backend_team' }, databasePassword: 'postgres-secret' })
    expect(env).toMatchObject({
      LOGIN: 'team_test', PASSWORD: 'secret', PORT: '55234',
      WORKSPACE_DIR: '/workspace/.backend-team/runtime/dbgate/user-data',
      TOKEN_LIFETIME: '2h', LANGUAGE: 'zh-CN',
      CONNECTIONS: 'workspace_design',
      SINGLE_CONNECTION: 'workspace_design', SINGLE_DATABASE: 'design_0123456789abcdef',
    })
    for (const key of ['SHELL_CONNECTION', 'SHELL_SCRIPTING', 'SKIP_ALL_AUTH', 'ALLOW_DBGATE_PRIVATE_CLOUD']) expect(Boolean(env[key])).toBe(false)
    expect(env.SINGLE_CONNECTION).toBe('workspace_design')
    expect(env.SINGLE_DATABASE).toBe('design_0123456789abcdef')
  })

  it('rejects non-loopback listeners and paths outside the managed root', () => {
    expect(() => assertLoopbackListeners(['127.0.0.1:55234', 'unix:/workspace/socket'])).not.toThrow()
    expect(() => assertLoopbackListeners(['*:55234'])).toThrow(/non-loopback/i)
    expect(() => assertDbGatePath('/workspace/.backend-team/runtime/dbgate/user-data', '/workspace/.backend-team/runtime/dbgate')).not.toThrow()
    expect(() => assertDbGatePath('/workspace/.backend-team/runtime/postgresql/data', '/workspace/.backend-team/runtime/dbgate')).toThrow(/outside|runtime|path/i)
  })
})
