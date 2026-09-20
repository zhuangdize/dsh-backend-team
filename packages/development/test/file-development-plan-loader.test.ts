import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { FileDevelopmentPlanLoader } from '../src/file-development-plan-loader.js'
const files = {
  'spec.md': 'AC-001: fixture requirement',
  'tasks.md': '<!-- backend-team:task id=T-1 slice=S-1 requirements=AC-001 owner=developer risk=standard layer=domain files=src/test.ts evidence=tests -->\n- [ ] Implement fixture',
  'architecture.md': '# Architecture', 'data-model.md': '# Data', 'contracts/openapi.yaml': 'openapi: 3.1.0', 'test-plan.md': 'AC-001: tests',
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'file-plan-'))), directory = join(root, 'specs/001-fixture')
  await mkdir(join(directory, 'contracts'), { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text)
  const snapshot = async () => ({ featureDirectory: directory, artifacts: await Promise.all(Object.keys(files).map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(directory, path))).digest('hex') }))) })
  return { root, directory, snapshot }
}
it('loads actual files and retains registry paths instead of inventing an OpenAPI alias', async () => {
  const f = await fixture()
  try {
    const plan = await new FileDevelopmentPlanLoader(f.root, f).load()
    expect(plan.slices[0]?.dependencies).toEqual([])
    expect(plan.artifactHashes['contracts/openapi.yaml']).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.artifactHashes['openapi.yaml']).toBeUndefined()
    expect(plan.slices[0]?.inputs).toEqual(plan.artifactHashes)
    expect(plan.artifactReadPaths).toEqual(expect.arrayContaining(['specs/001-fixture/spec.md', 'specs/001-fixture/contracts/openapi.yaml', 'specs/001-fixture/tasks.md']))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
it('rejects changed files, missing artifacts and symlink files before returning an executable plan', async () => {
  const f = await fixture()
  try {
    const saved = await f.snapshot()
    const loader = new FileDevelopmentPlanLoader(f.root, { snapshot: async () => saved })
    await writeFile(join(f.directory, 'tasks.md'), 'changed')
    await expect(loader.load()).rejects.toThrow('changed')
    await expect(new FileDevelopmentPlanLoader(f.root, { snapshot: async () => ({ ...saved, artifacts: [] }) }).load()).rejects.toThrow('missing')
    await rm(join(f.directory, 'tasks.md'))
    await symlink(join(f.directory, 'spec.md'), join(f.directory, 'tasks.md'))
    await expect(loader.load()).rejects.toThrow()
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
