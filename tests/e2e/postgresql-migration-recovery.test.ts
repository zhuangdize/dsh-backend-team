import { describe, expect, it } from 'vitest'
import { DatabaseRecovery } from '../../packages/database/src/database-recovery.js'

describe('database recovery evidence', () => {
  it('reports an interrupted cluster without deleting data', async () => {
    const audit = await new DatabaseRecovery().audit({ status: { state: 'interrupted' }, expectedExecutable: '/missing/postgres', expectedDataDirectory: '/workspace/data', listeners: [], migrationJournalPresent: false })
    expect(audit.state).toBe('interrupted')
    expect(audit.reasons).toContain('cluster status is interrupted')
  })
})
