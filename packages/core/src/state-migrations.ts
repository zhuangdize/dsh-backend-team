import { BackendTeamStateSchema } from '@dsh-backend-team/contracts'
import type { BackendTeamState } from '@dsh-backend-team/contracts'

export interface LegacyStateV0 { readonly revision?: number; readonly workspaceRoot: string; readonly phase: BackendTeamState['phase']; readonly runs: BackendTeamState['runs']; readonly approvals: BackendTeamState['approvals'] }
export function migrateState(input: unknown): BackendTeamState {
  if (!input || typeof input !== 'object') throw new Error('state migration input must be an object')
  const version = (input as { schemaVersion?: unknown }).schemaVersion
  if (version === 1) return BackendTeamStateSchema.parse(input)
  if (version === 0 || version === undefined) {
    const legacy = input as LegacyStateV0
    return BackendTeamStateSchema.parse({ ...legacy, schemaVersion: 1, revision: legacy.revision ?? 0, approvalTokens: [] })
  }
  throw new Error(`unsupported state schema version: ${String(version)}`)
}
