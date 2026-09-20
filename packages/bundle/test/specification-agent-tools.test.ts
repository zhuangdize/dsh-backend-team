import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentTaskSchema } from '@dsh-backend-team/contracts'
import { OwnershipManager } from '@dsh-backend-team/agent-team/ownership-manager'
import type { HarnessToolRegistrationDefinition, HarnessMonotonicGuard } from '@dsh-backend-team/harness-adapter'
import { createSpecificationAgentToolSetup } from '../src/specification-agent-tools.js'

async function fixture(role: 'requirements' | 'backend-architect' | 'planner' = 'requirements') {
  const outputs = role === 'requirements' ? ['spec.md', 'clarification.md'] : role === 'backend-architect' ? ['plan.md', 'architecture.md', 'contracts/openapi.yaml'] : ['tasks.md']
  const root = await realpath(await mkdtemp(join(tmpdir(), 'spec-tools-')))
  await mkdir(join(root, 'specs/demo'), { recursive: true })
  await writeFile(join(root, 'specs/demo/spec.md'), 'before')
  if (role === 'backend-architect') await mkdir(join(root, 'specs/demo/contracts'))
  const token = 'test-only-recovery-token-123456'
  const task = AgentTaskSchema.parse({ id: 'requirements-1', parentTaskId: 'coordinator-specification', depth: 1, role, objective: 'Write requirements', nonGoals: ['No source writes'], inputArtifacts: [], readPaths: [...new Set(['specs/demo/spec.md', ...outputs.map(file => 'specs/demo/' + file)])], writePaths: outputs.map(file => 'specs/demo/' + file), capabilities: { readProjectFiles: true, writeOwnedFiles: true }, budget: { maxTokens: 1000, maxWallMs: 10000, maxToolCalls: 20, maxRetries: 0, maxChildren: 0 }, doneWhen: ['Documents complete'], verification: [{ id: 'inspect', kind: 'inspection', instruction: 'Inspect documents', required: true }], returnSchema: 'AgentResult' })
  const owner = {}
  const tools = new Map<string, HarnessToolRegistrationDefinition>()
  let guard: HarnessMonotonicGuard | undefined
  const disposers: (() => void | Promise<void>)[] = []
  let phase = role === 'requirements' ? 'SPECIFY' : role === 'backend-architect' ? 'DESIGN' : 'PLAN'
  let feature = 'specs/demo'
  let approved = true
  let policyAllowed = true
  const setup = createSpecificationAgentToolSetup({ workspaceRoot: root, recoveryToken: token, policyEngine: { authorize: async () => ({ effect: policyAllowed ? 'allow' : 'deny', ruleId: 'fixture', reason: 'fixture' }) }, readPhase: async () => phase, readFeatureDirectory: async () => feature, verifyCurrentApproval: async () => { if (!approved) throw new Error('approval changed') } })
  const context = { agent: owner, effect: (body: () => () => void | Promise<void>) => { disposers.push(body()) }, tools: {
    presentAs: () => () => {}, register: (definition: HarnessToolRegistrationDefinition) => { tools.set(definition.name, definition); return () => {} }, guard: (callback: HarnessMonotonicGuard) => { guard = callback; return () => {} },
  } }
  const request = { role: task.role, task: task.objective, context: {}, agentTask: task }
  await setup(context, request)
  const execution = (name: string, agent: object = owner) => ({ name, agent, token: Symbol(), callId: 'call', rootCallId: 'call', arguments: {}, signal: new AbortController().signal })
  const call = (name: string, args: unknown, agent: object = owner) => tools.get(name)!.execute(args, execution(name, agent))
  const dispose = async () => { for (const disposer of disposers.toReversed()) await disposer() }
  return { root, task, setup, context, request, call, dispose, guard: (name: string) => guard!(execution(name)), revoke: () => { approved = false }, revokePolicy: () => { policyAllowed = false }, setPhase: (value: string) => { phase = value }, setFeature: (value: string) => { feature = value }, ownership: new OwnershipManager({ workspaceRoot: root, recoveryToken: token }), close: async () => { await dispose(); await rm(root, { recursive: true, force: true }) } }
}

it('writes only owned specification artifacts and releases its lease on disposal', async () => {
  const f = await fixture()
  try {
    await f.call('backend_team_write', { path: 'specs/demo/spec.md', content: 'after' })
    await f.call('backend_team_write', { path: 'specs/demo/clarification.md', content: 'created' })
    expect(await readFile(join(f.root, 'specs/demo/spec.md'), 'utf8')).toBe('after')
    await expect(f.call('backend_team_read', { path: 'specs/demo/spec.md' })).resolves.toMatchObject({ content: 'after' })
    expect(() => f.ownership.acquire('other', f.task.writePaths)).toThrow()
    await f.dispose()
    await expect(f.call('backend_team_write', { path: 'specs/demo/spec.md', content: 'wrong' })).rejects.toThrow('disposed')
    const lease = f.ownership.acquire('other', f.task.writePaths)
    f.ownership.release(lease)
  } finally { await f.close() }
})

it('explains a missing owned output without disguising it as a permission failure', async () => {
  const f = await fixture()
  try {
    await expect(f.call('backend_team_read', { path: 'specs/demo/clarification.md' })).rejects.toThrow('document does not exist yet')
    await f.call('backend_team_write', { path: 'specs/demo/clarification.md', content: 'Resolved answers' })
    await expect(f.call('backend_team_read', { path: 'specs/demo/clarification.md' })).resolves.toMatchObject({ content: 'Resolved answers' })
    f.revokePolicy()
    await expect(f.call('backend_team_read', { path: 'specs/demo/clarification.md' })).rejects.toThrow('host policy denied')
  } finally { await f.close() }
})

it('denies native tools, outside paths, other identities and changing host authority', async () => {
  const f = await fixture()
  try {
    expect(f.guard('bash')).toBeTruthy()
    expect(f.guard('write')).toBeTruthy()
    expect(f.guard('backend_team_write')).toBeUndefined()
    for (const path of ['src/a.ts', 'specs/other/spec.md', 'specs/demo/plan.md']) await expect(f.call('backend_team_write', { path, content: 'wrong' })).rejects.toThrow('scope')
    await expect(f.call('backend_team_read', { path: 'specs/demo/spec.md' }, {})).rejects.toThrow('identity')
    f.revoke()
    await expect(f.call('backend_team_write', { path: 'specs/demo/spec.md', content: 'wrong' })).rejects.toThrow('approval')
    f.setPhase('BUILD')
    await expect(f.call('backend_team_read', { path: 'specs/demo/spec.md' })).rejects.toThrow('phase')
  } finally { await f.close() }
})

it('rejects task impersonation, extra capabilities and changed feature directory', async () => {
  const f = await fixture()
  try {
    await expect(f.setup(f.context, { ...f.request, agentTask: { ...f.task, role: 'developer' } })).rejects.toThrow()
    await expect(f.setup(f.context, { ...f.request, agentTask: { ...f.task, capabilities: { ...f.task.capabilities, commandExecution: true } } })).rejects.toThrow('capabilities')
    f.setFeature('specs/other')
    await expect(f.call('backend_team_read', { path: 'specs/demo/spec.md' })).rejects.toThrow('feature')
  } finally { await f.close() }
})

it('keeps host denials effective for specification writes', async () => {
  const f = await fixture()
  try {
    f.revokePolicy()
    await expect(f.call('backend_team_write', { path: 'specs/demo/spec.md', content: 'wrong' })).rejects.toThrow('host policy denied')
  } finally { await f.close() }
})

it.each(['backend-architect', 'planner'] as const)('restricts %s to its stage documents and current approval', async role => {
  const f = await fixture(role)
  try {
    const path = f.task.writePaths[0]!
    await f.call('backend_team_write', { path, content: 'approved stage output' })
    if (role === 'backend-architect') {
      const contract = 'specs/demo/contracts/openapi.yaml'
      await f.call('backend_team_write', { path: contract, content: 'openapi: 3.1.0' })
      await expect(f.call('backend_team_read', { path: contract })).resolves.toMatchObject({ content: 'openapi: 3.1.0' })
    }
    await expect(f.call('backend_team_write', { path: 'specs/demo/spec.md', content: 'wrong' })).rejects.toThrow('scope')
    f.revoke()
    await expect(f.call('backend_team_write', { path, content: 'wrong' })).rejects.toThrow('approval')
    expect(await readFile(join(f.root, path), 'utf8')).toBe('approved stage output')
  } finally { await f.close() }
})

it('allows only one concurrent setup for a task ID', async () => {
  const f = await fixture()
  try {
    await f.dispose()
    const attempts = await Promise.allSettled([f.setup(f.context, f.request), f.setup(f.context, f.request)])
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find(attempt => attempt.status === 'rejected') as PromiseRejectedResult
    expect(String(rejected.reason)).toContain('already active')
  } finally { await f.close() }
})

it('reads an existing API contract without granting contract writes', async () => {
  const f = await fixture()
  try {
    await f.dispose()
    await mkdir(join(f.root, 'specs/demo/contracts'))
    const path = 'specs/demo/contracts/openapi.yaml'
    await writeFile(join(f.root, path), 'openapi: 3.1.0')
    await f.setup(f.context, { ...f.request, agentTask: { ...f.task, readPaths: [...f.task.readPaths, path] } })
    await expect(f.call('backend_team_read', { path })).resolves.toMatchObject({ content: 'openapi: 3.1.0' })
    await expect(f.call('backend_team_write', { path, content: 'wrong' })).rejects.toThrow('scope')
  } finally { await f.close() }
})
