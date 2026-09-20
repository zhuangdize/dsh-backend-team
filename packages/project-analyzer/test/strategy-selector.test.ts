import { describe, expect, it } from 'vitest'
import type { ProjectProfile } from '../src/index.js'
import { StrategySelector } from '../src/index.js'

const evidence = [{ kind: 'manifest', path: 'package.json', fact: 'declares a backend dependency', excerptHash: 'a'.repeat(64) }] as const

function profile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    schemaVersion: 1,
    projectKind: 'node-service',
    exists: true,
    technologies: [
      { value: 'express', category: 'framework', confidence: 'high', evidence, conflicts: [] },
      { value: 'prisma', category: 'orm', confidence: 'high', evidence, conflicts: [] },
      { value: 'mysql', category: 'database', confidence: 'high', evidence, conflicts: [] },
      { value: 'npm', category: 'other', confidence: 'high', evidence, conflicts: [] },
    ],
    nodeRuntime: {
      declarations: [{ source: 'package.json#engines.node', range: '20.20.0', evidence: evidence[0] }],
      exactVersion: '20.20.0',
      selectionSource: 'package.json#engines.node',
      conflicts: [],
      status: 'selected',
    },
    serviceBoundary: { relativeRoot: '.', confidence: 'high', evidence },
    baselineIssues: [],
    databaseRecommendation: { target: 'preserve-existing', automation: 'automatic' },
    ...overrides,
  }
}

describe('StrategySelector', () => {
  it('selects the approved Node 24 PostgreSQL preset for an empty workspace', () => {
    const selected = new StrategySelector().select(profile({ projectKind: 'empty', exists: false, technologies: [], nodeRuntime: null, serviceBoundary: null, databaseRecommendation: null }))

    expect(selected).toEqual(expect.objectContaining({ kind: 'new-node-postgresql', nodeVersion: '24.19.0', preset: 'presets/new-project/node-postgresql.yaml', writable: true }))
  })

  it('modifies an evidenced existing stack in place without changing Node, ORM, or MySQL', () => {
    const selected = new StrategySelector().select(profile())

    expect(selected).toEqual(expect.objectContaining({ kind: 'modify-in-place', nodeVersion: '20.20.0', framework: 'express', database: 'mysql', orm: 'prisma', writable: true, migration: 'preserve-existing' }))
  })

  it('returns read-only for a non-Node project', () => {
    const selected = new StrategySelector().select(profile({ projectKind: 'non-node', technologies: [], nodeRuntime: null, serviceBoundary: null, databaseRecommendation: null }))

    expect(selected).toEqual(expect.objectContaining({ kind: 'unsupported-read-only', writable: false }))
  })

  it('requires clarification when a Node fact is unresolved or a required existing-stack fact is missing', () => {
    const unresolved = new StrategySelector().select(profile({ nodeRuntime: { declarations: [], conflicts: evidence, status: 'needs-clarification' } }))
    const missingDatabase = new StrategySelector().select(profile({ technologies: profile().technologies.filter((technology) => technology.category !== 'database'), databaseRecommendation: null }))
    const lowConfidenceManager = new StrategySelector().select(profile({ technologies: profile().technologies.map((technology) => technology.value === 'npm' ? { ...technology, confidence: 'low' as const } : technology) }))

    expect(unresolved).toEqual(expect.objectContaining({ kind: 'needs-clarification', writable: false }))
    expect(missingDatabase).toEqual(expect.objectContaining({ kind: 'needs-clarification', writable: false }))
    expect(lowConfidenceManager).toEqual(expect.objectContaining({ kind: 'needs-clarification', writable: false }))
  })

  it('does not select an arbitrary framework when an existing service has multiple framework facts', () => {
    const selected = new StrategySelector().select(profile({
      technologies: [
        ...profile().technologies,
        { value: 'fastify', category: 'framework', confidence: 'high', evidence, conflicts: [] },
      ],
    }))

    expect(selected).toEqual(expect.objectContaining({ kind: 'needs-clarification', writable: false }))
  })

  it('blocks all write strategies for a blocking Git baseline issue', () => {
    const selected = new StrategySelector().select(profile({
      baselineIssues: [{ code: 'git-worktree-change', severity: 'blocking', message: 'Git worktree has a conflicted path.', evidence }],
    }))

    expect(selected).toEqual(expect.objectContaining({ kind: 'needs-clarification', writable: false }))
  })
})
