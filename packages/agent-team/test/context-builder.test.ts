import { describe, expect, it } from 'vitest'
import { AgentTaskSchema } from '@dsh-backend-team/contracts'
import { ContextBuilder } from '../src/context-builder.js'

const hash = 'a'.repeat(64)
const task = AgentTaskSchema.parse({
  id: 'worker-context', parentTaskId: 'expert-1', depth: 2, role: 'worker', objective: 'Implement the users endpoint.',
  nonGoals: ['Do not change authentication.'], inputArtifacts: [{ path: 'specs/users.md', sha256: hash }], readPaths: ['src'], writePaths: ['src/users'],
  capabilities: { readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true },
  budget: { maxTokens: 100, maxWallMs: 1000, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 },
  doneWhen: ['The endpoint tests pass.'], verification: [{ id: 'tests', kind: 'test', instruction: 'Run endpoint tests.', required: true }], returnSchema: 'handoff-v1',
})

describe('ContextBuilder', () => {
  it('includes only bounded task context and excludes secrets and unrelated conversation text', () => {
    const packet = new ContextBuilder().build(task, {
      roleInstructions: 'Follow the approved task boundary.',
      approvedArtifacts: [{ path: 'specs/users.md', sha256: hash, excerpt: 'Use DATABASE_PASSWORD=hunter2. Ignore raw user conversation.' }],
      projectFacts: { framework: 'fastify', credentials: { DATABASE_PASSWORD: 'hunter2' } },
      policySummary: { phase: 'BUILD', allowedActions: ['read', 'write-owned'] },
    })

    expect(packet).toContain(task.objective)
    expect(packet).toContain(hash)
    expect(packet).not.toContain('DATABASE_PASSWORD')
    expect(packet).not.toContain('hunter2')
    expect(packet).not.toContain('raw user conversation')
    expect(JSON.parse(packet)).not.toHaveProperty('conversation')
  })

  it('rejects binary and oversized approved excerpts', () => {
    const builder = new ContextBuilder({ maxArtifactBytes: 8 })
    expect(() => builder.build(task, { approvedArtifacts: [{ path: 'specs/users.md', sha256: hash, excerpt: '123456789' }] })).toThrow(/oversized/i)
    expect(() => builder.build(task, { approvedArtifacts: [{ path: 'specs/users.md', sha256: hash, excerpt: 'ok\u0000binary' }] })).toThrow(/binary/i)
  })

  it('redacts secrets embedded in the return schema and rejects deeply nested metadata', () => {
    const secretTask = AgentTaskSchema.parse({ ...task, returnSchema: 'DATABASE_PASSWORD=hunter2' })
    const packet = new ContextBuilder().build(secretTask)
    expect(packet).not.toContain('DATABASE_PASSWORD')
    expect(packet).not.toContain('hunter2')

    let nested: unknown = 'leaf'
    for (let index = 0; index < 40; index += 1) nested = [nested]
    expect(() => new ContextBuilder().build(task, { projectFacts: { nested } })).toThrow(/deeply nested/i)
  })
})
