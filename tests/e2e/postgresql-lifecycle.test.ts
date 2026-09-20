import { describe, expect, it } from 'vitest'
import { DatabaseApplicationComposition } from '../../packages/database/src/database-application-composition.js'

describe('database application composition', () => {
  it('exposes lifecycle and catalog actions without raw process tools', () => {
    const cluster = { status: () => ({ state: 'stopped' as const }), start: async () => ({ host: '127.0.0.1' as const, socketDirectory: '/workspace/socket', database: 'postgres', user: 'backend_team', credentialRef: 'ref' }), stop: async () => undefined }
    const catalog = { ensureProjectDatabases: async () => ({ development: 'p_dev', test: 'p_test' }) }
    const composition = new DatabaseApplicationComposition({ cluster: cluster as never, catalog: catalog as never })
    expect(composition.list().map((action) => action.name)).toEqual(['backend_database_status', 'backend_database_start', 'backend_database_stop', 'backend_database_prepare'])
    expect(composition.get('execute_sql')).toBeUndefined()
  })
})
