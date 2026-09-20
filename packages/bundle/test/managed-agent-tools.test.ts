import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentTaskSchema } from '@dsh-backend-team/contracts'
import { OwnershipManager } from '@dsh-backend-team/agent-team/ownership-manager'
import type { HarnessToolRegistrationDefinition, HarnessMonotonicGuard } from '@dsh-backend-team/harness-adapter'
import { createManagedAgentToolSetup } from '../src/managed-agent-tools.js'

async function fixture(options: { readonly command?: boolean; readonly delegate?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-tools-')))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'migrations'))
  await writeFile(join(root, 'src/a.ts'), 'before')
  const token = 'test-only-recovery-token-123456'
  const ownership = new OwnershipManager({ workspaceRoot: root, recoveryToken: token })
  const task = AgentTaskSchema.parse({ id: 'task-1', parentTaskId: 'coordinator', depth: 1, role: 'developer', objective: 'Edit owned source', nonGoals: ['No outside writes'], inputArtifacts: [], readPaths: ['src'], writePaths: ['src/a.ts', 'src/new.ts', 'migrations/001.sql'], capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, ...(options.command ? { commandExecution: true } : {}), ...(options.delegate ? { canDelegate: true } : {}) }, budget: { maxTokens: 1000, maxWallMs: 10000, maxToolCalls: 20, maxRetries: 0, maxChildren: 3 }, doneWhen: ['Source checked'], verification: [{ id: 'inspect', kind: 'inspection', instruction: 'Read resulting source', required: true }], returnSchema: 'AgentResult' })
  const lease = ownership.acquire(task.id, task.writePaths)
  const owner = {}
  const tools = new Map<string, HarnessToolRegistrationDefinition>()
  let guard: HarnessMonotonicGuard | undefined
  let phase = 'BUILD'
  let approved = true
  let policyAllowed = true
  await createManagedAgentToolSetup({ workspaceRoot: root, recoveryToken: token, ...(options.command ? { commandRunner: { run: async (request) => ({ exitCode: 0, stdout: request.args.join(','), stderr: '', durationMs: 1 }) }, commandApprovalToken: async () => 'command-approval-token-123' } : {}), policyEngine: { authorize: async () => ({ effect: policyAllowed ? 'allow' : 'deny', ruleId: 'fixture-policy', reason: 'fixture policy decision' }) }, readPhase: async () => phase, verifyCurrentApproval: async () => { if (!approved) throw new Error('approval changed') } })({ agent: owner, tools: {
    presentAs: mode => { expect(mode).toBe('native'); return () => {} },
    register: definition => { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } },
    guard: callback => { guard = callback; return () => { guard = undefined } },
  } }, { role: 'worker', task: task.objective, context: {}, agentTask: task, ...(options.delegate ? { delegation: { delegateWorker: async (proposed) => ({ id: 'handoff-worker', taskId: proposed.id, status: 'completed', summary: 'worker done', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [], consumedBudget: { tokens: 1, wallMs: 1, toolCalls: 1, retries: 0, children: 0 }, childResultIds: [], parentVerification: { status: 'accepted' } }) } } : {}) })
  const execution = (name: string, agent: object = owner) => ({ name, agent, token: Symbol(), callId: 'call', rootCallId: 'call', arguments: {}, signal: new AbortController().signal })
  const call = (name: string, args: unknown, agent: object = owner) => tools.get(name)!.execute(args, execution(name, agent))
  return { root, tools, call, revokePolicy: () => { policyAllowed = false }, guard: (name: string, agent?: object) => guard!(execution(name, agent)), ownership, lease, setPhase: (value: string) => { phase = value }, revokeApproval: () => { approved = false }, close: async () => { ownership.release(lease); await rm(root, { recursive: true, force: true }) } }
}

it('performs real owned updates and creates through one guarded tool path', async () => {
  const f = await fixture()
  try {
    expect([...f.tools.keys()].sort()).toEqual(['backend_team_read', 'backend_team_scan', 'backend_team_typecheck', 'backend_team_write'])
    await expect(f.call('backend_team_read', { path: 'src/a.ts' })).resolves.toMatchObject({ content: 'before' })
    await expect(f.call('backend_team_write', { path: 'src/a.ts', content: 'after' })).resolves.toMatchObject({ path: 'src/a.ts' })
    await f.call('backend_team_write', { path: 'src/new.ts', content: 'created' })
    expect(await readFile(join(f.root, 'src/a.ts'), 'utf8')).toBe('after')
    expect(await readFile(join(f.root, 'src/new.ts'), 'utf8')).toBe('created')
  } finally { await f.close() }
})

it('denies native tools, other identities, undeclared paths and revoked authority', async () => {
  const f = await fixture()
  try {
    for (const name of ['bash', 'write', 'run_code', 'subagent', 'web_fetch']) expect(f.guard(name)).toBeTruthy()
    expect(f.guard('backend_team_read')).toBeUndefined()
    expect(f.guard('backend_team_read', {})).toBeTruthy()
    await expect(f.call('backend_team_write', { path: 'src/a.ts', content: 'wrong' }, {})).rejects.toThrow('identity')
    await expect(f.call('backend_team_write', { path: '../outside', content: 'wrong' })).rejects.toThrow()
    await expect(f.call('backend_team_write', { path: 'src/other.ts', content: 'wrong' })).rejects.toThrow('scope')
    f.revokeApproval()
    await expect(f.call('backend_team_write', { path: 'src/a.ts', content: 'wrong' })).rejects.toThrow('approval')
    expect(await readFile(join(f.root, 'src/a.ts'), 'utf8')).toBe('before')
    f.setPhase('DONE')
    await expect(f.call('backend_team_read', { path: 'src/a.ts' })).rejects.toThrow('phase')
  } finally { await f.close() }
})

it('rechecks the durable ownership lease at every write', async () => {
  const f = await fixture()
  try {
    f.ownership.release(f.lease)
    await expect(f.call('backend_team_write', { path: 'src/a.ts', content: 'wrong' })).rejects.toThrow(/lease|ownership|policy/)
    expect(await readFile(join(f.root, 'src/a.ts'), 'utf8')).toBe('before')
  } finally { await f.close() }
})

it('rechecks host policy for reads and writes after task setup', async () => {
  const f = await fixture()
  try {
    await expect(f.call('backend_team_read', { path: 'src/a.ts' })).resolves.toMatchObject({ content: 'before' })
    f.revokePolicy()
    await expect(f.call('backend_team_read', { path: 'src/a.ts' })).rejects.toThrow('host policy denied')
    await expect(f.call('backend_team_write', { path: 'src/a.ts', content: 'wrong' })).rejects.toThrow('host policy denied')
    expect(await readFile(join(f.root, 'src/a.ts'), 'utf8')).toBe('before')
  } finally { await f.close() }
})

it('explains that migration writes belong to the host approval flow', async () => {
  const f = await fixture()
  try {
    await expect(f.call('backend_team_write', { path: 'migrations/001.sql', content: 'CREATE TABLE example(id int);' })).rejects.toThrow('host-controlled')
    await expect(readFile(join(f.root, 'migrations/001.sql'), 'utf8')).rejects.toThrow()
  } finally { await f.close() }
})

it('scans declared files without exposing credentials and preserves identity, policy and approval checks', async () => {
  const f = await fixture()
  const secret = 'example-credential-for-test-only'
  try {
    await writeFile(join(f.root, 'src/a.ts'), `const apiKey = '${secret}';`)
    const result = await f.call('backend_team_scan', { path: 'src/a.ts' })
    expect(result).toMatchObject({ status: 'blocked', findings: [{ path: 'src/a.ts', line: 1 }] })
    expect(JSON.stringify(result)).not.toContain(secret)
    await expect(f.call('backend_team_scan', { path: 'outside.ts' })).rejects.toThrow('scope')
    await expect(f.call('backend_team_scan', { path: 'src/a.ts' }, {})).rejects.toThrow('identity')
    f.revokePolicy()
    await expect(f.call('backend_team_scan', { path: 'src/a.ts' })).rejects.toThrow('policy')
    f.revokeApproval()
    await expect(f.call('backend_team_scan', { path: 'src/a.ts' })).rejects.toThrow('approval')
  } finally { await f.close() }
})

it('does not grant typecheck execution merely because a worker can read and write', async () => {
  const f = await fixture()
  try { await expect(f.call('backend_team_typecheck', { files: ['src/a.ts'] })).rejects.toThrow('capability') } finally { await f.close() }
})

it('exposes project commands only with a host runner and short-lived approval token', async () => {
  const f = await fixture({ command: true })
  try {
    expect([...f.tools.keys()]).toContain('backend_team_command')
    await expect(f.call('backend_team_command', { executable: 'src/a.ts', args: ['--check'], purpose: 'project check', risk: 'read' })).resolves.toMatchObject({ exitCode: 0, approvalRequired: true, networkPolicy: 'deny' })
    await expect(f.call('backend_team_command', { executable: 'src/a.ts', args: [], purpose: 'install', risk: 'install' })).rejects.toThrow('installation')
  } finally { await f.close() }
})

it('exposes worker delegation only to a direct expert with an active callback', async () => {
  const f = await fixture({ delegate: true })
  try {
    expect([...f.tools.keys()]).toContain('backend_team_delegate_worker')
    await expect(f.call('backend_team_delegate_worker', { id: 'worker-1', parentTaskId: 'task-1', depth: 2, role: 'worker', objective: 'Inspect source', nonGoals: ['No writes'], inputArtifacts: [], readPaths: ['src'], writePaths: [], capabilities: { readProjectFiles: true }, budget: { maxTokens: 10, maxWallMs: 1000, maxToolCalls: 2, maxRetries: 0, maxChildren: 0 }, doneWhen: ['Report'], verification: [{ id: 'inspect', kind: 'inspection', instruction: 'Inspect', required: true }], returnSchema: 'AgentResult' })).resolves.toMatchObject({ taskId: 'worker-1', status: 'completed' })
  } finally { await f.close() }
})

it('publishes an explicit OpenAI-compatible schema for worker delegation', async () => {
  const f = await fixture({ delegate: true })
  try {
    const schema = f.tools.get('backend_team_delegate_worker')?.parameters as { type?: string; properties?: Record<string, unknown>; additionalProperties?: boolean }
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, properties: expect.any(Object) })
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(['id', 'parentTaskId', 'depth', 'role', 'objective', 'capabilities', 'budget', 'verification']))
  } finally { await f.close() }
})
