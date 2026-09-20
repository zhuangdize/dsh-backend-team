import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('PostgreSQL native build script', () => {
  it('does not pass the removed PostgreSQL 18 --without-ssl configure flag', async () => {
    const script = await readFile(resolve(import.meta.dirname, '../../../scripts/build-postgresql-runtime.sh'), 'utf8')
    const configureInvocation = script.split('\n').find((line) => line.trim().startsWith('./configure'))
    expect(configureInvocation).toBeDefined()
    expect(configureInvocation).not.toContain('--without-ssl')
  })

  it('rewrites libpq references to an archive-local loader path', async () => {
    const script = await readFile(resolve(import.meta.dirname, '../../../scripts/build-postgresql-runtime.sh'), 'utf8')
    expect(script).toContain('install_name_tool')
    expect(script).toContain('@loader_path/../lib/libpq.5.dylib')
    expect(script).toContain('WORK="$(cd "$(mktemp -d')
    expect(script).toContain('pwd -P)"')
  })

  it('normalizes the native Intel name to the manifest architecture', async () => {
    const script = await readFile(resolve(import.meta.dirname, '../../../scripts/build-postgresql-runtime.sh'), 'utf8')
    expect(script).toContain('x86_64) ARCH="x64"')
  })
})
