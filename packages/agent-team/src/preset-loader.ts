import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { relative, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import {
  AgentBudgetSchema,
  AgentCapabilitySetSchema,
  AgentRoleSchema,
  BackendTeamPhaseSchema,
  VerificationInstructionSchema,
} from '@dsh-backend-team/contracts'
import type { AgentBudget, AgentCapabilitySet, AgentRole, BackendTeamPhase, VerificationInstruction } from '@dsh-backend-team/contracts'
import { RolePolicy } from './role-policy.js'

export interface ExpertPreset {
  readonly role: AgentRole
  readonly purpose: string
  readonly allowedPhases: readonly BackendTeamPhase[]
  readonly defaultCapabilities: AgentCapabilitySet
  readonly readPathPatterns: readonly string[]
  readonly writePathPatterns: readonly string[]
  readonly requiredInputs: readonly string[]
  readonly requiredOutputs: readonly string[]
  readonly nonGoals: readonly string[]
  readonly defaultBudget: AgentBudget
  readonly verification: readonly VerificationInstruction[]
}

const keys = new Set([
  'role', 'purpose', 'allowedPhases', 'defaultCapabilities', 'readPathPatterns', 'writePathPatterns',
  'requiredInputs', 'requiredOutputs', 'nonGoals', 'defaultBudget', 'verification',
])
const testerWritePatterns = new Set(['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '.backend-team/runs/**/verification/**'])
const authorityPrompt = /\b(?:change|advance|set)\s+(?:the\s+)?phase\b|\bapprove(?:\s+the)?\b|\bannounce\s+completion\b/iu
const userToken = /\busers?\b/iu

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be a mapping`)
  return value as Readonly<Record<string, unknown>>
}

function strings(value: unknown, label: string, minimum = 0): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || !value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) throw new Error(`${label} must be an array of non-empty strings`)
  return value.map((entry) => entry.trim())
}

function safePattern(pattern: string, label: string, write: boolean): string {
  if (/[\u0000-\u001F\u007F]/u.test(pattern) || pattern.startsWith('/') || pattern.includes('\\') || /^[A-Za-z]:/u.test(pattern) || pattern.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`${label} must be a workspace-relative path pattern`)
  if (write && (pattern === '**' || pattern === '**/*')) throw new Error('write path pattern is too broad')
  return pattern
}

function assertWritePathCeiling(role: AgentRole, paths: readonly string[], source: string): void {
  for (const path of paths) {
    if (role === 'tester' && !testerWritePatterns.has(path)) throw new Error(`${source} tester write path exceeds the role ceiling`)
    if (role !== 'tester' && (path.split('/').includes('**') || /[*?[]/u.test(path.split('/', 1)[0] ?? ''))) throw new Error(`${source} write path glob is too broad`)
  }
}

interface PromptText {
  readonly text: string
  /** Only the exact structured `requiredInputs: user objective` value may contain this token. */
  readonly allowsUserObjective?: boolean
}

function assertPromptSafety(role: AgentRole, texts: readonly PromptText[], source: string): void {
  for (const { text, allowsUserObjective } of texts) {
    if (authorityPrompt.test(text)) throw new Error(`${source} prompt grants forbidden authority`)
    if (role === 'coordinator') continue
    if (userToken.test(text)) {
      const exactUserObjective = allowsUserObjective && /^user\s+objective$/iu.test(text.trim())
      if (!exactUserObjective) throw new Error(`${source} prompt grants forbidden user interaction`)
    }
  }
}

function parsed<T>(result: { readonly success: true; readonly data: T } | { readonly success: false }, label: string): T {
  if (!result.success) throw new Error(`${label} is invalid`)
  return result.data
}

function assertCapabilityCeiling(role: AgentRole, phases: readonly BackendTeamPhase[], requested: AgentCapabilitySet, source: string): void {
  const policy = new RolePolicy({ designApproved: true })
  const booleanKeys = [
    'readProjectFiles', 'writeOwnedFiles', 'businessCodeWrite', 'testCodeWrite', 'configurationWrite', 'commandExecution',
    'install', 'migration', 'canDelegate', 'canChangePhase', 'canApprove', 'canContactUser', 'canAnnounceCompletion',
  ] as const
  for (const phase of phases) {
    const maximum = policy.maxCapabilities(role, phase)
    for (const key of booleanKeys) if (requested[key] && !maximum[key]) throw new Error(`${source} default capability ${key} exceeds the role ceiling`)
    if (requested.networkHosts.some((host) => !maximum.networkHosts.includes(host))) throw new Error(`${source} default network hosts exceed the role ceiling`)
  }
}

function readPresetFile(path: string): string {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('preset must be a bounded regular file')
    const content = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, offset)
      if (count === 0) throw new Error('preset changed while being read')
      offset += count
    }
    return content.toString('utf8')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino
}

function openPresetDirectory(path: string): { readonly descriptor: number; readonly root: string; readonly metadata: Stats } {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const metadata = fstatSync(descriptor)
    if (!metadata.isDirectory()) throw new Error('preset directory must be a directory')
    const root = realpathSync(path)
    if (!sameDirectory(metadata, statSync(root))) throw new Error('preset directory changed while being opened')
    return { descriptor, root, metadata }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('preset directory may not be a symlink')
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR' && lstatSync(path).isSymbolicLink()) throw new Error('preset directory may not be a symlink')
    throw error
  }
}

function assertDirectoryStable(root: string, metadata: Stats): void {
  if (!sameDirectory(metadata, statSync(root))) throw new Error('preset directory changed while being read')
}

function parsePreset(text: string, source: string): ExpertPreset {
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) throw new Error(`${source} is not valid YAML`)
  const raw = record(document.toJS({ maxAliasCount: 0 }), source)
  for (const key of Object.keys(raw)) if (!keys.has(key)) throw new Error(`${source} contains unknown key ${key}`)
  for (const key of keys) if (!(key in raw)) throw new Error(`${source} is missing required key ${key}`)

  const role = parsed(AgentRoleSchema.safeParse(raw.role), `${source} role`)
  const purpose = typeof raw.purpose === 'string' && raw.purpose.trim().length > 0 ? raw.purpose.trim() : undefined
  if (purpose === undefined) throw new Error(`${source} purpose must be a non-empty string`)
  const allowedPhases = strings(raw.allowedPhases, `${source} allowedPhases`, 1).map((phase) => parsed(BackendTeamPhaseSchema.safeParse(phase), `${source} phase`))
  const defaultCapabilities = parsed(AgentCapabilitySetSchema.safeParse(raw.defaultCapabilities), `${source} defaultCapabilities`)
  const readPathPatterns = strings(raw.readPathPatterns, `${source} readPathPatterns`).map((path) => safePattern(path, `${source} readPathPatterns`, false))
  const writePathPatterns = strings(raw.writePathPatterns, `${source} writePathPatterns`).map((path) => safePattern(path, `${source} writePathPatterns`, true))
  assertWritePathCeiling(role, writePathPatterns, source)
  const requiredInputs = strings(raw.requiredInputs, `${source} requiredInputs`, 1)
  const requiredOutputs = strings(raw.requiredOutputs, `${source} requiredOutputs`, 1)
  const nonGoals = strings(raw.nonGoals, `${source} nonGoals`, 1)
  const defaultBudget = parsed(AgentBudgetSchema.safeParse(raw.defaultBudget), `${source} defaultBudget`)
  if (!Array.isArray(raw.verification) || raw.verification.length === 0) throw new Error(`${source} verification must be a non-empty list`)
  const verification = raw.verification.map((instruction) => parsed(VerificationInstructionSchema.safeParse(instruction), `${source} verification`))
  if (new Set(verification.map((instruction) => instruction.id)).size !== verification.length) throw new Error(`${source} verification IDs must be unique`)
  assertPromptSafety(role, [
    { text: purpose },
    ...requiredInputs.map((text) => ({ text, allowsUserObjective: true })),
    ...requiredOutputs.map((text) => ({ text })),
    ...nonGoals.map((text) => ({ text })),
    ...verification.map((instruction) => ({ text: instruction.instruction })),
  ], source)
  assertCapabilityCeiling(role, allowedPhases, defaultCapabilities, source)
  return { role, purpose, allowedPhases, defaultCapabilities, readPathPatterns, writePathPatterns, requiredInputs, requiredOutputs, nonGoals, defaultBudget, verification }
}

/** Loads only caller-selected, strict expert YAML documents; no legacy fallback or implicit authority is granted. */
export class PresetLoader {
  constructor(private readonly directory: string) {}

  loadAll(): readonly ExpertPreset[] {
    const opened = openPresetDirectory(this.directory)
    try {
      assertDirectoryStable(opened.root, opened.metadata)
      const entries = readdirSync(opened.root).filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml')).sort()
      const presets: ExpertPreset[] = []
      for (const entry of entries) {
        const path = resolve(opened.root, entry)
        if (relative(opened.root, path).startsWith('..')) throw new Error(`preset ${entry} escapes the preset directory`)
        if (lstatSync(path).isSymbolicLink()) throw new Error(`preset ${entry} may not be a symlink`)
        presets.push(parsePreset(readPresetFile(path), entry))
      }
      assertDirectoryStable(opened.root, opened.metadata)
      if (new Set(presets.map((preset) => preset.role)).size !== presets.length) throw new Error('duplicate expert preset role')
      return presets
    } finally {
      closeSync(opened.descriptor)
    }
  }
}
