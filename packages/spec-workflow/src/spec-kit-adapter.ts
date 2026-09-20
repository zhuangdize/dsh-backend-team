import type { CommandRequest, CommandResult, PolicyContext, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { sha256Canonical } from '@dsh-backend-team/core'
import type { InstallSessionCommandCapability } from '@dsh-backend-team/platform-macos'
import type { InstallPlan, InstallPlanCommand, ManagedPathPrecondition } from './install-plan.js'
import { assertRuntimeEnvironment } from './runtime-environment.js'
import { assertInstalledSpecKitEvidence, type InstalledSpecKit } from './spec-kit-installer.js'
import { SPEC_KIT_COMMANDS_RELATIVE_PATH, SpecKitProject, type ManagedPathSnapshot } from './spec-kit-project.js'

const INIT_ARGS = Object.freeze(['init', '--here', '--force', '--non-interactive', '--script', 'sh', '--integration', 'generic', `--integration-options=--commands-dir ${SPEC_KIT_COMMANDS_RELATIVE_PATH}`, '--ignore-agent-tools'])
const preparedBrand: unique symbol = Symbol('PreparedSpecKitInitialization')
const preparedRecords = new WeakMap<object, { readonly plan: InstallPlan; readonly before: readonly ManagedPathSnapshot[]; readonly specifySha256: string; readonly runtimeClosure: string }>()
export type SpecKitSessionCommandCapability = InstallSessionCommandCapability
export interface SpecKitInstallSession { execute<T>(token: string, input: { readonly workspaceRoot: string; readonly context: PolicyContext; readonly plan: InstallPlan }, callback: (session: { readonly commands: SpecKitSessionCommandCapability }) => Promise<T>): Promise<T> }
export interface SpecKitCommandRunner { runApprovedInstall(session: SpecKitSessionCommandCapability, request: CommandRequest & { readonly codeWillExecute: true }): Promise<CommandResult> }
export interface SpecKitAdapterOptions { readonly layout: WorkspaceLayout; readonly installedSpecKit: InstalledSpecKit; readonly environment: Readonly<Record<string, string>>; readonly context: PolicyContext; readonly session: SpecKitInstallSession; readonly runner: SpecKitCommandRunner }
export interface PreparedSpecKitInitialization { readonly [preparedBrand]: true; readonly plan: InstallPlan; readonly approvalDigest: string; readonly beforeForce: readonly ManagedPathSnapshot[] }
export interface InitializedSpecKit { readonly integration: 'generic'; readonly commandsDirectory: string; readonly beforeForce: readonly ManagedPathSnapshot[] }

export class SpecKitAdapter {
  private readonly project: SpecKitProject
  constructor(private readonly options: SpecKitAdapterOptions) { this.project = new SpecKitProject(options.layout) }
  async prepareInitialization(): Promise<PreparedSpecKitInitialization> {
    assertRuntimeEnvironment(this.options.layout, this.options.environment)
    const installed = await assertInstalledSpecKitEvidence(this.options.installedSpecKit, this.options.layout)
    const before = await this.project.snapshotBeforeForce()
    const plan = await buildSpecKitInitPlan(this.options.layout, installed, this.options.environment, before)
    const prepared = Object.freeze({ [preparedBrand]: true as const, plan, approvalDigest: sha256Canonical(plan), beforeForce: before })
    preparedRecords.set(prepared, Object.freeze({ plan, before, specifySha256: installed.specifySha256, runtimeClosure: JSON.stringify(installed.runtimeClosure) }))
    return prepared
  }
  async initialize(prepared: PreparedSpecKitInitialization, approvalToken: string): Promise<InitializedSpecKit> {
    const record = preparedRecords.get(prepared)
    if (record === undefined || prepared[preparedBrand] !== true || prepared.plan !== record.plan || prepared.beforeForce !== record.before || prepared.approvalDigest !== sha256Canonical(record.plan) || approvalToken.length === 0) throw new Error('prepared Spec Kit initialization is invalid')
    const result = await this.options.session.execute(approvalToken, { workspaceRoot: this.options.layout.root, context: this.options.context, plan: record.plan }, async (session) => {
      const installed = await assertInstalledSpecKitEvidence(this.options.installedSpecKit, this.options.layout)
      const fresh = await this.project.snapshotBeforeForce()
      if (installed.specifySha256 !== record.specifySha256 || JSON.stringify(installed.runtimeClosure) !== record.runtimeClosure || JSON.stringify(fresh) !== JSON.stringify(record.before)) throw new Error('prepared Spec Kit precondition snapshot changed')
      const command = record.plan.commands[0]!
      const request: CommandRequest & { readonly codeWillExecute: true } = Object.freeze({ executable: command.executable, args: command.args, cwd: command.cwd, env: command.env, purpose: 'initialize official Spec Kit generic integration', risk: 'install', executionFingerprint: command.executionFingerprint, ...(command.networkPolicy === undefined ? {} : { networkPolicy: command.networkPolicy }), ...(command.expectedExecutableSha256 === undefined ? {} : { expectedExecutableSha256: command.expectedExecutableSha256 }), codeWillExecute: true })
      const executed = await this.options.runner.runApprovedInstall(session.commands, request)
      if (executed.exitCode !== 0 || executed.outputLimitExceeded === true) throw new Error(`official Spec Kit initialization failed: ${redact(executed.stderr)}`)
      return this.project.requireInitializedGeneric()
    })
    return Object.freeze({ ...result, beforeForce: record.before })
  }
  async status() { return this.project.status() }
}

export async function buildSpecKitInitPlan(layout: WorkspaceLayout, installed: InstalledSpecKit, environment: Readonly<Record<string, string>>, managedPaths: readonly ManagedPathPrecondition[]): Promise<InstallPlan> {
  assertRuntimeEnvironment(layout, environment); await assertInstalledSpecKitEvidence(installed, layout)
  const base = { executable: installed.specifyPath, args: INIT_ARGS, cwd: layout.root, env: environment, codeWillExecute: true as const, networkPolicy: 'deny' as const, expectedExecutableSha256: installed.specifySha256 }
  const command: InstallPlanCommand = Object.freeze({ ...base, args: Object.freeze([...base.args]), env: Object.freeze({ ...base.env }), executionFingerprint: sha256Canonical(base) })
  return Object.freeze({ intent: 'spec-kit-init', tool: 'specify-cli', version: '0.16.5', source: 'https://github.com/github/spec-kit/tree/v0.16.5', license: 'MIT', destination: '.specify', artifacts: Object.freeze([]), commands: Object.freeze([command]), managedPaths: Object.freeze(managedPaths.map((item) => Object.freeze({ ...item }))), runtimeClosure: Object.freeze(installed.runtimeClosure.map((item) => Object.freeze({ ...item }))) })
}
function redact(value: string): string { return value.replace(/[A-Za-z0-9_=-]{24,}/gu, '[REDACTED]').slice(0, 512) }
