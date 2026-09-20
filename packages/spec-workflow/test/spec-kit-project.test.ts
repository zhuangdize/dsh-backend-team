import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readGenericIntegration } from '../src/spec-kit-project.js'

interface OfficialIntegrationFixture {
  version: string
  integration_state_schema: number
  installed_integrations: string[]
  integration_settings: {
    generic: {
      script: string
      raw_options: string
      parsed_options: { commands_dir: string }
      invoke_separator: string
    }
  }
  integration: string
  default_integration: string
}

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('official Spec Kit integration state', () => {
  it('accepts the exact official v0.16.5 generic integration document', async () => {
    const path = await fixturePath()
    await writeFile(path, `${JSON.stringify(officialIntegration())}\n`)

    await expect(readGenericIntegration(path)).resolves.toBe('generic')
  })

  it.each([
    ['missing top-level field', (value: OfficialIntegrationFixture) => { Reflect.deleteProperty(value, 'integration') }],
    ['extra top-level field', (value: OfficialIntegrationFixture) => { Object.assign(value, { extra: true }) }],
    ['wrong version', (value: OfficialIntegrationFixture) => { value.version = '0.16.4' }],
    ['wrong state schema', (value: OfficialIntegrationFixture) => { value.integration_state_schema = 2 }],
    ['wrong active integration', (value: OfficialIntegrationFixture) => { value.integration = 'claude' }],
    ['wrong default integration', (value: OfficialIntegrationFixture) => { value.default_integration = 'claude' }],
    ['wrong installed integrations', (value: OfficialIntegrationFixture) => { value.installed_integrations = ['generic', 'claude'] }],
    ['missing nested setting', (value: OfficialIntegrationFixture) => { Reflect.deleteProperty(value.integration_settings.generic, 'raw_options') }],
    ['extra nested setting', (value: OfficialIntegrationFixture) => { Object.assign(value.integration_settings.generic, { extra: true }) }],
    ['wrong raw options path', (value: OfficialIntegrationFixture) => { value.integration_settings.generic.raw_options = '--commands-dir /tmp/commands' }],
    ['wrong parsed options key', (value: OfficialIntegrationFixture) => { value.integration_settings.generic.parsed_options = { command_dir: '.backend-team/runtime/spec-kit/commands' } as unknown as { commands_dir: string } }],
    ['wrong parsed commands path', (value: OfficialIntegrationFixture) => { value.integration_settings.generic.parsed_options.commands_dir = '../commands' }],
    ['wrong invoke separator', (value: OfficialIntegrationFixture) => { value.integration_settings.generic.invoke_separator = '/' }],
  ] satisfies readonly (readonly [string, (value: OfficialIntegrationFixture) => void])[])('rejects %s', async (_name, mutate) => {
    const path = await fixturePath()
    const value = officialIntegration()
    mutate(value)
    await writeFile(path, JSON.stringify(value))

    await expect(readGenericIntegration(path)).rejects.toThrow(/pinned official generic v0\.16\.5 schema/i)
  })
})

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-project-'))
  roots.push(root)
  return join(root, 'integration.json')
}

function officialIntegration(): OfficialIntegrationFixture {
  return {
    version: '0.16.5',
    integration_state_schema: 1,
    installed_integrations: ['generic'],
    integration_settings: {
      generic: {
        script: 'sh',
        raw_options: '--commands-dir .backend-team/runtime/spec-kit/commands',
        parsed_options: { commands_dir: '.backend-team/runtime/spec-kit/commands' },
        invoke_separator: '.',
      },
    },
    integration: 'generic',
    default_integration: 'generic',
  }
}
