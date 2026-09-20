import { describe, expect, it } from 'vitest'
import { createFoundationFixture } from './foundation-fixture.js'

describe('Stage 01 foundation integration', () => {
  it('keeps untrusted provenance diagnostic-only without granting writes', async () => {
    const fixture = await createFoundationFixture({ harnessVersion: '0.1.0-rc.5' })
    const result = await fixture.boot()

    expect(result.requestedHarnessVersion).toBe('0.1.0-rc.5')
    expect(result.compatibilityCase).toBe('untrusted-provenance')
    expect(result.mode).toBe('read-only')
    expect(result.registeredTools).toEqual(['backend_team_status'])
    expect(result.workspaceWrites).toEqual([])
  })

  it('keeps unknown mode diagnostic-only', async () => {
    const fixture = await createFoundationFixture({ harnessVersion: 'not-a-version' })
    const result = await fixture.boot()

    expect(result.requestedHarnessVersion).toBe('not-a-version')
    expect(result.compatibilityCase).toBe('unknown')
    expect(result.mode).toBe('read-only')
    expect(result.registeredTools).toEqual(['backend_team_status'])
    expect(result.workspaceWrites).toEqual([])
  })

  it('observes a relative write in the actual isolated execution cwd', async () => {
    const fixture = await createFoundationFixture({ harnessVersion: '0.1.0-rc.5', writeProbe: true })
    const result = await fixture.boot()

    expect(result.compatibilityCase).toBe('untrusted-provenance')
    expect(result.workspaceWrites).toEqual(['foundation-write-probe.txt'])
  })
})
