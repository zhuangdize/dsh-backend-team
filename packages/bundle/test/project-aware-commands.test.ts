import { mkdtemp, mkdir, writeFile, realpath, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createWorkspaceLayout } from '@dsh-backend-team/platform-macos'
import { createProjectAwareCommands } from '../src/project-aware-commands.js'

it('refreshes repository facts for design without executing scripts or copying their contents', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-aware-')))
  try {
    const loader = createProjectAwareCommands(createWorkspaceLayout(root), { load: async (command, args) => ({ id: command, prompt: 'official ' + args, sourceRealPath: '/fixture/command.md', sourceSha256: 'a'.repeat(64) }) })
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '5.0.0' }, scripts: { test: 'touch should-not-exist; echo DO_NOT_INCLUDE_SCRIPT_BODY' } }))
    await writeFile(join(root, '.env'), 'SENTINEL_SECRET=NEVER_EXPOSE_THIS_VALUE')
    const first = await loader.load('speckit.specify', 'customer scope')
    expect(first.prompt).toContain('official customer scope')
    expect(first.prompt).toContain('express'); expect(first.prompt).toContain('unverified')
    expect(first.prompt).not.toContain('DO_NOT_INCLUDE_SCRIPT_BODY'); expect(first.prompt).not.toContain('NEVER_EXPOSE_THIS_VALUE')
    await expect(access(join(root, 'should-not-exist'))).rejects.toThrow()
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { fastify: '5.0.0' } }))
    const next = await loader.load('speckit.plan', 'approved scope')
    expect(next.prompt).toContain('fastify'); expect(next.prompt).not.toContain('"value":"express"')
    expect(next.sourceSha256).toBe(first.sourceSha256)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('does not mistake host state and runtime manifests for the business project', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-host-isolation-')))
  try {
    for (const name of ['.backend-team/state-old-task', '.specify']) {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, 'package.json'), JSON.stringify({ dependencies: { express: '5.0.0' } }))
    }
    const loader = createProjectAwareCommands(createWorkspaceLayout(root), { load: async id => ({ id, prompt: 'official', sourceRealPath: '/fixture.md', sourceSha256: 'b'.repeat(64) }) })
    const result = await loader.load('speckit.specify', 'new project')
    expect(result.prompt).toContain('"projectKind":"empty"')
    expect(result.prompt).not.toContain('"value":"express"')
    expect(result.prompt).toContain('不得替换已有代码')
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('separates business stack evidence from test fixtures while retaining test-tool detection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-fixture-isolation-')))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '5.0.0' }, devDependencies: { vitest: '4.0.0' } }))
    await mkdir(join(root, 'tests/fixtures/mysql'), { recursive: true })
    await writeFile(join(root, 'tests/fixtures/mysql/package.json'), JSON.stringify({ dependencies: { fastify: '5.0.0', mysql2: '3.0.0' } }))
    await writeFile(join(root, 'tests/detection.test.ts'), "const example = `import fastify from 'fastify'`; const connection = 'mysql://example.invalid/demo';")
    const loader = createProjectAwareCommands(createWorkspaceLayout(root), { load: async id => ({ id, prompt: 'official', sourceRealPath: '/fixture.md', sourceSha256: 'b'.repeat(64) }) })
    const result = await loader.load('speckit.plan', 'preserve stack')
    expect(result.prompt).toContain('"value":"express"')
    expect(result.prompt).toContain('"value":"vitest"')
    expect(result.prompt).not.toContain('"value":"fastify"')
    expect(result.prompt).not.toContain('"value":"mysql"')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('exposes ambiguous backend candidates and instructs the agent to ask before planning writes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-aware-boundary-')))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['services/*'] }))
    for (const [name, framework] of [['api-a', 'express'], ['api-b', 'fastify']] as const) {
      await mkdir(join(root, 'services', name), { recursive: true })
      await writeFile(join(root, 'services', name, 'package.json'), JSON.stringify({ dependencies: { [framework]: '5.0.0' }, scripts: { start: 'node server.js' } }))
    }
    const loader = createProjectAwareCommands(createWorkspaceLayout(root), { load: async id => ({ id, prompt: 'official', sourceRealPath: '/fixture.md', sourceSha256: 'c'.repeat(64) }) })
    const result = await loader.load('speckit.specify', 'ambiguous service')

    expect(result.prompt).toContain('serviceBoundarySelectionRequired')
    expect(result.prompt).toContain('services/api-a')
    expect(result.prompt).toContain('services/api-b')
    expect(result.prompt).toContain('必须在需求确认中向用户列出')
    expect(result.prompt).toContain('不得生成面向业务代码的写入计划')
  } finally { await rm(root, { recursive: true, force: true }) }
})
