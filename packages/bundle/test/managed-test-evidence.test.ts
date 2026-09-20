import { expect, it, vi } from 'vitest'
import type { AgentResult } from '@dsh-backend-team/contracts'
import { ManagedTestEvidence } from '../src/managed-test-evidence.js'
import { runManagedNodeTests } from '../src/managed-node-tests.js'
vi.mock('../src/managed-node-tests.js', () => ({ runManagedNodeTests: vi.fn() }))

it('requires tests after an edit and uses evidence for that file revision', async () => {
  const evidence = new ManagedTestEvidence()
  const options = { workspaceRoot: '/fixture', files: ['test/demo.mjs'], readPaths: ['test/demo.mjs'], signal: new AbortController().signal, maxWallMs: 1000 }
  const result = { taskId: 'task', status: 'passed' } as AgentResult
  vi.mocked(runManagedNodeTests).mockResolvedValueOnce({ argv: ['node', 'test/demo.mjs'], exitCode: 1, stdout: '', stderr: 'assertion failed' })
  await evidence.run('task', options)
  expect(() => evidence.verify(result)).toThrow('real successful test')
  evidence.invalidate('task')
  expect(() => evidence.verify(result)).toThrow('last edit')
  vi.mocked(runManagedNodeTests).mockResolvedValueOnce({ argv: ['node', 'test/demo.mjs'], exitCode: 0, stdout: 'passed', stderr: '' })
  await evidence.run('task', options)
  expect(evidence.verify(result).commands).toEqual([{ argv: ['node', 'test/demo.mjs'], exitCode: 0 }])
})

it('allows a passed inspection-only task without test evidence', () => {
  const evidence = new ManagedTestEvidence()
  const result = { taskId: 'inspection-task', status: 'passed' } as AgentResult
  expect(evidence.verify(result, { requireSuccessfulTest: false }).commands).toEqual([])
})
