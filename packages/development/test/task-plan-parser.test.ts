import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { TaskPlanParser } from '../src/index.js'

const base = {
  tasks: `# Tasks\n\n<!-- backend-team:task id=T-001 slice=S-001 requirements=AC-001,AC-002 owner=developer risk=standard layer=contract files=src/orders.ts -->\n- [ ] Define order API\n<!-- backend-team:task id=T-002 slice=S-001 requirements=AC-001 owner=developer risk=standard layer=domain depends=T-001 -->\n- [ ] Implement order rules\n<!-- backend-team:task id=T-003 slice=S-001 requirements=AC-002 owner=developer risk=standard layer=persistence depends=T-002 -->\n- [ ] Save order\n<!-- backend-team:task id=T-004 slice=S-001 requirements=AC-001,AC-002 owner=tester risk=standard layer=test depends=T-003 evidence=command:test-orders -->\n- [ ] Verify order behavior`,
  spec: '# Acceptance Criteria\n\n1. AC-001: users can create an order\n2. AC-002: orders are persisted',
  architecture: '# Architecture\norders',
  'data-model.md': '# Data Model\norders',
  'openapi.yaml': 'openapi: 3.1.0\npaths: {}',
  'test-plan.md': '# Test Plan\nAC-001\nAC-002',
}
const fixture = (changes: Partial<typeof base> = {}) => {
  const value = { ...base, ...changes }
  const names = ['tasks.md', 'spec.md', 'architecture.md', 'data-model.md', 'openapi.yaml', 'test-plan.md'] as const
  const fields = { 'tasks.md': 'tasks', 'spec.md': 'spec', 'architecture.md': 'architecture', 'data-model.md': 'data-model.md', 'openapi.yaml': 'openapi.yaml', 'test-plan.md': 'test-plan.md' } as const
  return { ...value, hashes: Object.fromEntries(names.map((name) => [name, createHash('sha256').update(value[fields[name]]).digest('hex')])) }
}

describe('TaskPlanParser', () => {
  it('groups API, domain, persistence and tests into one reviewable slice', async () => {
    const plan = await new TaskPlanParser().parse(fixture())
    expect(plan.slices[0]?.layers).toEqual(['contract', 'domain', 'persistence', 'test'])
    expect(plan.slices[0]?.requirementIds).toEqual(['AC-001', 'AC-002'])
    expect(plan.slices[0]?.dependencies).toEqual([])
  })

  it('converts task dependencies to slice dependencies and orders executable slices', async () => {
    const tasks = `<!-- backend-team:task id=T-2 slice=S-2 requirements=AC-001 owner=developer risk=standard layer=domain files=src/b.ts depends=T-1 evidence=tests -->\n- [ ] B\n<!-- backend-team:task id=T-1 slice=S-1 requirements=AC-001 owner=developer risk=standard layer=domain files=src/a.ts evidence=tests -->\n- [ ] A`
    const plan = await new TaskPlanParser().parse(fixture({ tasks, spec: 'AC-001: test' }))
    expect(plan.slices.map(slice => [slice.id, slice.dependencies])).toEqual([['S-1', []], ['S-2', ['S-1']]])
  })

  it('rejects an acceptance criterion with no planned evidence', async () => {
    const missing = fixture({ spec: `${base.spec}\n3. AC-003: audit trail` })
    await expect(new TaskPlanParser().parse(missing)).rejects.toThrow('AC-003 has no evidence task')
  })

  it('rejects an empty plan and task groupings that introduce a slice cycle', async () => {
    await expect(new TaskPlanParser().parse(fixture({ tasks: '# Tasks' }))).rejects.toThrow('no executable tasks')
    // Task graph is acyclic: T-1 -> T-2 -> T-3. Grouping T-1 and T-3 together is not executable.
    const tasks = [
      ['T-1', 'S-1', ''], ['T-2', 'S-2', 'depends=T-1'], ['T-3', 'S-1', 'depends=T-2'],
    ].map(([id, slice, dependency]) => `<!-- backend-team:task id=${id} slice=${slice} requirements=AC-001 owner=developer risk=standard layer=domain files=src/a.ts evidence=tests ${dependency} -->\n- [ ] Implement ${id}`).join('\n')
    await expect(new TaskPlanParser().parse(fixture({ tasks, spec: 'AC-001: test' }))).rejects.toThrow('slice dependency cycle')
  })

  it('rejects duplicate task IDs and dependency cycles', async () => {
    await expect(new TaskPlanParser().parse(fixture({ tasks: base.tasks.replace('id=T-004', 'id=T-003') }))).rejects.toThrow(/duplicate task id/i)
    await expect(new TaskPlanParser().parse(fixture({ tasks: base.tasks.replace('depends=T-003 evidence', 'depends=T-002,T-004 evidence') }))).rejects.toThrow(/dependency cycle/i)
  })

  it('verifies actual content hashes and rejects conflicting hash maps', async () => {
    const wrongMap = fixture()
    await expect(new TaskPlanParser().parse({ ...wrongMap, hashes: { ...wrongMap.hashes, 'tasks.md': 'a'.repeat(64) } })).rejects.toThrow(/hash/i)
    const inline = { ...fixture(), tasks: { content: base.tasks, sha256: 'a'.repeat(64) } }
    await expect(new TaskPlanParser().parse(inline)).rejects.toThrow(/hash/i)
    const valid = fixture()
    await expect(new TaskPlanParser().parse({ ...valid, artifactHashes: { ...valid.hashes, 'tasks.md': 'b'.repeat(64) } })).rejects.toThrow(/conflicting|hash/i)
  })

  it('requires one marker immediately before each executable task', async () => {
    await expect(new TaskPlanParser().parse(fixture({ tasks: `${base.tasks}\n<!-- backend-team:task id=T-005 slice=S-001 requirements=AC-001 owner=developer risk=standard -->` }))).rejects.toThrow(/marker|checkbox/i)
    await expect(new TaskPlanParser().parse(fixture({ tasks: base.tasks.replace('<!-- backend-team:task id=T-002', '<!-- backend-team:task id=T-X slice=S-001 requirements=AC-001 owner=developer risk=standard -->\n<!-- backend-team:task id=T-002') }))).rejects.toThrow(/marker/i)
  })

  it('rejects absolute, URI, wildcard, and Windows-drive paths', async () => {
    for (const path of ['/tmp/out.ts', 'C:/out.ts', 'https://example.com/x', '*.ts']) {
      await expect(new TaskPlanParser().parse(fixture({ tasks: base.tasks.replace('files=src/orders.ts', `files=${path}`) }))).rejects.toThrow(/path/i)
    }
  })

  it('returns the requirement trace and rejects unknown, duplicate, or malformed metadata', async () => {
    const plan = await new TaskPlanParser().parse(fixture())
    expect(plan.trace.requirements['AC-001']?.evidenceIds).toEqual(['command:test-orders'])
    for (const marker of ['foo=bar', 'id=T-001 id=T-002', 'owner']) {
      await expect(new TaskPlanParser().parse(fixture({ tasks: base.tasks.replace('risk=standard', `risk=standard ${marker}`) }))).rejects.toThrow(/marker field|marker token/i)
    }
  })

  it('rejects mutually exclusive metadata aliases', async () => {
    await expect(new TaskPlanParser().parse(fixture({ tasks: base.tasks.replace('files=src/orders.ts', 'files=src/a.ts paths=src/b.ts') }))).rejects.toThrow(/mutually exclusive/i)
    await expect(new TaskPlanParser().parse(fixture({ tasks: base.tasks.replace('depends=T-001', 'depends=T-001 dependencies=T-001') }))).rejects.toThrow(/mutually exclusive/i)
  })
})
