import { basename, relative, resolve, sep } from 'node:path'
import { sha256Canonical } from '@dsh-backend-team/core'
import type { WorkspaceLayout } from '@dsh-backend-team/contracts'
import type { RuntimeManifest } from './runtime-manifest.js'
import { selectSpecKitArtifacts, selectUvArtifact } from './runtime-manifest.js'

export interface InstallPlanArtifact { readonly component: string; readonly version: string; readonly license: string; readonly source: string; readonly url: string; readonly bytes: number; readonly sha256: string; readonly allowedHosts: readonly string[]; readonly destination: string }
export interface ManagedPathPrecondition { readonly path: string; readonly state: 'missing' | 'directory' | 'file'; readonly dev?: number; readonly ino?: number; readonly mode?: number; readonly size?: number; readonly sha256?: string }
export interface RuntimeTreePrecondition { readonly path: string; readonly sha256: string }
export type NetworkPolicy = 'deny' | 'allow'
export interface InstallPlanCommand { readonly executable: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly executionFingerprint: string; readonly codeWillExecute: boolean; readonly networkPolicy: NetworkPolicy; readonly expectedExecutableSha256?: string }
export type InstallPlanIntent = 'runtime-install' | 'spec-kit-init'
export interface InstallPlan { readonly intent: InstallPlanIntent; readonly tool: string; readonly version: string; readonly source: string; readonly license: string; readonly destination: string; readonly artifacts: readonly InstallPlanArtifact[]; readonly commands: readonly InstallPlanCommand[]; readonly managedPaths: readonly ManagedPathPrecondition[]; readonly runtimeClosure?: readonly RuntimeTreePrecondition[] }
/** Full, user-visible authorization digest for one explicit install intent. */
export interface InstallApprovalDigest { readonly algorithm: 'sha256'; readonly value: string; readonly intent: InstallPlanIntent }
/** Builder contract deliberately limited to runtime installation, not Spec Kit initialization. */
export interface InstallPlanBuilder { buildRuntimeInstall(layout: WorkspaceLayout, manifests: RuntimeManifest, architecture: 'arm64' | 'x64', commands?: readonly InstallPlanCommand[], destination?: string): InstallPlan }

/** Builds only a declarative consent payload; installation is deliberately not performed here. */
export function buildInstallPlan(layout: WorkspaceLayout, manifests: RuntimeManifest, architecture: 'arm64' | 'x64', commands: readonly InstallPlanCommand[] = [], destination = '.backend-team/cache/downloads/uv-0.12.3.tar.gz'): InstallPlan {
  if (commands.some(isSpecifyInit)) throw new Error('specify init requires a separate spec-kit-init install plan')
  const artifact = selectUvArtifact(manifests.uv, architecture)
  assertWorkspaceRelativeDestination(layout.root, destination)
  const selectedArtifacts = [artifact, ...selectSpecKitArtifacts(manifests.specKit, architecture)].map(toCompleteArtifact)
  const plan: InstallPlan = {
    intent: 'runtime-install', tool: 'uv', version: manifests.uv.version, source: manifests.uv.source, license: manifests.uv.license, destination,
    artifacts: selectedArtifacts,
    commands: commands.map((command) => ({ ...command, args: [...command.args], env: { ...command.env } })), managedPaths: [],
  }
  const destinations = new Set<string>()
  for (const item of plan.artifacts) { assertWorkspaceRelativeDestination(layout.root, item.destination); if (destinations.has(item.destination)) throw new Error('install artifact destinations must be unique'); destinations.add(item.destination) }
  const artifacts: readonly InstallPlanArtifact[] = Object.freeze(plan.artifacts.map((item) => Object.freeze({ ...item, allowedHosts: Object.freeze([...item.allowedHosts]) })))
  const frozenCommands: readonly InstallPlanCommand[] = Object.freeze(plan.commands.map((item) => Object.freeze({ ...item, args: Object.freeze([...item.args]), env: Object.freeze({ ...item.env }) })))
  return Object.freeze({ ...plan, artifacts, commands: frozenCommands, managedPaths: Object.freeze([]) })
}

export function createInstallPlanBuilder(): InstallPlanBuilder { return Object.freeze({ buildRuntimeInstall: buildInstallPlan }) }
export function installApprovalDigest(plan: InstallPlan): InstallApprovalDigest { return Object.freeze({ algorithm: 'sha256', value: sha256Canonical(plan), intent: plan.intent }) }

function assertWorkspaceRelativeDestination(workspaceRoot: string, destination: string): void {
  if (destination.includes('\0')) throw new Error('install destination contains NUL')
  const resolved = resolve(workspaceRoot, destination)
  const rel = relative(workspaceRoot, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(destination) === destination && !resolved.startsWith(`${resolve(workspaceRoot)}${sep}`)) throw new Error('install destination must remain inside the workspace')
}
function isSpecifyInit(command: InstallPlanCommand): boolean { return basename(command.executable) === 'specify' && command.args[0] === 'init' }
function toCompleteArtifact(artifact: InstallPlanArtifact): InstallPlanArtifact { return artifact }
