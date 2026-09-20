import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('published adapter surface', () => {
  it('does not publish synthetic matrix/version promotion helpers', async () => {
    const publicEntry = await import('../dist/index.js') as Record<string, unknown>
    const compatibilityEntry = await import('../dist/compatibility.js') as Record<string, unknown>
    const adapterEntry = await import('../dist/deepseek-harness-adapter.js') as Record<string, unknown>
    expect(publicEntry).not.toHaveProperty('assessHarnessCompatibilityForTest')
    expect(compatibilityEntry).not.toHaveProperty('assessHarnessCompatibilityForTest')
    expect(publicEntry).not.toHaveProperty('createDeepSeekHarnessAdapterForTest')
    expect(adapterEntry).not.toHaveProperty('createDeepSeekHarnessAdapterForTest')
  })

  it('publishes and loads the exact checked-in compatibility document beside dist', async () => {
    const source = await readFile(new URL('../../../docs/compatibility/deepseek-harness.json', import.meta.url), 'utf8')
    const published = await readFile(new URL('../dist/deepseek-harness.json', import.meta.url), 'utf8')
    expect(published).toBe(source)
    const compatibilityEntry = await import('../dist/compatibility.js') as typeof import('../dist/compatibility.js')
    expect(compatibilityEntry.loadTrustedCompatibilityMatrix()).toEqual(compatibilityEntry.parseCompatibilityMatrix(JSON.parse(published) as unknown))
  })
})
