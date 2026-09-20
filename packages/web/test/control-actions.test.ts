import { describe, expect, it } from 'vitest'
import { BackendTeamControlActionSchema } from '../src/index.js'

describe('BackendTeamControlActionSchema', () => {
  it('does not define an action that can approve on behalf of the user', () => {
    expect(BackendTeamControlActionSchema.safeParse({ type: 'force-approve' }).success).toBe(false)
  })
  it('requires the displayed hash and revision for approval decisions', () => {
    expect(BackendTeamControlActionSchema.safeParse({ type: 'decide-approval', workspaceId: 'ws', expectedRevision: 2, approvalId: 'a', decision: 'approve' }).success).toBe(false)
    expect(BackendTeamControlActionSchema.safeParse({ type: 'decide-approval', workspaceId: 'ws', expectedRevision: 2, approvalId: 'a', decision: 'approve', artifactHash: 'a'.repeat(64) }).success).toBe(true)
  })
})
