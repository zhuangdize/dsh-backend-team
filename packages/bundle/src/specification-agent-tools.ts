import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod'
import { AgentTaskSchema, type PolicyEngine, type WorkspaceLayout } from '@dsh-backend-team/contracts'
import { OwnershipManager } from '@dsh-backend-team/agent-team/ownership-manager'
import { DefaultPolicyEngine } from '@dsh-backend-team/policy-engine'
import { PatchTracker, type PatchSession } from '@dsh-backend-team/development/patch-tracker'
import { captureFileSnapshot } from '@dsh-backend-team/development/file-snapshot'
import type { HarnessAgentSetup, HarnessJsonSchema, HarnessToolExecution, HarnessToolRegistrationDefinition } from '@dsh-backend-team/harness-adapter'

export interface SpecificationAgentToolOptions {
  readonly workspaceRoot: string
  readonly recoveryToken: string
  readonly readPhase: () => Promise<string>
  readonly verifyCurrentApproval: () => Promise<void>
  readonly readFeatureDirectory: () => Promise<string>
  readonly policyEngine: PolicyEngine
}
const pathSchema = z.string().min(1).max(1024).refine(path => path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.')) && !/[\\:\u0000-\u001f\u007f]/u.test(path), 'unsafe task path')
const readSchema = z.object({ path: pathSchema }).strict()
const writeSchema = readSchema.extend({ content: z.string().max(1024 * 1024) }).strict()
const allowedTools = new Set(['backend_team_read', 'backend_team_write'])

/** Dedicated document-only tools for the active specification feature. */
export function createSpecificationAgentToolSetup(options: SpecificationAgentToolOptions): HarnessAgentSetup {
  const root = realpathSync(options.workspaceRoot)
  const teamDir = join(root, '.backend-team')
  const workspace: WorkspaceLayout = { root, teamDir, stateDir: join(teamDir, 'state'), runtimeDir: join(teamDir, 'runtime'), cacheDir: join(teamDir, 'cache'), logsDir: join(teamDir, 'logs'), locksDir: join(teamDir, 'locks'), handoffDir: join(teamDir, 'handoff') }
  const ownership = new OwnershipManager({ workspaceRoot: root, recoveryToken: options.recoveryToken })
  const activeTasks = new Set<string>()
  return async (context, request) => {
    const owner = context.agent
    if (owner === undefined || typeof owner !== 'object' || owner === null) throw new Error('managed Agent identity is required')
    if (typeof context.tools.presentAs !== 'function') throw new Error('managed Agent requires scoped native tool presentation')
    const task = AgentTaskSchema.parse(request.agentTask)
    const initialPhase = await options.readPhase()
    if (initialPhase !== 'SPECIFY' && initialPhase !== 'DESIGN' && initialPhase !== 'PLAN') throw new Error('invalid specification phase')
    if (typeof context.effect !== 'function') throw new Error('specification Agent requires lifecycle cleanup')
    const feature = featurePath(root, await options.readFeatureDirectory())
    const filenames = roleOutputs[task.role]
    if (filenames === undefined || rolePhases[task.role] !== initialPhase || request.role !== task.role || task.depth !== 1 || task.parentTaskId !== 'coordinator-specification') throw new Error('invalid specification role or phase')
    if (!task.capabilities.readProjectFiles || !task.capabilities.writeOwnedFiles || Object.entries(task.capabilities).some(([key, value]) => key !== 'readProjectFiles' && key !== 'writeOwnedFiles' && (Array.isArray(value) ? value.length > 0 : value === true))) throw new Error('invalid specification capabilities')
    const expectedPaths = filenames.map(file => feature + '/' + file)
    if (task.writePaths.length !== expectedPaths.length || task.writePaths.some(path => !expectedPaths.includes(path))) throw new Error('invalid specification ownership scope')
    if (task.readPaths.some(path => !artifactNames.some(file => path === feature + '/' + file))) throw new Error('invalid specification read scope')
    await options.verifyCurrentApproval()
    const verifyHostPolicy = async (kind: 'read' | 'write', path: string): Promise<void> => {
      const decision = await options.policyEngine.authorize({ kind, targetPath: join(root, path) }, { workspace, phase: initialPhase })
      if (decision.effect !== 'allow') throw new Error(`host policy denied ${kind}: ${decision.ruleId}`)
    }
    const deadline = Date.now() + task.budget.maxWallMs
    let disposed = false
    let calls = 0
    let queue: Promise<unknown> = Promise.resolve()
    const sessions = new Map<string, PatchSession>()
    const patches = new PatchTracker({ workspaceRoot: root, runId: `${task.id}-${randomUUID()}` })
    const policy = new DefaultPolicyEngine({ specificationWriteGrantVerifier: { verify: async ({ canonicalTargetPath }) => {
      await options.verifyCurrentApproval()
      ownership.verifyWrite(task, relative(root, canonicalTargetPath).replaceAll('\\', '/'))
      return true
    } } })
    const check = async (execution: HarnessToolExecution): Promise<void> => {
      if (disposed) throw new Error('specification Agent disposed')
      if (execution.agent !== owner) throw new Error('managed Agent identity mismatch')
      if (execution.signal.aborted) throw new Error('managed Agent operation aborted')
      if (Date.now() >= deadline) throw new Error('managed Agent time budget exhausted')
      if (await options.readPhase() !== initialPhase) throw new Error('managed Agent phase changed')
      if (featurePath(root, await options.readFeatureDirectory()) !== feature) throw new Error('specification feature changed')
    }
    const enqueue = (execution: HarnessToolExecution, operation: () => Promise<unknown>): Promise<unknown> => {
      if (execution.agent !== owner) return Promise.reject(new Error('managed Agent identity mismatch'))
      if (++calls > task.budget.maxToolCalls) return Promise.reject(new Error('managed Agent tool budget exhausted'))
      const running = queue.then(async () => { await check(execution); return operation() })
      queue = running.catch(() => {})
      return running
    }
    // No await between duplicate detection and acquiring/reserving the task.
    if (activeTasks.has(task.id)) throw new Error('specification task is already active')
    const lease = ownership.acquire(task.id, task.writePaths)
    activeTasks.add(task.id)
    let released = false
    const release = async (): Promise<void> => {
      disposed = true
      await queue
      if (!released) { ownership.release(lease); released = true; activeTasks.delete(task.id) }
    }
    try {
      context.effect(() => release, 'backendTeam.specificationOwnership')
      context.tools.guard(execution => execution.agent !== owner ? 'managed Agent identity mismatch' : allowedTools.has(execution.name) ? undefined : 'tool is disabled for managed backend Agent')
      context.tools.presentAs('native')
      const read: HarnessToolRegistrationDefinition = {
        name: 'backend_team_read', description: 'Read one declared specification document. Returns its UTF-8 content and SHA-256. Native file and shell tools are disabled.', parameters: z.toJSONSchema(readSchema),
        output: outputSchema({ path: { type: 'string' }, content: { type: 'string' }, sha256: { type: 'string' } }),
        execute: (input, execution) => enqueue(execution, async () => {
          const { path } = readSchema.parse(input)
          if (!task.capabilities.readProjectFiles || !inScope(path, task.readPaths)) throw new Error('read is outside task scope')
          await verifyHostPolicy('read', path)
          const absolute = join(root, path)
          if (await realpath(dirname(absolute)) !== dirname(absolute)) throw new Error('document parent is not canonical')
          try { await lstat(absolute) } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('document does not exist yet; create it only if it is an owned output, otherwise report the missing input')
            throw error
          }
          return policy.executeApprovedRead({ kind: 'read', targetPath: path }, { workspace, phase: initialPhase }, async handle => {
            await check(execution)
            await verifyHostPolicy('read', path)
            if ((await handle.stat()).size > 1024 * 1024) throw new Error('managed read exceeds size limit')
            const bytes = await handle.readFile()
            if (bytes.length > 1024 * 1024) throw new Error('managed read exceeds size limit')
            return { path, content: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') }
          })
        }),
      }
      const write: HarnessToolRegistrationDefinition = {
        name: 'backend_team_write', description: 'Replace or create one explicitly owned specification document and record patch evidence. Parent directory must already exist. No commands or deployment are supported.', parameters: z.toJSONSchema(writeSchema),
        output: outputSchema({ path: { type: 'string' }, beforeSha256: { oneOf: [{ type: 'string' }, { type: 'null' }] }, afterSha256: { type: 'string' } }),
        execute: (input, execution) => enqueue(execution, async () => {
          const { path, content } = writeSchema.parse(input)
          if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('managed write exceeds size limit')
          if (!task.capabilities.writeOwnedFiles || !inScope(path, task.writePaths)) throw new Error('write is outside task scope')
          await verifyHostPolicy('write', path)
          ownership.verifyWrite(task, path)
          await options.verifyCurrentApproval()
          let session = sessions.get(path)
          if (session === undefined) { session = await patches.begin([path]); sessions.set(path, session) }
          const patch = await session.captureAgentEditWithWriter({ path, bytes: content }, async ({ bytes, before }) => {
            const action = { kind: 'write', targetPath: path }
            const policyContext = { workspace, phase: initialPhase }
            const operation = before.state === 'missing' ? policy.executeSpecificationCreate.bind(policy) : policy.executeSpecificationWrite.bind(policy)
            await operation(action, policyContext, async handle => {
              await check(execution)
              ownership.verifyWrite(task, path)
              const opened = await handle.stat()
              if (before.state === 'present') {
                const current = await captureFileSnapshot(root, path)
                if (current.sha256 !== before.sha256 || current.identity?.ino !== opened.ino || current.identity?.dev !== opened.dev || before.identity?.ino !== opened.ino || before.identity?.dev !== opened.dev) throw new Error('document changed before approved write')
              }
              // Revalidate after asynchronous snapshot inspection. Once this final
              // authorization succeeds, this write transaction may finish; revocation
              // prevents subsequent transactions rather than interrupting a partial write.
              await options.verifyCurrentApproval()
              await verifyHostPolicy('write', path)
              await check(execution)
              ownership.verifyWrite(task, path)
              if (execution.signal.aborted) throw new Error('managed Agent operation aborted')
              await handle.truncate(0)
              await handle.writeFile(bytes)
              await handle.sync()
            })
          })
          return { path, beforeSha256: patch.beforeSha256 ?? null, afterSha256: patch.afterSha256 }
        }),
      }
      context.tools.register(read)
      context.tools.register(write)
    } catch (error) { await release(); throw error }
  }
}

function inScope(path: string, scopes: readonly string[]): boolean { return scopes.includes(path) }
function outputSchema(properties: Record<string, HarnessJsonSchema>): HarnessToolRegistrationDefinition['output'] {
  return { schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
}

const roleOutputs: Readonly<Record<string, readonly string[]>> = {
  requirements: ['spec.md', 'clarification.md'],
  'backend-architect': ['plan.md', 'architecture.md', 'contracts/openapi.yaml'],
  'database-designer': ['data-model.md', 'test-plan.md'],
  'oss-researcher': ['research.md', 'decisions.md'],
  planner: ['tasks.md'],
}
const rolePhases: Readonly<Record<string, string>> = { requirements: 'SPECIFY', 'backend-architect': 'DESIGN', 'database-designer': 'DESIGN', 'oss-researcher': 'DESIGN', planner: 'PLAN' }
const artifactNames = Object.values(roleOutputs).flat()
function featurePath(root: string, input: string): string {
  const path = input.startsWith('/') ? relative(root, input) : input
  pathSchema.parse(path)
  if (path.split('/').length !== 2 || !path.startsWith('specs/')) throw new Error('invalid specification feature directory')
  try {
    if (realpathSync(join(root, path)) !== join(root, path)) throw new Error('noncanonical feature')
  } catch { throw new Error('specification feature must be an existing real directory') }
  return path
}
