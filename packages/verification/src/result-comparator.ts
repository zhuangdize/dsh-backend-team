import type { CommandCapture, VerificationStatus } from './verification-command.js'

export interface ResultComparison {
  readonly baselineFailures: readonly CommandCapture[]
  readonly finalFailures: readonly CommandCapture[]
  readonly newFailures: readonly CommandCapture[]
  readonly unchangedFailures: readonly CommandCapture[]
  readonly resolvedFailures: readonly CommandCapture[]
}

export function compareResults(baseline: readonly CommandCapture[], final: readonly CommandCapture[]): ResultComparison {
  const baselineFailureMap = new Map(baseline.filter(isFailure).map((capture) => [failureKey(capture), capture]))
  const finalFailureMap = new Map(final.filter(isFailure).map((capture) => [failureKey(capture), capture]))
  const unchangedFailures = [...finalFailureMap.entries()].filter(([key]) => baselineFailureMap.has(key)).map(([, capture]) => capture)
  const newFailures = [...finalFailureMap.entries()].filter(([key]) => !baselineFailureMap.has(key)).map(([, capture]) => capture)
  const resolvedFailures = [...baselineFailureMap.entries()].filter(([key]) => !finalFailureMap.has(key)).map(([, capture]) => capture)
  return { baselineFailures: [...baselineFailureMap.values()], finalFailures: [...finalFailureMap.values()], newFailures, unchangedFailures, resolvedFailures }
}

function isFailure(capture: CommandCapture): boolean { return capture.status === 'failed' || capture.status === 'blocked' || capture.status === 'interrupted' }
function failureKey(capture: CommandCapture): string { return `${capture.id}:${capture.status}:${capture.exitCode ?? ''}:${capture.stdoutSha256}:${capture.stderrSha256}` }

export function statusIsFailure(status: VerificationStatus): boolean { return status === 'failed' || status === 'blocked' || status === 'interrupted' }
