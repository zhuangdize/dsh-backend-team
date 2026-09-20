import type { LocalDatabaseEndpoint } from './postgresql-config.js'
import { DatabaseSnapshot, type DatabaseCommandRunner, type SnapshotManifest } from './database-snapshot.js'
export class SchemaSnapshot {
  private readonly snapshots: DatabaseSnapshot
  constructor(options: { workspaceRoot: string; endpoint: LocalDatabaseEndpoint; runner: DatabaseCommandRunner; pgDumpPath?: string; serverVersion?: string }) { this.snapshots = new DatabaseSnapshot(options) }
  capture(database: string, reason: string): Promise<SnapshotManifest> { return this.snapshots.create(database, reason, 'schema') }
}
