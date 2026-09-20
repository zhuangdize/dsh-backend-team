import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { NvmManifest, NodeRuntimeManifest } from './node-runtime-manifest.js'
import { NodeRuntimeManifestResolver } from './node-runtime-manifest-resolver.js'

/** Narrow product-owned boundary; callers must supply a policy-approved adapter. */
export interface NodeRuntimeInstallationReceipt { readonly node: string; readonly npm: string; readonly npx: string; readonly exactVersion: string; readonly architecture: string; readonly archiveSha256: string; readonly nodeSha256: string; readonly npmSha256: string; readonly npxSha256: string; readonly runtimeTreeSha256: string }
export interface GuardedArtifactAdapter { provisionNvm(manifest: NvmManifest, targetDirectory: string, approval: { readonly token: string }, signal?: AbortSignal): Promise<string>; provisionNodeRuntime(manifest: NodeRuntimeManifest, targetDirectory: string, approval: { readonly token: string }, signal?: AbortSignal): Promise<NodeRuntimeInstallationReceipt> }
export interface WorkspaceNodeBootstrapOptions { readonly workspaceRoot: string; readonly adapter?: GuardedArtifactAdapter; readonly nvmManifest?: NvmManifest }
export class WorkspaceNodeBootstrap {
  constructor(private readonly options: WorkspaceNodeBootstrapOptions) {}
  async ensure(approval: { readonly token: string }, signal?: AbortSignal): Promise<string> {
    const workspace = await realpath(resolve(this.options.workspaceRoot)); const target = resolve(workspace, '.backend-team/runtime/nvm')
    const loader = join(target, 'nvm.sh')
    if (this.options.adapter === undefined) throw new Error('policy-owned guarded artifact adapter is required')
    const reviewed = new NodeRuntimeManifestResolver().nvmManifest()
    if (this.options.nvmManifest !== undefined && JSON.stringify(this.options.nvmManifest) !== JSON.stringify(reviewed)) throw new Error('NVM manifest is not the reviewed catalog manifest')
    if (approval.token.length === 0) throw new Error('install approval token is required')
    await mkdir(target, { recursive: true, mode: 0o700 })
    const downloaded = await this.options.adapter.provisionNvm(reviewed, target, approval, signal)
    const verified = await realpath(downloaded)
    if (verified !== loader) throw new Error('verified NVM loader is outside target workspace')
    return verified
  }
  async ensureRuntime(manifest: NodeRuntimeManifest, approval: { readonly token: string }, signal?: AbortSignal): Promise<NodeRuntimeInstallationReceipt> {
    if (this.options.adapter === undefined) throw new Error('policy-owned guarded artifact adapter is required')
    if (approval.token.length === 0) throw new Error('install approval token is required')
    return this.options.adapter.provisionNodeRuntime(manifest, resolve(this.options.workspaceRoot, '.backend-team/runtime/nvm'), approval, signal)
  }
}
