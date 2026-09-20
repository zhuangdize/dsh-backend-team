import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalDatabaseEndpoint } from './postgresql-config.js'

export interface DatabaseCatalogAdapter {
  createDatabase(name: string, endpoint: LocalDatabaseEndpoint): Promise<void>
  databaseExists?(name: string, endpoint: LocalDatabaseEndpoint): Promise<boolean>
}
export interface ProjectDatabases { readonly development: string; readonly test: string }
export type DatabaseEndpointSource = LocalDatabaseEndpoint | (() => LocalDatabaseEndpoint)

export function projectDatabaseId(workspaceRoot: string): string { return `p_${createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16)}` }

export class DatabaseCatalog {
  constructor(private readonly workspaceRoot: string, private readonly endpointSource: DatabaseEndpointSource, private readonly adapter: DatabaseCatalogAdapter) {}
  async ensureProjectDatabases(projectId = projectDatabaseId(this.workspaceRoot)): Promise<ProjectDatabases> {
    assertDatabaseId(projectId)
    const endpoint = typeof this.endpointSource === 'function' ? this.endpointSource() : this.endpointSource
    await mkdir(join(this.workspaceRoot, '.backend-team', 'runtime', 'postgresql'), { recursive: true })
    const databases = { development: `${projectId}_dev`, test: `${projectId}_test` } as const
    for (const name of Object.values(databases)) if (this.adapter.databaseExists === undefined || !(await this.adapter.databaseExists(name, endpoint))) await this.adapter.createDatabase(name, endpoint)
    return databases
  }
}
export function assertDatabaseId(value: string): void { if (!/^[a-z0-9_]{1,50}$/.test(value)) throw new Error('database id must use lowercase letters, numbers, and underscores') }
