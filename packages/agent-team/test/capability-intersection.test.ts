import { describe, expect, it } from 'vitest'
import { intersectCapabilities, intersectPaths } from '../src/capability-intersection.js'

describe('intersectCapabilities', () => {
  it('removes every requested privilege absent from a parent capability', () => {
    const child = intersectCapabilities(
      { readProjectFiles: true, networkHosts: ['api.example.test'] },
      {
        readProjectFiles: true,
        writeOwnedFiles: true,
        businessCodeWrite: true,
        commandExecution: true,
        install: true,
        networkHosts: ['api.example.test', 'other.example.test'],
        canDelegate: true,
        canChangePhase: true,
        canApprove: true,
        canContactUser: true,
        canAnnounceCompletion: true,
      },
      { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, commandExecution: true, install: true, networkHosts: ['api.example.test'] },
      { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, commandExecution: true, install: true, networkHosts: ['api.example.test'] },
    )

    expect(child).toMatchObject({ readProjectFiles: true, businessCodeWrite: false, install: false, commandExecution: false, canDelegate: false, canChangePhase: false, canApprove: false, canContactUser: false, canAnnounceCompletion: false })
    expect(child.networkHosts).toEqual(['api.example.test'])
  })

  it('keeps only requested paths bounded by both parent and preset ownership', () => {
    expect(intersectPaths(['src', 'tests'], ['src/users/service.ts', 'tests/users.spec.ts', 'private/token.ts'], ['src', 'tests'])).toEqual([
      'src/users/service.ts',
      'tests/users.spec.ts',
    ])
  })
})
