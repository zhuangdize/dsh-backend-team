import type { CommandRunner } from '@dsh-backend-team/contracts'
import { VerificationEngine, type VerificationReport } from './verification-engine.js'
import type { VerificationCommand, VerificationPurpose } from './verification-command.js'
import type { RequirementTrace } from './requirement-evidence.js'

export interface ProjectScriptManifest {
  readonly scripts?: Readonly<Record<string, string>>
}

export interface ProjectVerificationCommandInput {
  readonly idPrefix?: string
  readonly packageManagerExecutable: string
  readonly projectRoot: string
  readonly manifest: ProjectScriptManifest
  readonly evidenceByPurpose?: Readonly<Partial<Record<VerificationPurpose, readonly string[]>>>
  readonly environment?: Readonly<Record<string, string>>
}

export interface ProjectVerificationRunInput {
  readonly commands: readonly VerificationCommand[]
  readonly trace: RequirementTrace
  readonly signal?: AbortSignal
}

export interface ProjectVerificationResult {
  readonly report: VerificationReport
  readonly executed: readonly VerificationCommand[]
  readonly notRun: readonly { readonly purpose: VerificationPurpose; readonly reason: string }[]
}

const supported: readonly VerificationPurpose[] = ['typecheck', 'build', 'lint']

/** Builds safe argv from the actual package scripts; it never parses or executes shell text. */
export function projectVerificationCommands(input: ProjectVerificationCommandInput): readonly VerificationCommand[] {
  const scripts = input.manifest.scripts ?? {}
  const commands: VerificationCommand[] = []
  for (const purpose of supported) {
    const script = scriptForPurpose(scripts, purpose)
    if (script === undefined) continue
    const id = `${input.idPrefix ?? 'project'}-${purpose}`
    commands.push({
      id,
      argv: [input.packageManagerExecutable, 'run', script],
      cwd: input.projectRoot,
      purpose,
      evidenceIds: input.evidenceByPurpose?.[purpose] ?? [id],
      approvalRequired: true,
      networkPolicy: 'deny',
      ...(input.environment === undefined ? {} : { env: input.environment }),
    })
  }
  return Object.freeze(commands)
}

/** Runs the selected project scripts through the policy-owned command runner. */
export async function runProjectVerification(options: { readonly runner: CommandRunner; readonly input: ProjectVerificationRunInput; readonly baseline?: readonly VerificationCommand[] }): Promise<ProjectVerificationResult> {
  const engine = new VerificationEngine({ runner: options.runner })
  if (options.baseline !== undefined) await engine.captureBaseline(options.baseline, options.input.signal)
  const raw = await engine.verifyAll(options.input)
  // A standalone project check may not yet have acceptance IDs. Preserve the
  // engine's evidence map while still reporting the observable command result.
  const report = Object.keys(options.input.trace.requirements).length === 0
    ? Object.freeze({ ...raw, status: raw.results.some(result => result.status === 'blocked' || result.status === 'interrupted') ? 'blocked' as const : raw.results.some(result => result.status === 'failed') ? 'failed' as const : 'passed' as const })
    : raw
  return Object.freeze({ report, executed: Object.freeze([...options.input.commands]), notRun: Object.freeze(missingPurposes(options.input.commands)) })
}

function scriptForPurpose(scripts: Readonly<Record<string, string>>, purpose: VerificationPurpose): string | undefined {
  const names = purpose === 'typecheck' ? ['typecheck', 'type-check', 'check-types'] : purpose === 'build' ? ['build'] : ['lint']
  return names.find(name => typeof scripts[name] === 'string' && scripts[name]!.trim().length > 0)
}

function missingPurposes(commands: readonly VerificationCommand[]): readonly { readonly purpose: VerificationPurpose; readonly reason: string }[] {
  const present = new Set(commands.map(command => command.purpose))
  return Object.freeze(supported.filter(purpose => !present.has(purpose)).map(purpose => ({ purpose, reason: `project package manifest has no ${purpose} script` })))
}
