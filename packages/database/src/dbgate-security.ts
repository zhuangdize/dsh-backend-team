import { isAbsolute, resolve } from 'node:path'
import type { LocalDatabaseEndpoint } from './postgresql-config.js'
export interface DbGateSecurityConfig { readonly runtimeRoot: string; readonly username: string; readonly password: string; readonly port: number; readonly endpoint: Pick<LocalDatabaseEndpoint, 'host' | 'port' | 'database' | 'user'>; readonly databasePassword: string }
export function buildDbGateEnvironment(config: DbGateSecurityConfig): Record<string, string> {
  // DbGate 7.2.3 treats any nonempty value (including "0") as enabled.
  assertAllowlistedDesignDatabase(config.endpoint.database)
  if (config.endpoint.host !== '127.0.0.1' || config.endpoint.port === undefined || config.endpoint.port < 1024 || config.endpoint.port > 65535 || config.endpoint.user.length === 0 || config.databasePassword.length === 0) throw new Error('DbGate predefined database connection is invalid')
  const connectionId = 'workspace_design'
  return { LOGIN: config.username, PASSWORD: config.password, PORT: String(config.port), WORKSPACE_DIR: resolve(config.runtimeRoot, 'user-data'), CONNECTIONS: connectionId, [`ENGINE_${connectionId}`]: 'postgres@dbgate-plugin-postgres', [`SERVER_${connectionId}`]: config.endpoint.host, [`USER_${connectionId}`]: config.endpoint.user, [`PASSWORD_${connectionId}`]: config.databasePassword, [`PORT_${connectionId}`]: String(config.endpoint.port), [`DATABASE_${connectionId}`]: config.endpoint.database, SINGLE_CONNECTION: connectionId, SINGLE_DATABASE: config.endpoint.database, SHELL_CONNECTION: '', SHELL_SCRIPTING: '', SKIP_ALL_AUTH: '', ALLOW_DBGATE_PRIVATE_CLOUD: '', TOKEN_LIFETIME: '2h', LANGUAGE: 'zh-CN' }
}
export function assertAllowlistedDesignDatabase(database: string): void { if (!/^design_[a-f0-9]{16}$/u.test(database)) throw new Error('DbGate requires an allowlisted design database') }
export function assertLoopbackListeners(listeners: readonly string[]): void { if (listeners.some((listener) => !isLoopbackListener(listener))) throw new Error('non-loopback listener') }
export function assertDbGatePath(path: string, runtimeRoot: string): void { if (!isAbsolute(path) || !isAbsolute(runtimeRoot)) throw new Error('DbGate paths must be absolute'); const root = resolve(runtimeRoot); const target = resolve(path); if (target !== root && !target.startsWith(`${root}/`)) throw new Error('DbGate wrote outside its runtime directory') }
function isLoopbackListener(listener: string): boolean { const value = listener.toLowerCase().replaceAll(' ', ''); return value.startsWith('unix:') || value.startsWith('127.0.0.1:') || value.startsWith('localhost:') || value.startsWith('[::1]:') || value.startsWith('::1:') }
