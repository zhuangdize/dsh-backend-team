import { join } from 'node:path'

export interface LocalDatabaseEndpoint { readonly socketDirectory: string; readonly host: '127.0.0.1'; readonly port?: number; readonly database: string; readonly user: string; readonly credentialRef: string }
export interface PostgresqlConfig { readonly postgresqlConf: string; readonly pgHbaConf: string; readonly files: readonly string[] }

/** Generates a loopback-only, SCRAM-only configuration with no trust entries. */
export function buildPostgresqlConfig(runtimeRoot: string, endpoint: Pick<LocalDatabaseEndpoint, 'socketDirectory' | 'port'>): PostgresqlConfig {
  // Darwin sockaddr_un accepts at most 103 bytes including the socket filename.
  // Managed clusters always allocate a loopback TCP port before startup.
  const directory = Buffer.byteLength(join(endpoint.socketDirectory, '.s.PGSQL.65535'), 'utf8') > 103 ? '' : endpoint.socketDirectory
  const socket = directory.replaceAll("'", "''")
  const port = endpoint.port === undefined ? [] : [`port = ${endpoint.port}`]
  const postgresqlConf = [`listen_addresses = '127.0.0.1'`, ...port, `unix_socket_directories = '${socket}'`, `password_encryption = 'scram-sha-256'`, `ssl = off`, `logging_collector = on`, `log_directory = '${join(runtimeRoot, 'logs').replaceAll("'", "''")}'`].join('\n') + '\n'
  const pgHbaConf = ['local all all scram-sha-256', 'host all all 127.0.0.1/32 scram-sha-256', 'host all all ::1/128 scram-sha-256', ''].join('\n')
  return Object.freeze({ postgresqlConf, pgHbaConf, files: Object.freeze(['postgresql.conf', 'pg_hba.conf']) })
}

export function assertLocalEndpoint(endpoint: LocalDatabaseEndpoint): void {
  if (endpoint.host !== '127.0.0.1' || (endpoint.port !== undefined && (endpoint.port < 1024 || endpoint.port > 65535)) || endpoint.socketDirectory.length === 0 || endpoint.database.length === 0 || endpoint.user.length === 0) throw new Error('database endpoint must be workspace-local loopback')
}
