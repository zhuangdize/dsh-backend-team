import { expect, it } from 'vitest'
import { SliceExecutor, type ExpertDispatchRequest } from '../src/slice-executor.js'
import type { DevelopmentPlan, VerticalSlice } from '../src/vertical-slice.js'

it('preserves task instructions and prerequisite reads through development, repair and retest without widening writes', async () => {
  const base: VerticalSlice = { id: 'domain', taskIds: [], layers: ['domain'], requirementIds: [], inputs: {}, expectedPaths: ['src/decide.mjs'], apiOperations: [], dataChanges: [], testEvidence: [], dependencies: [], rollbackBoundary: 'domain', completionConditions: [] }
  const slice: VerticalSlice = { ...base, id: 'http-test', taskIds: ['T-3'], expectedPaths: ['test/health.test.mjs'], dependencies: ['http'], testEvidence: ['HTTP response checks'] }
  const plan: DevelopmentPlan = {
    requirements: [], trace: { requirements: {} }, artifactHashes: {}, artifactReadPaths: ['specs/health/spec.md'],
    slices: [base, { ...base, id: 'http', expectedPaths: ['src/server.mjs'], dependencies: ['domain'] }, slice, { ...base, id: 'unrelated', expectedPaths: ['src/unrelated.mjs'] }],
    tasks: [{ id: 'T-3', sliceId: 'http-test', requirementIds: [], owner: 'qa', risk: 'standard', dependencies: [], layer: 'test', evidence: ['HTTP response checks'], files: ['test/health.test.mjs'], objective: 'Assert GET /health returns exactly {"ok":true} and POST returns 405.' }],
  }
  const requests: ExpertDispatchRequest[] = []
  const executor = new SliceExecutor({ patchTracker: { begin: async () => ({}) }, teamCoordinator: { dispatchExpert: async input => {
    requests.push(input)
    const fail = requests.length === 2
    return { id: input.id, taskId: input.id, status: fail ? 'failed' : 'completed', summary: fail ? 'test assertion failed' : 'done', risks: [], parentVerification: { status: fail ? 'needs-rework' : 'accepted' } } as never
  } } })
  expect((await executor.execute(slice, plan)).status).toBe('passed')
  expect(requests.map(request => request.role)).toEqual(['developer', 'tester', 'fixer', 'tester'])
  for (const request of requests) {
    expect(request.objective).toContain('T-3: Assert GET /health returns exactly {"ok":true} and POST returns 405.')
    expect(request.readPaths).toEqual(expect.arrayContaining(['src/decide.mjs', 'src/server.mjs', 'test/health.test.mjs']))
    expect(request.readPaths).not.toContain('src/unrelated.mjs')
    expect(request.readPaths).toContain('specs/health/spec.md')
    expect(request.writePaths).toEqual(['test/health.test.mjs'])
  }
})

it('keeps migration files outside Agent read/write ownership', async () => {
  const slice: VerticalSlice = { id: 'persistence', taskIds: ['T-3'], layers: ['persistence'], requirementIds: [], inputs: {}, expectedPaths: ['migrations/0001_people.sql', 'src/people.ts', 'test/people.test.mjs'], apiOperations: [], dataChanges: [], testEvidence: ['person tests'], dependencies: [], rollbackBoundary: 'persistence', completionConditions: ['migration preview is host-controlled'] }
  const plan: DevelopmentPlan = { requirements: [], trace: { requirements: {} }, artifactHashes: {}, slices: [slice], tasks: [{ id: 'T-3', sliceId: 'persistence', requirementIds: [], owner: 'developer', risk: 'high', dependencies: [], layer: 'persistence', evidence: ['person tests'], files: [...slice.expectedPaths], objective: 'Implement personnel persistence.' }] }
  const requests: ExpertDispatchRequest[] = []
  const executor = new SliceExecutor({ patchTracker: { begin: async () => ({}) }, teamCoordinator: { dispatchExpert: async input => {
    requests.push(input)
    return { id: input.id, taskId: input.id, status: 'completed', summary: 'done', risks: [], parentVerification: { status: 'accepted' } } as never
  } } })
  await executor.execute(slice, plan)
  expect(requests.map(request => request.role)).toEqual(['developer', 'tester'])
  expect(requests[0]?.writePaths).toEqual(['src/people.ts', 'test/people.test.mjs'])
  expect(requests[1]?.writePaths).toEqual(['test/people.test.mjs'])
  expect(requests[0]?.readPaths).not.toContain('migrations/0001_people.sql')
  expect(requests[0]?.objective).toContain('Host-owned migration files are excluded')
})

it('splits multi-task slices into bounded developer handoffs by task files', async () => {
  const slice: VerticalSlice = { id: 'contract-domain', taskIds: ['T-1', 'T-2'], layers: ['contract', 'domain'], requirementIds: [], inputs: {}, expectedPaths: ['src/contract.ts', 'src/validation.ts'], apiOperations: [], dataChanges: [], testEvidence: ['domain tests'], dependencies: [], rollbackBoundary: 'contract-domain', completionConditions: [] }
  const plan: DevelopmentPlan = {
    requirements: [], trace: { requirements: {} }, artifactHashes: {}, slices: [slice],
    tasks: [
      { id: 'T-1', sliceId: slice.id, requirementIds: [], owner: 'developer', risk: 'standard', dependencies: [], layer: 'contract', evidence: ['contract tests'], files: ['src/contract.ts'], objective: 'Implement the contract.' },
      { id: 'T-2', sliceId: slice.id, requirementIds: [], owner: 'developer', risk: 'standard', dependencies: ['T-1'], layer: 'domain', evidence: ['domain tests'], files: ['src/validation.ts'], objective: 'Implement validation.' },
    ],
  }
  const requests: ExpertDispatchRequest[] = []
  const executor = new SliceExecutor({ patchTracker: { begin: async () => ({}) }, teamCoordinator: { dispatchExpert: async input => {
    requests.push(input)
    return { id: input.id, taskId: input.id, status: 'completed', summary: 'done', risks: [], parentVerification: { status: 'accepted' } } as never
  } } })
  expect((await executor.execute(slice, plan)).status).toBe('passed')
  expect(requests.map(request => request.role)).toEqual(['developer', 'developer', 'tester'])
  expect(requests[0]?.writePaths).toEqual(['src/contract.ts'])
  expect(requests[1]?.writePaths).toEqual(['src/validation.ts'])
  expect(requests[0]?.readPaths).toEqual(expect.arrayContaining(['src/contract.ts']))
  expect(requests[1]?.readPaths).toEqual(expect.arrayContaining(['src/contract.ts', 'src/validation.ts']))
  expect(requests[0]?.objective).toContain('T-1: Implement the contract.')
  expect(requests[1]?.objective).toContain('T-2: Implement validation.')
  expect(requests[0]?.verification).toEqual([{ id: 'task-scope-review', kind: 'inspection', instruction: expect.any(String), required: true }])
  expect(requests[1]?.verification).toEqual([{ id: 'task-scope-review', kind: 'inspection', instruction: expect.any(String), required: true }])
  expect(requests[2]?.verification).toEqual([{ id: 'slice-tests', kind: 'test', instruction: 'domain tests', required: true }])
})

it('skips materialized task files after a restart and leaves verification to the tester', async () => {
  const slice: VerticalSlice = { id: 'restart', taskIds: ['T-done', 'T-open'], layers: ['domain'], requirementIds: [], inputs: {}, expectedPaths: ['src/personnel/contract/dto.ts', 'src/personnel/restart-missing.ts', 'test/personnel-validation.test.mjs'], apiOperations: [], dataChanges: [], testEvidence: ['personnel-validation'], dependencies: [], rollbackBoundary: 'restart', completionConditions: [] }
  const plan: DevelopmentPlan = {
    requirements: [], trace: { requirements: {} }, artifactHashes: {}, slices: [slice],
    tasks: [
      { id: 'T-done', sliceId: slice.id, requirementIds: [], owner: 'developer', risk: 'standard', dependencies: [], layer: 'domain', evidence: ['personnel-validation'], files: ['src/personnel/contract/dto.ts'], objective: 'Keep the existing contract.' },
      { id: 'T-open', sliceId: slice.id, requirementIds: [], owner: 'developer', risk: 'standard', dependencies: ['T-done'], layer: 'domain', evidence: ['personnel-validation'], files: ['src/personnel/restart-missing.ts'], objective: 'Implement the missing restart task.' },
    ],
  }
  const roles: string[] = []
  const executor = new SliceExecutor({ workspaceRoot: process.cwd(), patchTracker: { begin: async () => ({}) }, teamCoordinator: { dispatchExpert: async input => {
    roles.push(input.role)
    return { id: input.id, taskId: input.id, status: 'completed', summary: 'done', risks: [], parentVerification: { status: 'accepted' } } as never
  } } })
  expect((await executor.execute(slice, plan)).status).toBe('passed')
  expect(roles).toEqual(['developer', 'tester'])
})

it('keeps legacy slices on slice-level verification when task metadata is absent', async () => {
  const slice: VerticalSlice = { id: 'legacy', taskIds: ['T-legacy'], layers: ['domain'], requirementIds: [], inputs: {}, expectedPaths: ['src/legacy.ts'], apiOperations: [], dataChanges: [], testEvidence: ['legacy checks'], dependencies: [], rollbackBoundary: 'legacy', completionConditions: [] }
  const plan: DevelopmentPlan = { requirements: [], trace: { requirements: {} }, artifactHashes: {}, slices: [slice], tasks: [] }
  const requests: ExpertDispatchRequest[] = []
  const executor = new SliceExecutor({ patchTracker: { begin: async () => ({}) }, teamCoordinator: { dispatchExpert: async input => {
    requests.push(input)
    return { id: input.id, taskId: input.id, status: 'completed', summary: 'done', risks: [], parentVerification: { status: 'accepted' } } as never
  } } })
  expect((await executor.execute(slice, plan)).status).toBe('passed')
  expect(requests[0]?.role).toBe('developer')
  expect(requests[0]?.verification).toEqual([{ id: 'slice-tests', kind: 'test', instruction: 'legacy checks', required: true }])
})
