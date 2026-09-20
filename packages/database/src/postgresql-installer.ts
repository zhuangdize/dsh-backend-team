import { mkdir, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assertVerifiedRuntimeManifest, type PostgresqlRuntimeArtifact, type PostgresqlRuntimeManifest } from './postgresql-artifact.js'

export interface PostgresqlArtifactInstallAdapter { install(artifact: PostgresqlRuntimeArtifact, destination: string, approvalToken: string): Promise<string> }
export interface PostgresqlInstallerOptions { readonly workspaceRoot: string; readonly architecture: PostgresqlRuntimeArtifact['architecture']; readonly manifest: PostgresqlRuntimeManifest; readonly adapter: PostgresqlArtifactInstallAdapter }

export class PostgresqlInstaller {
  constructor(private readonly options: PostgresqlInstallerOptions) {}
  async ensureInstalled(approval: { readonly approved: boolean; readonly token?: string }): Promise<string> {
    if (approval.approved !== true || approval.token === undefined || approval.token.length === 0) throw new Error('PostgreSQL install approval token is required')
    const artifact = assertVerifiedRuntimeManifest(this.options.manifest, this.options.architecture)
    const destination = resolve(this.options.workspaceRoot, '.backend-team/runtime/postgresql/18.6', this.options.architecture)
    await mkdir(destination, { recursive: true, mode: 0o700 })
    const installed = await this.options.adapter.install(artifact, destination, approval.token)
    const canonical = await realpath(installed)
    if (canonical !== resolve(destination)) throw new Error('PostgreSQL runtime escaped the workspace')
    return canonical
  }
}
