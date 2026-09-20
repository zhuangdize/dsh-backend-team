import { constants, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { assertSafeWorkspacePath, ownershipLockDirectory, pathsOverlap, withOwnershipMutex } from '../src/path-overlap.js'

describe('path overlap', () => {
  it.each([
    ['src/users', 'src/users/service.ts', true],
    ['package.json', 'package.json', true],
    ['drizzle', 'drizzle/0002.sql', true],
    ['foo', 'foobar/index.ts', false],
  ])('classifies %s and %s without prefix confusion', (left, right, expected) => {
    expect(pathsOverlap(left, right)).toBe(expected)
  })

  it.each(['/absolute.ts', 'C:\\work\\src.ts', 'src/../private.ts', 'src\u0000/secret.ts', 'src/.env/api.ts', 'credentials/db.ts'])('rejects unsafe workspace paths: %s', (path) => {
    expect(() => assertSafeWorkspacePath(path)).toThrow(/safe|path|sensitive/i)
  })

  it('uses the platform advisory lock and fails closed on unsupported fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-ownership-mutex-'))
    const directory = ownershipLockDirectory(root)
    writeFileSync(join(directory, '.mutex'), JSON.stringify({ pid: 2147483647, nonce: 'stale' }), { mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL })
    const hasAdvisoryLock = (constants as unknown as { O_EXLOCK?: number }).O_EXLOCK !== undefined || process.platform === 'darwin'
    if (!hasAdvisoryLock) {
      expect(() => withOwnershipMutex(directory, () => 'acquired')).toThrow(/busy/i)
    } else {
      expect(withOwnershipMutex(directory, () => 'acquired')).toBe('acquired')
    }
    rmSync(root, { recursive: true, force: true })
  })
})
