import { expect, it, vi } from 'vitest'
import { DrizzleMigrationAdapter, ExistingMigrationAdapter, type MigrationPreview } from '../src/index.js'

for (const Adapter of [DrizzleMigrationAdapter, ExistingMigrationAdapter]) {
  it(`${Adapter.name} applies the exact reviewed preview without regeneration`, async () => {
    const generate = vi.fn().mockResolvedValueOnce({ migrationId: 'm1', sql: 'CREATE TABLE x(id integer);' }).mockResolvedValue({ migrationId: 'm2', sql: 'DROP TABLE x;' })
    const apply = vi.fn<(preview: MigrationPreview, token: string, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined)
    const adapter = new Adapter({ generate, apply, status: async () => ({ applied: [], pending: [] }) })
    const preview = await adapter.preview()
    expect(await adapter.apply(preview, 'host-issued-token')).toEqual(preview)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(preview, 'host-issued-token', undefined)
    expect(Object.isFrozen(apply.mock.calls[0]?.[0])).toBe(true)
  })

  it(`${Adapter.name} refuses modified SQL and absent approval before running anything`, async () => {
    const apply = vi.fn<(preview: MigrationPreview, token: string, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined)
    const adapter = new Adapter({ generate: async () => ({ migrationId: 'm1', sql: 'CREATE TABLE x(id integer);' }), apply, status: async () => ({ applied: [], pending: [] }) })
    const preview = await adapter.preview()
    await expect(adapter.apply({ ...preview, sql: 'DROP TABLE x;' }, 'host-issued-token')).rejects.toThrow(/hash/)
    await expect(adapter.apply(preview, '')).rejects.toThrow(/approval/)
    expect(apply).not.toHaveBeenCalled()
  })
}

it('propagates a rejected host approval without reporting application success', async () => {
  const apply = vi.fn<(preview: MigrationPreview, token: string, signal?: AbortSignal) => Promise<void>>().mockRejectedValue(new Error('approval token cannot be consumed'))
  const adapter = new DrizzleMigrationAdapter({ generate: async () => ({ migrationId: 'm1', sql: 'DROP TABLE x;' }), apply, status: async () => ({ applied: [], pending: [] }) })
  const preview = await adapter.preview()
  await expect(adapter.apply({ ...preview, risk: 'standard' }, 'invalid')).rejects.toThrow(/risk/)
  expect(apply).not.toHaveBeenCalled()
  await expect(adapter.apply(preview, 'invalid')).rejects.toThrow('approval token cannot be consumed')
})
