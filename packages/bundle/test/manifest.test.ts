import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { assertBundleCompatibilityMatrixDocument } from '../scripts/compatibility-gate.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('diagnostic Bundle package shape', () => {
  it('declares the official Bundle patch manifest', async () => {
    const manifest = JSON.parse(await readFile(`${packageRoot}/package.json`, 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({
      name: '@dsh-backend-team/bundle',
      version: '0.1.0',
      type: 'module',
      main: 'lib/index.js',
      types: 'lib/index.d.ts',
      files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSES'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    expect((manifest.devDependencies as Record<string, string>).yaml).toBe('2.9.1')
  })

  it('parses exactly one official root insert row', async () => {
    const patch = parse(await readFile(`${packageRoot}/cordis.patch.yml`, 'utf8')) as unknown
    expect(patch).toEqual([{ insert: [{ id: 'backend-team', name: '@dsh-backend-team/bundle' }] }])
  })

  it('accepts the current pending or future verified rc.6 entry only', () => {
    const entry = { version: '0.1.0-rc.6', status: 'pending-real-smoke' }
    expect(() => assertBundleCompatibilityMatrixDocument({ schemaVersion: 1, entries: [entry] })).not.toThrow()
    expect(() => assertBundleCompatibilityMatrixDocument({ schemaVersion: 1, entries: [{ ...entry, status: 'verified' }] })).not.toThrow()
  })

  it.each([
    ['empty', []],
    ['missing rc.6', [{ version: '0.1.0-rc.5', status: 'pending-real-smoke' }]],
    ['extra version', [{ version: '0.1.0-rc.6', status: 'pending-real-smoke' }, { version: '0.1.0-rc.5', status: 'pending-real-smoke' }]],
  ])('rejects an %s compatibility matrix at the Bundle gate', (_label, entries) => {
    expect(() => assertBundleCompatibilityMatrixDocument({ schemaVersion: 1, entries })).toThrow()
  })
})
