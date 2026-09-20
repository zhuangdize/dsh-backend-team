import { describe, expect, it } from 'vitest'
import type { ProjectProfile } from '../../packages/project-analyzer/src/index.js'
import { StrategySelector } from '../../packages/project-analyzer/src/index.js'

const evidence = [{ kind: 'manifest', path: 'package.json', fact: 'declares a backend dependency', excerptHash: 'a'.repeat(64) }] as const

describe('existing MySQL project', () => {
  it('selects modify-in-place and preserves MySQL/ORM choices', () => {
    const profile: ProjectProfile = {
      schemaVersion: 1, projectKind: 'node-service', exists: true,
      technologies: [
        { value: 'express', category: 'framework', confidence: 'high', evidence, conflicts: [] },
        { value: 'prisma', category: 'orm', confidence: 'high', evidence, conflicts: [] },
        { value: 'mysql', category: 'database', confidence: 'high', evidence, conflicts: [] },
        { value: 'npm', category: 'other', confidence: 'high', evidence, conflicts: [] },
      ],
      nodeRuntime: { declarations: [{ source: 'package.json#engines.node', range: '20.20.0', evidence: evidence[0] }], exactVersion: '20.20.0', selectionSource: 'package.json#engines.node', conflicts: [], status: 'selected' },
      serviceBoundary: { relativeRoot: '.', confidence: 'high', evidence }, baselineIssues: [], databaseRecommendation: { target: 'preserve-existing', automation: 'automatic' },
    }
    const strategy = new StrategySelector().select(profile)
    expect(strategy).toMatchObject({ kind: 'modify-in-place', database: 'mysql', orm: 'prisma', nodeVersion: '20.20.0', migration: 'preserve-existing' })
    expect(JSON.stringify(strategy)).not.toContain('postgres')
    expect(JSON.stringify(strategy)).not.toContain('drizzle')
  })
})
