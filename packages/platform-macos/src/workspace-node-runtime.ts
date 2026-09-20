import { isAbsolute, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { CommandRunner } from '@dsh-backend-team/contracts'
import { NodeRuntimeManifestResolver, type RuntimeSelection } from './node-runtime-manifest-resolver.js'
import type { NodeArchitecture, NodeRuntimeManifest } from './node-runtime-manifest.js'
import { WorkspaceNodeBootstrap, type NodeRuntimeInstallationReceipt } from './workspace-node-bootstrap.js'

export interface InstallApproval { readonly approved: boolean; readonly token?: string }
export interface WorkspaceNodeRuntimeOptions { readonly workspaceRoot: string; readonly resolver?: NodeRuntimeManifestResolver; readonly bootstrap: WorkspaceNodeBootstrap; readonly commandRunner: CommandRunner }
export interface RuntimeResolveInput { readonly selection: RuntimeSelection; readonly projectKind: string; readonly architecture: NodeArchitecture; readonly installApproval?: InstallApproval }
export interface WorkspaceNodeRuntimeResult { readonly manifest: NodeRuntimeManifest; readonly loaderRealPath: string; readonly nodeRealPath: string; readonly npmRealPath: string; readonly npxRealPath: string }
export class WorkspaceNodeRuntime {
  constructor(private readonly options: WorkspaceNodeRuntimeOptions) {}
  async resolve(input: RuntimeResolveInput): Promise<WorkspaceNodeRuntimeResult> {
    const manifest = (this.options.resolver ?? new NodeRuntimeManifestResolver()).resolve(input.selection, input.architecture)
    if (manifest.status === 'eol-existing-project-only' && /new-project/i.test(input.projectKind)) throw new Error('EOL runtime is existing-project-only')
    if (input.installApproval?.approved !== true || input.installApproval.token === undefined || input.installApproval.token.length === 0) throw new Error('install approval token is required')
    const loader = await this.options.bootstrap.ensure({ token: input.installApproval.token })
    const workspace = await realpath(resolve(this.options.workspaceRoot))
    const provisioned: NodeRuntimeInstallationReceipt = await this.options.bootstrap.ensureRuntime(manifest, { token: input.installApproval.token })
    if (provisioned.exactVersion !== manifest.exactVersion || provisioned.architecture !== manifest.architecture || provisioned.archiveSha256 !== manifest.sha256) throw new Error('runtime installation receipt does not match manifest')
    const expected = resolve(workspace, `.backend-team/runtime/nvm/versions/node/v${manifest.exactVersion}/bin`)
    const node = await this.inside(provisioned.node, workspace, resolve(expected, 'node')); const npm = await this.inside(provisioned.npm, workspace, resolve(expected, 'npm')); const npx = await this.inside(provisioned.npx, workspace, resolve(expected, 'npx'))
    return { manifest, loaderRealPath: await this.inside(loader, workspace, undefined, false), nodeRealPath: node, npmRealPath: npm, npxRealPath: npx }
  }
  private async inside(path: string, workspace: string, expected?: string, executable = true): Promise<string> {
    if (!isAbsolute(path)) throw new Error('runtime executable must be absolute')
    const target = await realpath(path)
    if (expected !== undefined && target !== await realpath(expected)) throw new Error('runtime executable does not match selected version')
    const details = await import('node:fs/promises').then((fs) => fs.stat(target)); if (!details.isFile() || details.size === 0 || (executable && (details.mode & 0o111) === 0)) throw new Error('runtime path is not a valid executable')
    const rel = relative(workspace, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('runtime executable escapes workspace')
    return target
  }
}
