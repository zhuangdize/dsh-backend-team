import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PresetLoader } from '../src/preset-loader.js'

const validPreset = `
role: developer
purpose: Implement only the owned backend change.
allowedPhases: [BUILD, VERIFY]
defaultCapabilities:
  readProjectFiles: true
  writeOwnedFiles: true
  businessCodeWrite: true
  commandExecution: true
  canDelegate: true
readPathPatterns: [src, tests]
writePathPatterns: [src/users]
requiredInputs: [approved design hash]
requiredOutputs: [verified handoff]
nonGoals: [Do not migrate the database.]
defaultBudget:
  maxTokens: 1000
  maxWallMs: 10000
  maxToolCalls: 10
  maxRetries: 1
  maxChildren: 3
verification:
  - id: focused-test
    kind: test
    instruction: Run the focused test.
    required: true
`

function directory(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'agent-preset-loader-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(root, name), content, 'utf8')
  return root
}

describe('PresetLoader', () => {
  it('loads a deterministic set of strict YAML expert presets', () => {
    const root = directory({
      'developer.yaml': validPreset,
      'tester.yaml': validPreset
        .replace('role: developer', 'role: tester')
        .replace('businessCodeWrite: true', 'businessCodeWrite: false')
        .replace('writePathPatterns: [src/users]', "writePathPatterns: ['**/*.test.*']"),
    })
    try {
      const presets = new PresetLoader(root).loadAll()

      expect(presets.map((preset) => preset.role)).toEqual(['developer', 'tester'])
      expect(presets[0]).toMatchObject({ allowedPhases: ['BUILD', 'VERIFY'], defaultCapabilities: { businessCodeWrite: true } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['unknown key', `${validPreset}\nunexpected: true\n`],
    ['duplicate role', validPreset],
    ['absolute write path', validPreset.replace('writePathPatterns: [src/users]', 'writePathPatterns: [/src/users]')],
    ['broad write glob', validPreset.replace('writePathPatterns: [src/users]', 'writePathPatterns: ["**"]')],
    ['root-wide write glob', validPreset.replace('writePathPatterns: [src/users]', 'writePathPatterns: ["**/*.ts"]')],
    ['leading wildcard write glob', validPreset.replace('writePathPatterns: [src/users]', 'writePathPatterns: ["*/**"]')],
    ['recursive scoped write glob', validPreset.replace('writePathPatterns: [src/users]', 'writePathPatterns: ["src/**"]')],
    ['tester source write path', validPreset.replace('role: developer', 'role: tester').replace('businessCodeWrite: true', 'businessCodeWrite: false')],
    ['phase authority prompt', validPreset.replace('Implement only the owned backend change.', 'You may change the phase after implementation.')],
    ['positive user contact prompt', validPreset.replace('Implement only the owned backend change.', 'Ask the user a question before implementation.')],
    ['email user prompt', validPreset.replace('Run the focused test.', 'Email the user the verification result.')],
    ['negated then positive user prompt', validPreset.replace('Implement only the owned backend change.', 'Do not contact the user; email the user instead.')],
    ['user objective outside structured input', validPreset.replace('Implement only the owned backend change.', 'Implement a user objective in owned backend code.')],
    ['developer phase escalation capability', validPreset.replace('canDelegate: true', 'canDelegate: true\n  canChangePhase: true')],
    ['requirements business-write capability', validPreset.replace('role: developer', 'role: requirements').replace('businessCodeWrite: true', 'businessCodeWrite: true')],
  ])('rejects %s', (_name, invalid) => {
    const files = _name === 'duplicate role' ? { 'one.yaml': validPreset, 'two.yaml': invalid } : { 'invalid.yaml': invalid }
    const root = directory(files)
    try {
      expect(() => new PresetLoader(root).loadAll()).toThrow(/unknown|duplicate|path|glob|authority|phase|capability|user/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows exact structured requiredInputs user objective metadata', () => {
    const root = directory({ 'developer.yaml': validPreset.replace('requiredInputs: [approved design hash]', 'requiredInputs: [user objective]') })
    try {
      expect(new PresetLoader(root).loadAll()[0]?.requiredInputs).toEqual(['user objective'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a preset symlink instead of following it', () => {
    const root = directory({ 'source.yaml': validPreset })
    try {
      symlinkSync(resolve(root, 'source.yaml'), resolve(root, 'linked.yaml'))

      expect(() => new PresetLoader(root).loadAll()).toThrow(/symlink/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a preset directory symlink instead of canonicalizing it', () => {
    const target = directory({ 'source.yaml': validPreset })
    const container = mkdtempSync(resolve(tmpdir(), 'agent-preset-loader-link-'))
    const linkedDirectory = resolve(container, 'presets')
    try {
      symlinkSync(target, linkedDirectory)

      expect(() => new PresetLoader(linkedDirectory).loadAll()).toThrow(/symlink/i)
    } finally {
      rmSync(container, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('loads every migrated repository expert preset through the strict schema', () => {
    const root = resolve(import.meta.dirname, '../../../presets/experts')

    expect(new PresetLoader(root).loadAll().map((preset) => preset.role)).toEqual([
      'backend-architect',
      'database-designer',
      'developer',
      'fixer',
      'oss-researcher',
      'planner',
      'project-analyzer',
      'requirements',
      'security-reviewer',
      'tester',
    ])
  })
})
