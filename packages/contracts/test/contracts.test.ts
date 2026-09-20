import { describe, expect, it } from 'vitest'
import { ApprovalTokenRecordSchema, BackendTeamStateSchema, PolicyActionSchema, PolicyContextSchema, PolicyDecisionSchema } from '../src/index.js'

describe('shared contracts', () => {
  it('rejects an illegal persisted phase', () => {
    expect(() => BackendTeamStateSchema.parse({
      schemaVersion: 1,
      revision: 0,
      workspaceRoot: '/tmp/project',
      phase: 'CODING_WITHOUT_APPROVAL',
      runs: [],
      approvals: [],
    })).toThrow()
  })

  it('requires an explicit reason for every policy decision', () => {
    expect(() => PolicyDecisionSchema.parse({ effect: 'deny' })).toThrow()
  })

  it('persists only a digest for an approval token secret', () => {
    expect(BackendTeamStateSchema.parse({
      schemaVersion: 1,
      revision: 0,
      workspaceRoot: '/tmp/project',
      phase: 'DISCOVER',
      runs: [],
      approvals: [],
      approvalTokens: [{
        tokenId: 'token-123456789012',
        kind: 'install',
        workspaceRoot: '/tmp/project',
        secretDigest: 'a'.repeat(64),
        actionDigest: 'b'.repeat(64),
        expiresAt: '2026-08-25T00:10:00.000Z',
        usedAt: null,
      }],
    })).toMatchObject({ approvalTokens: [{ tokenId: 'token-123456789012' }] })
  })

  it('recovers a pre-token v1 state with an empty required token ledger', () => {
    expect(BackendTeamStateSchema.parse({
      schemaVersion: 1, revision: 0, workspaceRoot: '/tmp/project', phase: 'DISCOVER', runs: [], approvals: [],
    }).approvalTokens).toEqual([])
  })

  it('requires explicit write-ownership evidence and validates canonical path evidence', () => {
    expect(() => PolicyContextSchema.parse({ phase: 'BUILD', workspace: {} })).toThrow()
    expect(PolicyDecisionSchema.parse({ effect: 'allow', reason: 'allowed', ruleId: 'owned', canonicalTargetPath: '/tmp/project/src/file.ts' }).canonicalTargetPath).toBe('/tmp/project/src/file.ts')
  })

  it('requires complete command execution scope and rejects unsafe token IDs', () => {
    expect(() => PolicyActionSchema.parse({ kind: 'command', executable: '/usr/bin/node', args: [], cwd: '/tmp/project' })).toThrow()
    expect(() => ApprovalTokenRecordSchema.parse({ tokenId: 'contains.dot.invalid', kind: 'install', workspaceRoot: '/tmp/project', secretDigest: 'a'.repeat(64), actionDigest: 'b'.repeat(64), expiresAt: '2026-08-25T00:00:00.000Z', usedAt: null })).toThrow()
  })
})
