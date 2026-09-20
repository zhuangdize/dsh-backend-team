import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostgresqlArtifactVerifier, assertVerifiedRuntimeManifest, sourceManifest } from '../src/index.js'

describe('PostgreSQL artifact', () => {
  it('pins the official PostgreSQL 18.6 source hash', () => { expect(sourceManifest.sha256).toBe('555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f') })
  it('rejects an artifact with a non-workspace-runnable dylib', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pg-artifact-'))
    try {
      await mkdir(join(root, 'bin'), { recursive: true })
      for (const binary of ['postgres', 'initdb', 'pg_ctl', 'pg_isready', 'psql', 'createdb', 'dropdb', 'pg_dump', 'pg_restore']) await writeFile(join(root, 'bin', binary), '#!/bin/sh', { mode: 0o755 })
      const result = await new PostgresqlArtifactVerifier({ run: async (_executable, args) => args[0] === '-L' ? { exitCode: 0, stdout: `\t${root}/bin/postgres\n\t/opt/homebrew/opt/icu/lib/libicu.dylib\n`, stderr: '' } : { exitCode: 0, stdout: 'postgres (PostgreSQL) 18.6\n', stderr: '' } }).inspect(root)
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'EXTERNAL_DYLIB' }))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('accepts loader-relative dependencies that stay inside the artifact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pg-artifact-local-'))
    try {
      await mkdir(join(root, 'bin'), { recursive: true })
      await mkdir(join(root, 'lib'), { recursive: true })
      for (const binary of ['postgres', 'initdb', 'pg_ctl', 'pg_isready', 'psql', 'createdb', 'dropdb', 'pg_dump', 'pg_restore']) await writeFile(join(root, 'bin', binary), '#!/bin/sh', { mode: 0o755 })
      await writeFile(join(root, 'lib', 'libpq.5.dylib'), 'fixture')
      const result = await new PostgresqlArtifactVerifier({ run: async (executable, args) => {
        if (executable === '/usr/bin/otool') return { exitCode: 0, stdout: `${args[1]}:\n\t@loader_path/../lib/libpq.5.dylib\n\t/usr/lib/libSystem.B.dylib\n`, stderr: '' }
        return { exitCode: 0, stdout: 'postgres (PostgreSQL) 18.6\n', stderr: '' }
      } }).inspect(root)
      expect(result.valid).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('does not accept a pending native runtime manifest', () => {
    expect(() => assertVerifiedRuntimeManifest({ schemaVersion: 1, component: 'postgresql', version: '18.6', status: 'pending-native-build', sourceManifest: 'postgresql-source-18.6.json', artifacts: [] }, 'darwin-arm64')).toThrow(/pending native build/i)
  })
})
