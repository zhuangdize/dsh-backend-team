export type FailureCategory =
  | 'requirements-contradiction'
  | 'permission-denied'
  | 'dependency-network'
  | 'missing-tool'
  | 'code-compile'
  | 'test-assertion'
  | 'migration-data-risk'
  | 'resource-budget'
  | 'harness-incompatibility'
  | 'interruption'
  | 'unknown'

export interface FailureInput {
  readonly category?: FailureCategory
  readonly code?: string
  readonly message?: string
  readonly output?: string
}

export interface ClassifiedFailure {
  readonly category: FailureCategory
  readonly message: string
  readonly recoverable: boolean
}

/** Converts untrusted child/tool failures into a small, deterministic vocabulary. */
export class FailureClassifier {
  classify(input: unknown): ClassifiedFailure {
    const failure = normalize(input)
    if (failure.category !== undefined) return classified(failure.category, failure.message)
    const text = `${failure.code ?? ''} ${failure.message} ${failure.output ?? ''}`.toLowerCase()
    if (/requirement|contradiction|specification conflict|scope conflict/u.test(text)) return classified('requirements-contradiction', failure.message)
    if (/permission|access denied|forbidden|ownership|approval is stale|approval is missing|eacces|eperm/u.test(text)) return classified('permission-denied', failure.message)
    if (/network|timeout|timed out|econn|fetch|registry|tool[- ]?busy|temporarily unavailable|503/u.test(text)) return classified('dependency-network', failure.message)
    if (/not found|enoent|missing tool|executable.*(?:missing|not)|command not found/u.test(text)) return classified('missing-tool', failure.message)
    if (/migration|data risk|destructive|drop table|irreversible/u.test(text)) return classified('migration-data-risk', failure.message)
    if (/budget|resource|out of memory|quota|rate limit/u.test(text)) return classified('resource-budget', failure.message)
    if (/harness|unsupported.*api|incompatible|integration/u.test(text)) return classified('harness-incompatibility', failure.message)
    if (/interrupt|cancel|aborted|sigterm|sigint/u.test(text)) return classified('interruption', failure.message)
    if (/assert|test failed|vitest|expect\(|snapshot/u.test(text)) return classified('test-assertion', failure.message)
    if (/compile|typecheck|typescript|tsc|syntax error/u.test(text)) return classified('code-compile', failure.message)
    return classified('unknown', failure.message)
  }
}

function normalize(input: unknown): FailureInput {
  if (typeof input === 'string') return { message: input }
  if (input instanceof Error) {
    const code = (input as NodeJS.ErrnoException).code
    return code === undefined ? { message: input.message } : { message: input.message, code }
  }
  if (typeof input === 'object' && input !== null) {
    const value = input as Record<string, unknown>
    return {
      ...(isCategory(value.category) ? { category: value.category } : {}),
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(typeof value.message === 'string' ? { message: value.message } : {}),
      ...(typeof value.output === 'string' ? { output: value.output } : {}),
    }
  }
  return { message: String(input) }
}

function classified(category: FailureCategory, message?: string): ClassifiedFailure {
  return { category, message: message ?? category, recoverable: category === 'dependency-network' || category === 'interruption' }
}

function isCategory(value: unknown): value is FailureCategory {
  return typeof value === 'string' && ['requirements-contradiction', 'permission-denied', 'dependency-network', 'missing-tool', 'code-compile', 'test-assertion', 'migration-data-risk', 'resource-budget', 'harness-incompatibility', 'interruption', 'unknown'].includes(value)
}
