import { describe, expect, it } from 'vitest'
import { migrateState } from '../src/index.js'
describe('state migrations', () => {
  it('migrates the legacy state to schema version 1 without changing business fields', () => { const result = migrateState({ schemaVersion: 0, revision: 2, workspaceRoot: '/workspace', phase: 'SPECIFY', runs: [], approvals: [] }); expect(result).toMatchObject({ schemaVersion: 1, revision: 2, workspaceRoot: '/workspace', phase: 'SPECIFY', approvalTokens: [] }) })
  it('rejects future state versions', () => { expect(() => migrateState({ schemaVersion: 99 })).toThrow(/unsupported state schema/) })
})
