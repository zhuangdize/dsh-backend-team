import { createHash } from 'node:crypto'
import type { LocalDatabaseEndpoint } from './postgresql-config.js'

export interface SchemaDesignDatabaseAdapter { createDesignDatabase(name: string, sourceDatabase: string, endpoint: LocalDatabaseEndpoint): Promise<void>; captureSchema(database: string, endpoint: LocalDatabaseEndpoint): Promise<string>; dropDatabase(name: string, endpoint: LocalDatabaseEndpoint): Promise<void> }
export interface SchemaDesignSessionRecord { readonly id: string; readonly sourceDatabase: string; readonly database: string; readonly beforeSchemaHash: string; readonly beforeSchemaSql: string; readonly endpoint: LocalDatabaseEndpoint }
export class SchemaDesignSession {
  constructor(private readonly endpoint: LocalDatabaseEndpoint, private readonly adapter: SchemaDesignDatabaseAdapter) {}
  async open(sourceDatabase: string): Promise<SchemaDesignSessionRecord> {
    const id = createHash('sha256').update(`${sourceDatabase}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16); const database = `design_${id}`
    await this.adapter.createDesignDatabase(database, sourceDatabase, this.endpoint)
    try {
      const beforeSchemaSql = await this.adapter.captureSchema(database, this.endpoint)
      const beforeSchemaHash = createHash('sha256').update(beforeSchemaSql).digest('hex')
      return Object.freeze({ id, sourceDatabase, database, beforeSchemaHash, beforeSchemaSql, endpoint: this.endpoint })
    } catch (error: unknown) {
      try { await this.adapter.dropDatabase(database, this.endpoint) } catch (cleanupError: unknown) { throw new AggregateError([error, cleanupError], 'design database initialization and cleanup failed') }
      throw error
    }
  }
  capture(session: SchemaDesignSessionRecord): Promise<string> { return this.adapter.captureSchema(session.database, session.endpoint) }
  async discard(session: SchemaDesignSessionRecord): Promise<void> { await this.adapter.dropDatabase(session.database, session.endpoint) }
}
