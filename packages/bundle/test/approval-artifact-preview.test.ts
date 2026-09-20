import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, symlink, writeFile, link, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readApprovalArtifactPreview } from '../src/approval-artifact-preview.js'

const roots: string[] = []
afterEach(async () => {
  // The test runner owns cleanup for these private temporary fixtures.
  for (const root of roots.splice(0)) await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }))
})

describe('readApprovalArtifactPreview', () => {
  it('returns text for the approved known documents and binds it to the pending hash', async () => {
    const fixture = await fixtureFiles({ 'spec.md': '# Requirements', 'clarification.md': 'No secrets' })
    const preview = await readApprovalArtifactPreview({
      workspaceRoot: fixture.workspace,
      artifactRegistry: fixture.registry,
      approvals: fixture.approvals,
      readRevision: () => 7,
      requestedArtifactId: fixture.hashes['spec.md']!,
    })

    expect(preview).toEqual({
      artifactHash: fixture.hashes['spec.md']!,
      files: [
        { path: 'specs/001-demo/spec.md', content: '# Requirements' },
        { path: 'specs/001-demo/clarification.md', content: 'No secrets' },
      ],
    })
  })

  it('rejects an artifact id that is not the current pending approval hash', async () => {
    const fixture = await fixtureFiles({ 'spec.md': '# Requirements' })
    await expect(readApprovalArtifactPreview({
      workspaceRoot: fixture.workspace,
      artifactRegistry: fixture.registry,
      approvals: fixture.approvals,
      readRevision: () => 7,
      requestedArtifactId: 'b'.repeat(64),
    })).rejects.toThrow(/pending approval|artifact hash/i)
  })

  it('rejects a stale revision before reading an artifact', async () => {
    const fixture = await fixtureFiles({ 'spec.md': '# Requirements' })
    let readCount = 0
    const registry = { snapshot: async () => { readCount += 1; return await fixture.registry.snapshot() } }
    await expect(readApprovalArtifactPreview({
      workspaceRoot: fixture.workspace,
      artifactRegistry: registry,
      approvals: fixture.approvals,
      readRevision: () => 8,
      requestedArtifactId: fixture.hashes['spec.md']!,
    })).rejects.toThrow(/revision/i)
    expect(readCount).toBe(1)
  })

  it('rejects symlink and hardlink artifact files', async () => {
    const fixture = await fixtureFiles({ 'spec.md': '# Requirements' })
    const outside = join(fixture.workspace, 'outside.md')
    await writeFile(outside, 'outside', 'utf8')
    await symlink(outside, join(fixture.feature, 'clarification.md'))
    const symlinkHash = sha256('outside')
    await expect(readApprovalArtifactPreview({
      workspaceRoot: fixture.workspace,
      artifactRegistry: {
        snapshot: async () => ({ ...await fixture.registry.snapshot(), artifacts: [
          ...((await fixture.registry.snapshot()).artifacts),
          { path: 'clarification.md', absolutePath: join(fixture.feature, 'clarification.md'), bytes: 7, sha256: symlinkHash },
        ] }),
      },
      approvals: fixture.approvals,
      readRevision: () => 7,
      requestedArtifactId: fixture.hashes['spec.md']!,
    })).rejects.toThrow(/symbolic|regular|private|unsafe/i)

    const hardlinkFixture = await fixtureFiles({ 'spec.md': '# Requirements' })
    await link(join(hardlinkFixture.feature, 'spec.md'), join(hardlinkFixture.feature, 'clarification.md'))
    await expect(readApprovalArtifactPreview({
      workspaceRoot: hardlinkFixture.workspace,
      artifactRegistry: {
        snapshot: async () => ({ ...await hardlinkFixture.registry.snapshot(), artifacts: [
          ...((await hardlinkFixture.registry.snapshot()).artifacts),
          { path: 'clarification.md', absolutePath: join(hardlinkFixture.feature, 'clarification.md'), bytes: 14, sha256: hardlinkFixture.hashes['spec.md']! },
        ] }),
      },
      approvals: hardlinkFixture.approvals,
      readRevision: () => 7,
      requestedArtifactId: hardlinkFixture.hashes['spec.md']!,
    })).rejects.toThrow(/hardlink|private|regular/i)
  })

  it('rejects a registry hash change during the preview read', async () => {
    const fixture = await fixtureFiles({ 'spec.md': '# Requirements' })
    let calls = 0
    const registry = {
      snapshot: async () => {
        calls += 1
        const snapshot = await fixture.registry.snapshot()
        return calls === 1 ? snapshot : { ...snapshot, artifacts: snapshot.artifacts.map(file => ({ ...file, sha256: 'c'.repeat(64) })) }
      },
    }
    await expect(readApprovalArtifactPreview({
      workspaceRoot: fixture.workspace,
      artifactRegistry: registry,
      approvals: fixture.approvals,
      readRevision: () => 7,
      requestedArtifactId: fixture.hashes['spec.md']!,
    })).rejects.toThrow(/changed|snapshot|stale/i)
  })

  it('rejects a non-primary document whose pending approval hash is stale', async () => {
    const fixture = await fixtureFiles({ 'spec.md': '# Requirements', 'clarification.md': 'No secrets' })
    const approvals = {
      listPending: () => [{ ...fixture.approvals.listPending()[0]!, request: { kind: 'requirements' as const, artifactHashes: { 'spec.md': fixture.hashes['spec.md']!, 'clarification.md': 'd'.repeat(64) } } }],
    }
    await expect(readApprovalArtifactPreview({
      workspaceRoot: fixture.workspace,
      artifactRegistry: fixture.registry,
      approvals,
      readRevision: () => 7,
      requestedArtifactId: fixture.hashes['spec.md']!,
    })).rejects.toThrow(/pending approval artifact hashes/i)
  })
})

async function fixtureFiles(files: Record<string, string>) {
  const rawWorkspace = await mkdtemp(join(tmpdir(), 'approval-preview-'))
  roots.push(rawWorkspace)
  const workspace = await realpath(rawWorkspace)
  const rawFeature = join(rawWorkspace, 'specs/001-demo')
  await mkdir(rawFeature, { recursive: true })
  const feature = await realpath(rawFeature)
  for (const [path, content] of Object.entries(files)) await writeFile(join(feature, path), content, 'utf8')
  const hashes = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)])) as Record<string, string>
  const registry = {
    snapshot: async () => ({ featureDirectory: feature, artifacts: Object.entries(files).map(([path, content]) => ({ path, absolutePath: join(feature, path), bytes: Buffer.byteLength(content), sha256: hashes[path]! })) }),
  }
  const approvals = { listPending: () => [{ id: 'approval-1', workspaceId: workspace, stateRevision: 7, artifactHash: hashes['spec.md']!, request: { kind: 'requirements' as const, summary: 'review' } }] }
  return { workspace, feature, hashes, registry, approvals }
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
