import type { CommandRequest, CommandResult, PolicyContext, PolicyDecision } from '@dsh-backend-team/contracts'
import type { CommandExecutionEvidence } from '@dsh-backend-team/policy-engine'
import type { PolicyEngine } from '@dsh-backend-team/contracts'
import { execa } from 'execa'
import { realpath, stat } from 'node:fs/promises'

export interface CommandExecutorOptions { readonly shell: false; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly signal: AbortSignal; readonly maxBuffer: number; readonly reject: false; readonly extendEnv: false; readonly networkPolicy: 'deny' | 'allow' }
export type CommandExecutor = (executable: string, args: readonly string[], options: CommandExecutorOptions) => Promise<{ readonly failed?: boolean; readonly isMaxBuffer?: boolean; readonly isCanceled?: boolean; readonly isTerminated?: boolean; readonly timedOut?: boolean; readonly exitCode?: number; readonly stdout?: string; readonly stderr?: string }>
export interface ApprovalCommandExecutor { executeApprovedCommand<T>(token: string, input: { kind: 'install' | 'migration' | 'shared-config'; workspaceRoot: string; context: PolicyContext; action: Extract<import('@dsh-backend-team/contracts').PolicyAction, { kind: 'command' }> }, callback: (evidence: CommandExecutionEvidence) => Promise<T>): Promise<T | null> }
/** Structural port supplied only by the policy-engine's callback-scoped session. */
export interface InstallSessionCommandCapability { executeApprovedInstallCommand<T>(command: InstallSessionCommand, operation: (evidence: CommandExecutionEvidence) => Promise<T>): Promise<T> }
export interface InstallSessionCommand { readonly executable: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly executionFingerprint: string; readonly codeWillExecute: boolean; readonly networkPolicy: 'deny'; readonly expectedExecutableSha256?: string }
export interface NodeCommandRunnerOptions { readonly context: PolicyContext; readonly policyEngine: PolicyEngine; readonly approvalTokens: ApprovalCommandExecutor; readonly executor?: CommandExecutor; readonly maxBuffer?: number }

export class NodeCommandRunner {
  private readonly executor: CommandExecutor
  private readonly maxBuffer: number
  constructor(private readonly options: NodeCommandRunnerOptions) {
    this.executor = options.executor ?? defaultExecutor
    this.maxBuffer = options.maxBuffer ?? 1024 * 1024
  }

  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const action: Extract<import('@dsh-backend-team/contracts').PolicyAction, { kind: 'command' }> = { kind: 'command', executable: await realpath(request.executable), args: [...request.args], cwd: await realpath(request.cwd), env: { ...request.env }, executionFingerprint: request.executionFingerprint }
    const decision = await this.options.policyEngine.authorize(action, this.options.context)
    if (decision.effect === 'deny') throw new Error(`policy deny: ${decision.reason}`)
    if (decision.effect !== 'ask') throw new Error(`policy ${decision.effect} cannot execute a command`)
    if (request.approvalToken === undefined) throw new Error('approval token is required')
    const kind = approvalKind(request.risk, decision)
    const result = await this.options.approvalTokens.executeApprovedCommand(request.approvalToken, { kind, workspaceRoot: this.options.context.workspace.root, context: this.options.context, action }, async (evidence) => {
      if (!sameScope(evidence, action)) throw new Error('approved command evidence mismatch')
      return this.executeEvidence(evidence, signal, request.networkPolicy ?? 'allow')
    })
    if (result === null) throw new Error('approval token was rejected')
    return result
  }

  /** This path accepts only a callback-scoped policy-engine capability, never a raw approval token. */
  async runApprovedInstall(session: InstallSessionCommandCapability, request: CommandRequest & { readonly codeWillExecute: true }, signal?: AbortSignal): Promise<CommandResult> {
    if (request.networkPolicy !== 'deny') throw new Error('approved install command must deny network access')
    const networkPolicy = request.networkPolicy
    const command: InstallSessionCommand = Object.freeze({ executable: request.executable, args: Object.freeze([...request.args]), cwd: request.cwd, env: Object.freeze({ ...request.env }), executionFingerprint: request.executionFingerprint, codeWillExecute: request.codeWillExecute, networkPolicy, ...(request.expectedExecutableSha256 === undefined ? {} : { expectedExecutableSha256: request.expectedExecutableSha256 }) })
    return session.executeApprovedInstallCommand(command, async (evidence) => this.executeEvidence(evidence, signal, networkPolicy))
  }

  private async executeEvidence(evidence: CommandExecutionEvidence, signal: AbortSignal | undefined, networkPolicy: 'deny' | 'allow'): Promise<CommandResult> {
    const started = Date.now()
    try {
      const effectiveSignal = signal ?? new AbortController().signal
      const output = await this.executor(evidence.canonicalExecutable, evidence.args, { shell: false, cwd: evidence.canonicalCwd, env: evidence.env, signal: effectiveSignal, maxBuffer: this.maxBuffer, reject: false, extendEnv: false, networkPolicy })
      if (output.isMaxBuffer === true) return { exitCode: -1, stdout: boundedText(output.stdout), stderr: boundedText(output.stderr), durationMs: Date.now() - started, outputLimitExceeded: true }
      if (output.isCanceled === true || output.isTerminated === true || output.timedOut === true) throw abortError()
      if (output.failed === true && output.exitCode === undefined) throw new Error('command failed without an exit code')
      return { exitCode: output.exitCode ?? -1, stdout: boundedText(output.stdout), stderr: boundedText(output.stderr), durationMs: Date.now() - started }
    } catch (error: unknown) {
      if (isOutputLimitError(error)) return { exitCode: -1, stdout: errorText(error, 'stdout'), stderr: errorText(error, 'stderr'), durationMs: Date.now() - started, outputLimitExceeded: true }
      throw error
    }
  }
}

async function defaultExecutor(executable: string, args: readonly string[], processOptions: CommandExecutorOptions) {
  if (processOptions.networkPolicy === 'deny') {
    if (process.platform !== 'darwin') throw new Error('deny-network execution requires macOS sandbox-exec')
    let sandbox: string
    try { sandbox = await realpath('/usr/bin/sandbox-exec') } catch { throw new Error('deny-network execution requires /usr/bin/sandbox-exec') }
    if (sandbox !== '/usr/bin/sandbox-exec') throw new Error('sandbox-exec realpath is not the approved system executable')
    const identity = await stat(sandbox)
    if (!identity.isFile() || identity.nlink !== 1) throw new Error('sandbox-exec is not a verified regular file')
    return execa(sandbox, ['-p', '(version 1) (allow default) (deny network*)', executable, ...args], { shell: false, cwd: processOptions.cwd, env: processOptions.env, cancelSignal: processOptions.signal, maxBuffer: processOptions.maxBuffer, reject: false, extendEnv: false })
  }
  return execa(executable, [...args], { shell: false, cwd: processOptions.cwd, env: processOptions.env, cancelSignal: processOptions.signal, maxBuffer: processOptions.maxBuffer, reject: false, extendEnv: false })
}

function approvalKind(risk: CommandRequest['risk'], decision: PolicyDecision): 'install' | 'migration' | 'shared-config' {
  if (decision.approvalKind === 'install' || decision.approvalKind === 'migration' || decision.approvalKind === 'shared-config') return decision.approvalKind
  if (risk === 'install' || risk === 'migration') return risk
  throw new Error('command approval did not identify a recognized approval kind')
}

function sameScope(evidence: CommandExecutionEvidence, action: Extract<import('@dsh-backend-team/contracts').PolicyAction, { kind: 'command' }>): boolean {
  return evidence.canonicalExecutable === action.executable && evidence.canonicalCwd === action.cwd && evidence.executionFingerprint === action.executionFingerprint && JSON.stringify(evidence.args) === JSON.stringify(action.args) && JSON.stringify(evidence.env) === JSON.stringify(action.env)
}

function isOutputLimitError(error: unknown): error is { stdout?: unknown; stderr?: unknown; code?: unknown; isMaxBuffer?: unknown } { return typeof error === 'object' && error !== null && ((error as { isMaxBuffer?: unknown }).isMaxBuffer === true || (error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') }
function errorText(error: { stdout?: unknown; stderr?: unknown }, field: 'stdout' | 'stderr'): string { return typeof error[field] === 'string' ? error[field] : '' }
function boundedText(value: unknown): string { return typeof value === 'string' ? value : '' }
function abortError(): Error { const error = new Error('command aborted'); error.name = 'AbortError'; return error }
