import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout, initializeWorkspaceLayout } from '@dsh-backend-team/platform-macos'
import { afterEach, describe, expect, it } from 'vitest'
import { SpecKitCommandLoader } from '../src/spec-kit-command-loader.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('SpecKitCommandLoader', () => {
  it('loads only a normalized command ID and substitutes every official argument marker', async () => {
    const fixture = await createFixture()
    const source = '# Specify\n$ARGUMENTS\n`$ARGUMENTS`\n$ARGUMENTS_EXTRA\n'
    await writeFile(join(fixture.commands, 'speckit.specify.md'), source)

    const loaded = await new SpecKitCommandLoader({ commandsDirectory: fixture.commands }).load('speckit.specify', 'Build users API')

    expect(loaded).toMatchObject({ id: 'speckit.specify', prompt: '# Specify\nBuild users API\n`Build users API`\n$ARGUMENTS_EXTRA\n', sourceRealPath: join(fixture.commands, 'speckit.specify.md'), sourceSha256: 'f36d6aa0a5d0ab2436c0315cb8babb91705df34df90e6de4e74c0398a3204b1c' })
  })

  it('inserts replacement text literally rather than applying String replacement metasyntax', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.commands, 'speckit.specify.md'), '$ARGUMENTS $ARGUMENTS')

    const loaded = await new SpecKitCommandLoader({ commandsDirectory: fixture.commands }).load('speckit.specify', '$& $$ $` $\'')

    expect(loaded.prompt).toBe('$& $$ $` $\' $& $$ $` $\'')
  })

  it.each(['../speckit.specify', 'speckit/plan', 'SPECKIT.specify', 'speckit..specify', 'speckit.specify '])('rejects a non-normalized command id %j before reading a file', async (id) => {
    const fixture = await createFixture()
    await expect(new SpecKitCommandLoader({ commandsDirectory: fixture.commands }).load(id, '')).rejects.toThrow(/normalized command id/i)
  })

  it('rejects unknown commands, symlinks, invalid UTF-8, and files over 1 MiB', async () => {
    const fixture = await createFixture()
    const loader = new SpecKitCommandLoader({ commandsDirectory: fixture.commands })
    await expect(loader.load('speckit.unknown', '')).rejects.toThrow(/unknown/i)

    const outside = join(fixture.root, 'outside.md'); await writeFile(outside, '$ARGUMENTS')
    await symlink(outside, join(fixture.commands, 'speckit.plan.md'))
    await expect(loader.load('speckit.plan', '')).rejects.toThrow(/symlink|commands directory/i)

    await writeFile(join(fixture.commands, 'speckit.clarify.md'), Buffer.from([0xc3, 0x28]))
    await expect(loader.load('speckit.clarify', '')).rejects.toThrow(/UTF-8/i)

    await writeFile(join(fixture.commands, 'speckit.tasks.md'), Buffer.alloc(1024 * 1024 + 1, 0x61))
    await expect(loader.load('speckit.tasks', '')).rejects.toThrow(/1 MiB|too large/i)
  })
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spec-kit-loader-')); roots.push(root)
  const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
  const commands = join(layout.runtimeDir, 'spec-kit/commands')
  await mkdir(commands, { recursive: true })
  return { root, commands }
}
