import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProductionComposition } from '../src/production-composition.js'
import type { ExpertDispatchInput } from '../src/team-coordinator.js'

it.each([
  ['architecture.md', 'DESIGN', ['requirements']],
  ['spec.md', 'SPECIFY', []],
  ['tasks.md', 'BUILD', ['requirements', 'design']],
] as const)('recovers %s changes on restart without preserving stale approval or dispatching an Agent', async (file, phase, kinds) => {
  const root = await mkdtemp(join(tmpdir(), 'approval-restart-'))
  const contents: Record<string, string> = { 'spec.md': 'approved requirement', 'architecture.md': 'approved design', 'tasks.md': 'initial plan' }
  const snapshot = async () => ({ featureDirectory: root, artifacts: Object.entries(contents).map(([path, content]) => ({ path, sha256: createHash('sha256').update(content).digest('hex') })) })
  const options = {
    workspaceRoot: root, recoveryToken: 'restart-fixture-recovery-token',
    policyEngine: { authorize: async () => ({ effect: 'deny' as const, reason: 'unused', ruleId: 'fixture' }) },
    specification: { commandLoader: { load: () => { throw new Error('must not generate') } }, artifactRegistry: { snapshot }, artifactValidator: { validateForGate: async () => ({ valid: true }) } },
    agents: { verifiedProvenance: true as const, spawnAgent: async () => { throw new Error('must not dispatch') } },
  }
  let composition = await createProductionComposition(options)
  try {
    const hashes = Object.fromEntries((await snapshot()).artifacts.map(item => [item.path, item.sha256]))
    await composition.stateStore.transact(0, state => ({ ...state, phase: 'BUILD', approvals: ['requirements', 'design'].map(kind => ({ kind: kind as 'requirements' | 'design', artifactHashes: hashes, approvedAt: '2026-01-01T00:00:00.000Z', tokenId: kind + '-fixture-token' })) }))
    await composition.dispose()
    contents[file] = 'corrected content'
    composition = await createProductionComposition(options)
    expect((await composition.stateStore.load())?.phase).toBe(phase)
    expect((await composition.stateStore.load())?.approvals.map(item => item.kind)).toEqual(kinds)
    expect(composition.approvals.listPending()).toEqual([])
    const revision = (await composition.stateStore.load())!.revision
    await composition.dispose()
    composition = await createProductionComposition(options)
    expect((await composition.stateStore.load())!.revision).toBe(revision)
  } finally { await composition.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('reads approved files after startup and rejects changes before dispatch or result acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-artifacts-'))
  await writeFile(join(root, 'spec.md'), 'initial specification')
  const snapshot = async () => ({ featureDirectory: root, artifacts: [{ path: 'spec.md', sha256: createHash('sha256').update(await readFile(join(root, 'spec.md'))).digest('hex') }] })
  let dispatches = 0
  let mutateDuringResult = false
  const composition = await createProductionComposition({
    workspaceRoot: root, recoveryToken: 'fresh-artifacts-recovery-token',
    policyEngine: { authorize: async () => ({ effect: 'allow', reason: 'fixture', ruleId: 'fixture' }) },
    specification: { commandLoader: { load: () => { throw new Error('unused') } }, artifactRegistry: { snapshot }, artifactValidator: { validateForGate: async () => ({ valid: true }) } },
    agents: { verifiedProvenance: true, spawnAgent: async request => {
      dispatches++
      const taskId = request.agentTask!.id
      return { id: taskId, cancel: async () => {}, result: async () => {
        if (mutateDuringResult) await writeFile(join(root, 'spec.md'), 'unapproved in-flight modification')
        return { taskId, status: 'passed', summary: 'fixture', changedPaths: [], commands: [{ argv: ['fixture-test'], exitCode: 0 }], evidencePaths: [], risks: [], unresolvedItems: [], consumedBudget: { tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0 }, childResultIds: [], verification: { status: 'passed', verifiedBy: 'fixture', verifiedAt: '2026-01-01T00:00:00.000Z', records: [{ instructionId: 'tests', outcome: 'passed', evidencePaths: [] }] } }
      } }
    } },
  })
  const approve = async () => {
    const hashes = Object.fromEntries((await snapshot()).artifacts.map(item => [item.path, item.sha256]))
    const state = (await composition.stateStore.load())!
    await composition.stateStore.transact(state.revision, current => ({ ...current, phase: 'BUILD', approvals: ['requirements', 'design'].map(kind => ({ kind: kind as 'requirements' | 'design', artifactHashes: hashes, approvedAt: '2026-01-01T00:00:00.000Z', tokenId: kind + '-fixture-token' })) }))
  }
  const task = async (id: string): Promise<ExpertDispatchInput> => ({ id, role: 'developer', objective: 'Implement fixture', nonGoals: ['Do not change unrelated files'], inputArtifacts: (await snapshot()).artifacts, readPaths: ['src'], writePaths: ['src'], capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true }, budget: { maxTokens: 100, maxWallMs: 1000, maxToolCalls: 10, maxRetries: 0, maxChildren: 0 }, doneWhen: ['tests'], verification: [{ id: 'tests', kind: 'test', instruction: 'fixture', required: true }], returnSchema: 'fixture' })
  try {
    await writeFile(join(root, 'spec.md'), 'approved after startup')
    await approve()
    await expect(composition.coordinator.dispatchExpert(await task('fresh'))).resolves.toMatchObject({ parentVerification: { status: 'accepted' } })
    await writeFile(join(root, 'spec.md'), 'unapproved before dispatch')
    await expect(composition.coordinator.dispatchExpert(await task('unapproved'))).rejects.toThrow(/stale/)
    expect(dispatches).toBe(1)
    await approve()
    mutateDuringResult = true
    await expect(composition.coordinator.dispatchExpert(await task('changed-in-flight'))).rejects.toThrow(/stale/)
    expect((await composition.stateStore.load())?.runs.some(run => run.id === 'changed-in-flight')).toBe(false)
  } finally { await composition.dispose(); await rm(root, { recursive: true, force: true }) }
})
