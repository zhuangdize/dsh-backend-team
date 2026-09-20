import type { HarnessStructuralContext } from '@dsh-backend-team/harness-adapter'
import { DeepSeekHarnessAdapter } from '@dsh-backend-team/harness-adapter'
import { createDiagnosticTool, makeDiagnosticReport } from './diagnostic-plugin.js'
import { registerCodexModel, type CodexModelHost } from './codex-model-plugin.js'

export const name = '@dsh-backend-team/bundle'
export const inject = ['tools', 'llm'] as const

interface BundleHarnessContext extends CodexModelHost {
  readonly tools: {
    register(definition: unknown): () => void
    guard(guard: unknown): () => void
  }
}

export async function apply(context: BundleHarnessContext, config: { readonly codexAppServer?: unknown; readonly diagnosticStatusTool?: boolean } = {}): Promise<void> {
  if (typeof context !== 'object' || context === null) throw new TypeError('Harness context must be an object')
  if (config.diagnosticStatusTool !== false) {
    const adapter = await DeepSeekHarnessAdapter.create(context as HarnessStructuralContext)
    const report = makeDiagnosticReport(adapter.getCapabilityReport())
    adapter.registerDiagnosticTool(createDiagnosticTool(report))
  }
  registerCodexModel(context, config.codexAppServer)
}

export { FileMigrationReviewStore } from './migration-review-store.js'
export type { MigrationReviewStore, PersistedMigrationReview } from './migration-review-store.js'
