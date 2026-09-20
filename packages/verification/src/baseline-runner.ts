import { VerificationCommandRunner, type CommandCapture, type VerificationCommand } from './verification-command.js'

export interface BaselineRunnerOptions {
  readonly commandRunner: VerificationCommandRunner
}

/** Runs the approved command set and retains the historical result for comparison. */
export class BaselineRunner {
  constructor(private readonly options: BaselineRunnerOptions) {}

  async capture(commands: readonly VerificationCommand[], signal?: AbortSignal): Promise<readonly CommandCapture[]> {
    const captures: CommandCapture[] = []
    for (const command of commands) captures.push(await this.options.commandRunner.run(command, signal))
    return Object.freeze(captures.map((capture) => Object.freeze(capture)))
  }
}
