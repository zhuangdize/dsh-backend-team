import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PolicyContext } from '@dsh-backend-team/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DefaultPolicyEngine, type SpecificationWriteGrantVerifier } from '../src/index.js'

describe('specification write capabilities', () => {
  let workspaceRoot: string
  let outsideRoot: string
  let context: PolicyContext

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-policy-specification-'))
    outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-policy-specification-outside-'))
    await mkdir(join(workspaceRoot, 'specs', 'feature-a'), { recursive: true })
    await mkdir(join(workspaceRoot, 'specs', 'feature-a', 'contracts'), { recursive: true })
    await mkdir(join(workspaceRoot, 'src'))
    await writeFile(join(workspaceRoot, 'specs', 'feature-a', 'spec.md'), 'old')
    await writeFile(join(workspaceRoot, 'src', 'owned.ts'), 'owned')
    await writeFile(join(outsideRoot, 'outside.md'), 'outside')
    context = { workspace: layout(workspaceRoot), phase: 'SPECIFY' }
  })

  afterEach(async () => {
    await Promise.all([
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ])
  })

  it('updates an allowed specification file with a separate grant', async () => {
    const verify = vi.fn<SpecificationWriteGrantVerifier['verify']>(async () => true)
    const engine = new DefaultPolicyEngine({ specificationWriteGrantVerifier: { verify } })

    await engine.executeSpecificationWrite(
      { kind: 'write', targetPath: 'specs/feature-a/spec.md' },
      context,
      async (handle) => { await handle.writeFile('updated') },
    )

    expect(await readFile(join(workspaceRoot, 'specs', 'feature-a', 'spec.md'), 'utf8')).toBe('updated')
    const canonicalRoot = await realpath(workspaceRoot)
    expect(verify).toHaveBeenCalledWith({
      action: { kind: 'write', targetPath: join(canonicalRoot, 'specs', 'feature-a', 'spec.md') },
      canonicalTargetPath: join(canonicalRoot, 'specs', 'feature-a', 'spec.md'),
      phase: 'SPECIFY',
    })
  })

  it('creates an allowed design artifact with a separate grant', async () => {
    const engine = new DefaultPolicyEngine({ specificationWriteGrantVerifier: { verify: async () => true } })

    await engine.executeSpecificationCreate(
      { kind: 'write', targetPath: 'specs/feature-a/plan.md' },
      { ...context, phase: 'DESIGN' },
      async (handle) => { await handle.writeFile('plan') },
    )

    expect(await readFile(join(workspaceRoot, 'specs', 'feature-a', 'plan.md'), 'utf8')).toBe('plan')
  })

  it('updates and creates only the designated design OpenAPI contract with a separate grant', async () => {
    await writeFile(join(workspaceRoot, 'specs', 'feature-a', 'contracts', 'openapi.yaml'), 'old')
    const verify = vi.fn<SpecificationWriteGrantVerifier['verify']>(async () => true)
    const engine = new DefaultPolicyEngine({ specificationWriteGrantVerifier: { verify } })
    const designContext = { ...context, phase: 'DESIGN' as const }

    await engine.executeSpecificationWrite(
      { kind: 'write', targetPath: 'specs/feature-a/contracts/openapi.yaml' },
      designContext,
      async (handle) => { await handle.writeFile('updated') },
    )
    await engine.executeSpecificationCreate(
      { kind: 'write', targetPath: 'specs/feature-a/contracts/openapi.yaml' },
      designContext,
      async (handle) => { await handle.writeFile('created') },
    ).catch(error => { expect(error).toMatchObject({ decision: { effect: 'deny' } }) })

    expect(await readFile(join(workspaceRoot, 'specs', 'feature-a', 'contracts', 'openapi.yaml'), 'utf8')).toBe('updated')
    expect(verify).toHaveBeenCalledTimes(2)

    await rm(join(workspaceRoot, 'specs', 'feature-a', 'contracts', 'openapi.yaml'))
    await engine.executeSpecificationCreate(
      { kind: 'write', targetPath: 'specs/feature-a/contracts/openapi.yaml' },
      designContext,
      async (handle) => { await handle.writeFile('created') },
    )
    expect(await readFile(join(workspaceRoot, 'specs', 'feature-a', 'contracts', 'openapi.yaml'), 'utf8')).toBe('created')
    expect(verify).toHaveBeenCalledTimes(3)
  })

  it('keeps owned and specification grants mutually exclusive', async () => {
    const owned = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async () => true } })
    const specification = new DefaultPolicyEngine({ specificationWriteGrantVerifier: { verify: async () => true } })

    await expect(owned.executeSpecificationWrite({ kind: 'write', targetPath: 'specs/feature-a/spec.md' }, context, async () => undefined)).rejects.toMatchObject({ decision: { effect: 'deny' } })
    await expect(specification.executeApprovedWrite({ kind: 'write', targetPath: 'src/owned.ts' }, { ...context, phase: 'BUILD' }, async () => undefined)).rejects.toMatchObject({ decision: { effect: 'deny' } })
  })

  it.each([
    ['BUILD', 'specs/feature-a/spec.md'],
    ['BUILD', 'specs/feature-a/contracts/openapi.yaml'],
    ['SPECIFY', 'src/owned.ts'],
    ['SPECIFY', 'specs/feature-a/contracts/openapi.yaml'],
    ['DESIGN', 'specs/feature-a/spec.md'],
    ['PLAN', 'specs/feature-a/contracts/openapi.yaml'],
    ['PLAN', 'specs/feature-a/architecture.ts'],
    ['PLAN', 'specs/feature-a/other.md'],
    ['DESIGN', 'specs/feature-a/nested/spec.md'],
    ['DESIGN', 'specs/feature-a/contracts/other.yaml'],
    ['DESIGN', 'specs/feature-a/contracts/nested/openapi.yaml'],
  ] as const)('denies phase %s or target %s outside the specification grant', async (phase, targetPath) => {
    const verify = vi.fn<SpecificationWriteGrantVerifier['verify']>(async () => true)
    const engine = new DefaultPolicyEngine({ specificationWriteGrantVerifier: { verify } })

    await expect(engine.executeSpecificationWrite({ kind: 'write', targetPath }, { ...context, phase }, async () => { throw new Error('must not write') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    expect(verify).not.toHaveBeenCalled()
  })

  it('denies absolute escapes, symlinks, and hardlinks before invoking the callback', async () => {
    const symlinkTarget = join(workspaceRoot, 'specs', 'feature-a', 'clarification.md')
    await symlink(join(outsideRoot, 'outside.md'), symlinkTarget)
    const hardlinkTarget = join(workspaceRoot, 'specs', 'feature-a', 'research.md')
    await link(join(outsideRoot, 'outside.md'), hardlinkTarget)
    const engine = new DefaultPolicyEngine({ specificationWriteGrantVerifier: { verify: async () => true } })
    let called = false

    for (const targetPath of [
      'specs/feature-a/clarification.md',
      'specs/feature-a/research.md',
      join(outsideRoot, 'outside.md'),
    ]) {
      await expect(engine.executeSpecificationWrite({ kind: 'write', targetPath }, context, async () => { called = true })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    }

    expect(called).toBe(false)
    expect(await readFile(join(outsideRoot, 'outside.md'), 'utf8')).toBe('outside')
  })

  it('denies an in-workspace symlinked specification parent', async () => {
    await mkdir(join(workspaceRoot, 'real-feature'))
    await symlink(join(workspaceRoot, 'real-feature'), join(workspaceRoot, 'specs', 'alias'))
    const engine = new DefaultPolicyEngine({ specificationWriteGrantVerifier: { verify: async () => true } })

    await expect(engine.executeSpecificationCreate({ kind: 'write', targetPath: 'specs/alias/tasks.md' }, { ...context, phase: 'PLAN' }, async () => { throw new Error('must not create') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    await expect(readFile(join(workspaceRoot, 'real-feature', 'tasks.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('denies OpenAPI contract symlinks and hardlinks', async () => {
    const symlinkTarget = join(workspaceRoot, 'specs', 'feature-a', 'contracts', 'openapi.yaml')
    await symlink(join(outsideRoot, 'outside.md'), symlinkTarget)
    const engine = new DefaultPolicyEngine({ specificationWriteGrantVerifier: { verify: async () => true } })
    const designContext = { ...context, phase: 'DESIGN' as const }

    await expect(engine.executeSpecificationWrite({ kind: 'write', targetPath: 'specs/feature-a/contracts/openapi.yaml' }, designContext, async () => { throw new Error('must not write') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    await rm(symlinkTarget)
    await link(join(outsideRoot, 'outside.md'), symlinkTarget)
    await expect(engine.executeSpecificationWrite({ kind: 'write', targetPath: 'specs/feature-a/contracts/openapi.yaml' }, designContext, async () => { throw new Error('must not write') })).rejects.toMatchObject({ decision: { effect: 'deny' } })
    expect(await readFile(join(outsideRoot, 'outside.md'), 'utf8')).toBe('outside')
  })
})

function layout(root: string): PolicyContext['workspace'] {
  return {
    root,
    teamDir: join(root, '.backend-team'),
    stateDir: join(root, '.backend-team/state'),
    runtimeDir: join(root, '.backend-team/runtime'),
    cacheDir: join(root, '.backend-team/cache'),
    logsDir: join(root, '.backend-team/logs'),
    locksDir: join(root, '.backend-team/locks'),
    handoffDir: join(root, '.backend-team/handoff'),
  }
}
