import { createHash } from 'node:crypto'
import { buildRequirementTrace } from './requirement-trace.js'
import type { DevelopmentPlan, PlannedTask, SliceLayer, VerticalSlice } from './vertical-slice.js'

export interface ArtifactContent { readonly content: string; readonly sha256: string }
export type ArtifactInput = string | ArtifactContent
export interface TaskPlanArtifacts {
  readonly tasks: ArtifactInput
  readonly spec: ArtifactInput
  readonly architecture: ArtifactInput
  readonly 'data-model.md': ArtifactInput
  readonly 'openapi.yaml': ArtifactInput
  readonly 'test-plan.md': ArtifactInput
  readonly hashes?: Readonly<Record<string, string>>
  readonly artifactHashes?: Readonly<Record<string, string>>
}

const REQUIRED_HASHES = ['tasks.md', 'spec.md', 'architecture.md', 'data-model.md', 'openapi.yaml', 'test-plan.md'] as const
const LAYERS: readonly SliceLayer[] = ['contract', 'domain', 'persistence', 'test']

export class TaskPlanParser {
  async parse(artifacts: TaskPlanArtifacts): Promise<DevelopmentPlan> {
    const hashes: Record<string, string> = {}
    for (const [name, hash] of Object.entries(artifacts.artifactHashes ?? {})) hashes[name] = hash
    for (const [name, hash] of Object.entries(artifacts.hashes ?? {})) {
      if (hashes[name] !== undefined && hashes[name] !== hash) throw new Error(`conflicting hashes for ${name}`)
      hashes[name] = hash
    }
    for (const name of REQUIRED_HASHES) {
      const input = artifacts[name === 'tasks.md' ? 'tasks' : name === 'spec.md' ? 'spec' : name === 'architecture.md' ? 'architecture' : name]
      const actualHash = createHash('sha256').update(content(input)).digest('hex')
      if (typeof input !== 'string' && input.sha256 !== actualHash) throw new Error(`hash mismatch for ${name}`)
      if (hashes[name] !== undefined && hashes[name] !== actualHash) throw new Error(`hash mismatch for ${name}`)
      hashes[name] = actualHash
      const hash = hashes[name]
      if (hash === undefined || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`invalid or missing hash for ${name}`)
    }
    const tasksText = content(artifacts.tasks)
    const specText = content(artifacts.spec)
    const requirements = extractRequirements(specText)
    const tasks = parseTasks(tasksText, new Set(requirements))
    if (tasks.length === 0) throw new Error('development plan has no executable tasks')
    const taskSlices = new Map(tasks.map(task => [task.id, task.sliceId]))
    const trace = buildRequirementTrace(tasks, requirements)
    const slices: VerticalSlice[] = []
    for (const sliceId of unique(tasks.map((task) => task.sliceId))) {
      const sliceTasks = tasks.filter((task) => task.sliceId === sliceId)
      const layers = LAYERS.filter((layer) => sliceTasks.some((task) => task.layer === layer))
      slices.push(Object.freeze({
        id: sliceId,
        taskIds: Object.freeze(sliceTasks.map((task) => task.id)),
        layers: Object.freeze(layers),
        requirementIds: Object.freeze(unique(sliceTasks.flatMap((task) => task.requirementIds))),
        inputs: Object.freeze({ ...hashes }),
        expectedPaths: Object.freeze(unique(sliceTasks.flatMap((task) => task.files))),
        apiOperations: Object.freeze(sliceTasks.filter((task) => task.layer === 'contract').map((task) => task.objective)),
        dataChanges: Object.freeze(sliceTasks.filter((task) => task.layer === 'persistence').map((task) => task.objective)),
        testEvidence: Object.freeze(unique(sliceTasks.flatMap((task) => task.evidence))),
        dependencies: Object.freeze(unique(sliceTasks.flatMap(task => task.dependencies.map(id => taskSlices.get(id)!)).filter(id => id !== sliceId))),
        rollbackBoundary: `slice:${sliceId}`,
        completionConditions: Object.freeze(sliceTasks.map((task) => `task ${task.id} evidence captured`)),
      }))
    }
    const ordered: VerticalSlice[] = []
    const remaining = [...slices]
    while (remaining.length > 0) {
      const next = remaining.findIndex(slice => slice.dependencies.every(id => ordered.some(done => done.id === id)))
      if (next === -1) throw new Error('slice dependency cycle: split or regroup dependent tasks')
      ordered.push(remaining.splice(next, 1)[0]!)
    }
    return Object.freeze({ slices: Object.freeze(ordered), tasks: Object.freeze(tasks), trace, artifactHashes: Object.freeze({ ...hashes }), requirements: Object.freeze(requirements) })
  }
}

function parseTasks(source: string, requirementSet: ReadonlySet<string>): PlannedTask[] {
  const lines = source.split(/\r?\n/u)
  const tasks: PlannedTask[] = []
  const seen = new Set<string>()
  let pending: Record<string, string> | undefined
  for (const line of lines) {
    if (pending !== undefined && !/^\s*-\s*\[ \]\s+/u.test(line)) throw new Error('task marker must be immediately followed by an executable checkbox')
    const marker = line.match(/^\s*<!--\s*backend-team:task\s+(.+?)\s*-->\s*$/u)
    if (marker) { pending = metadata(marker[1] ?? ''); continue }
    const checkbox = line.match(/^\s*-\s*\[ \]\s+(.+)$/u)
    if (!checkbox) continue
    if (pending === undefined) throw new Error('executable task is missing backend-team:task marker')
    const id = pending.id
    if (!id) throw new Error('task marker is missing id')
    if (seen.has(id)) throw new Error(`duplicate task id: ${id}`)
    seen.add(id)
    if (!pending.slice) throw new Error(`${id} is missing slice`)
    if (!pending.owner) throw new Error(`${id} is missing owner`)
    if (!pending.risk) throw new Error(`${id} is missing risk`)
    const requirementIds = list(pending.requirements)
    for (const requirementId of requirementIds) if (!requirementSet.has(requirementId)) throw new Error(`${id} references unknown requirement ${requirementId}`)
    const layer = (pending.layer ?? inferLayer(checkbox[1] ?? '')) as SliceLayer
    if (!LAYERS.includes(layer)) throw new Error(`${id} has invalid layer ${layer}`)
    const files = list(pending.files ?? pending.paths)
    for (const path of files) if (!safePath(path)) throw new Error(`${id} has invalid expected path ${path}`)
    tasks.push(Object.freeze({ id, sliceId: pending.slice, requirementIds: Object.freeze(requirementIds), owner: pending.owner, risk: pending.risk, dependencies: Object.freeze(list(pending.depends ?? pending.dependencies)), layer, evidence: Object.freeze(list(pending.evidence)), files: Object.freeze(files), objective: checkbox[1] ?? '' }))
    pending = undefined
  }
  if (pending !== undefined) throw new Error('task marker is missing executable checkbox')
  const ids = new Set(tasks.map((task) => task.id))
  for (const task of tasks) for (const dependency of task.dependencies) if (!ids.has(dependency)) throw new Error(`${task.id} depends on unknown task ${dependency}`)
  detectCycle(tasks)
  return tasks
}

function metadata(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  const allowed = new Set(['id', 'slice', 'requirements', 'owner', 'risk', 'layer', 'files', 'paths', 'depends', 'dependencies', 'evidence'])
  for (const token of text.trim().split(/\s+/u)) {
    const match = token.match(/^([A-Za-z][A-Za-z0-9_-]*)=([^\s=]+)$/u)
    if (match === null) throw new Error(`malformed task marker token: ${token}`)
    const key = match[1] ?? ''
    if (!allowed.has(key)) throw new Error(`unknown task marker field: ${key}`)
    if (result[key] !== undefined) throw new Error(`duplicate task marker field: ${key}`)
    result[key] = match[2] ?? ''
  }
  if (result.files !== undefined && result.paths !== undefined) throw new Error('task marker fields files and paths are mutually exclusive')
  if (result.depends !== undefined && result.dependencies !== undefined) throw new Error('task marker fields depends and dependencies are mutually exclusive')
  return result
}
function list(value: string | undefined): string[] { return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [] }
function unique(values: readonly string[]): string[] { return [...new Set(values)] }
function inferLayer(text: string): SliceLayer { const lower = text.toLowerCase(); return lower.includes('test') || lower.includes('verify') ? 'test' : lower.includes('persist') || lower.includes('database') || lower.includes('save') ? 'persistence' : lower.includes('api') || lower.includes('contract') ? 'contract' : 'domain' }
function extractRequirements(spec: string): string[] { return unique([...spec.matchAll(/\bAC-[0-9]+\b/gu)].map((match) => match[0])) }
function content(input: ArtifactInput): string { return typeof input === 'string' ? input : input.content }
function safePath(path: string): boolean { return path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:[/\\]/u.test(path) && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) && !/[\\*?\[\]]/u.test(path) && !path.split('/').some((part) => part === '' || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/u.test(part)) }
function detectCycle(tasks: readonly PlannedTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>(); const visited = new Set<string>()
  const visit = (id: string): void => { if (visiting.has(id)) throw new Error(`dependency cycle detected at ${id}`); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id)?.dependencies ?? []) visit(dep); visiting.delete(id); visited.add(id) }
  for (const task of tasks) visit(task.id)
}
