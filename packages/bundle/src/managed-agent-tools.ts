import { runManagedTypecheck } from './managed-typecheck.js'
import { checkCredentials } from './credential-check.js'
import type { ManagedTestEvidence } from './managed-test-evidence.js'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { AgentTaskSchema, type PolicyEngine, type WorkspaceLayout } from '@dsh-backend-team/contracts'
import { OwnershipManager } from '@dsh-backend-team/agent-team/ownership-manager'
import { DefaultPolicyEngine } from '@dsh-backend-team/policy-engine'
import { PatchTracker, type PatchSession } from '@dsh-backend-team/development/patch-tracker'
import { captureFileSnapshot } from '@dsh-backend-team/development/file-snapshot'
import type { HarnessAgentSetup, HarnessJsonSchema, HarnessToolExecution, HarnessToolRegistrationDefinition } from '@dsh-backend-team/harness-adapter'
import type { AgentHandoff, CommandRequest, CommandResult } from '@dsh-backend-team/contracts'

export interface ManagedAgentToolOptions {
  readonly nodeTests?: ManagedTestEvidence
  /** Host-owned command boundary. The callback must perform policy and approval checks. */
  readonly commandRunner?: { run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> }
  /** Resolves a short-lived approval token for the exact command proposed by this task. */
  readonly commandApprovalToken?: (input: { readonly taskId: string; readonly request: CommandRequest }) => Promise<string | undefined>
  readonly workspaceRoot: string
  readonly recoveryToken: string
  readonly readPhase: () => Promise<string>
  readonly verifyCurrentApproval: () => Promise<void>
  readonly policyEngine: PolicyEngine
}
const pathSchema = z.string().min(1).max(1024).refine(path => path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.')) && !/[\\:\u0000-\u001f\u007f]/u.test(path), 'unsafe task path')
const readSchema = z.object({ path: pathSchema }).strict()
const writeSchema = readSchema.extend({ content: z.string().max(1024 * 1024) }).strict()
const baseAllowedTools = new Set(['backend_team_read', 'backend_team_write', 'backend_team_scan', 'backend_team_typecheck'])

// Keep the delegation contract explicit for OpenAI-compatible model adapters.
// A schema with only `additionalProperties: true` is rejected by Qwen before the
// Agent receives a request, which makes every delegating developer fail at startup.
const delegationParameters = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    parentTaskId: { type: 'string' },
    depth: { type: 'integer', const: 2 },
    role: { type: 'string', const: 'worker' },
    objective: { type: 'string' },
    nonGoals: { type: 'array', items: { type: 'string' } },
    inputArtifacts: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string' } }, required: ['path', 'sha256'], additionalProperties: false } },
    readPaths: { type: 'array', items: { type: 'string' } },
    writePaths: { type: 'array', items: { type: 'string' } },
    capabilities: {
      type: 'object',
      properties: {
        readProjectFiles: { type: 'boolean' },
        writeOwnedFiles: { type: 'boolean' },
        businessCodeWrite: { type: 'boolean' },
        testCodeWrite: { type: 'boolean' },
        configurationWrite: { type: 'boolean' },
        commandExecution: { type: 'boolean' },
        networkHosts: { type: 'array', items: { type: 'string' } },
        install: { type: 'boolean' },
        migration: { type: 'boolean' },
        canDelegate: { type: 'boolean', const: false },
        canChangePhase: { type: 'boolean' },
        canApprove: { type: 'boolean' },
        canContactUser: { type: 'boolean' },
        canAnnounceCompletion: { type: 'boolean' },
      },
      required: ['readProjectFiles', 'writeOwnedFiles', 'businessCodeWrite', 'testCodeWrite', 'configurationWrite', 'commandExecution', 'networkHosts', 'install', 'migration', 'canDelegate', 'canChangePhase', 'canApprove', 'canContactUser', 'canAnnounceCompletion'],
      additionalProperties: false,
    },
    budget: {
      type: 'object',
      properties: {
        maxTokens: { type: 'integer' },
        maxWallMs: { type: 'integer' },
        maxToolCalls: { type: 'integer' },
        maxRetries: { type: 'integer' },
        maxChildren: { type: 'integer' },
      },
      required: ['maxTokens', 'maxWallMs', 'maxToolCalls', 'maxRetries', 'maxChildren'],
      additionalProperties: false,
    },
    doneWhen: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' }, instruction: { type: 'string' }, required: { type: 'boolean' } }, required: ['id', 'kind', 'instruction', 'required'], additionalProperties: false } },
    returnSchema: { type: 'string' },
  },
  required: ['id', 'parentTaskId', 'depth', 'role', 'objective', 'nonGoals', 'inputArtifacts', 'readPaths', 'writePaths', 'capabilities', 'budget', 'doneWhen', 'verification', 'returnSchema'],
  additionalProperties: false,
} as const

/** Installs only scoped source-file I/O; commands and specification agents remain unavailable. */
export function createManagedAgentToolSetup(options: ManagedAgentToolOptions): HarnessAgentSetup {
  const root = realpathSync(options.workspaceRoot)
  const teamDir = join(root, '.backend-team')
  const workspace: WorkspaceLayout = { root, teamDir, stateDir: join(teamDir, 'state'), runtimeDir: join(teamDir, 'runtime'), cacheDir: join(teamDir, 'cache'), logsDir: join(teamDir, 'logs'), locksDir: join(teamDir, 'locks'), handoffDir: join(teamDir, 'handoff') }
  const ownership = new OwnershipManager({ workspaceRoot: root, recoveryToken: options.recoveryToken })
  return async (context, request) => {
    const owner = context.agent
    if (owner === undefined || typeof owner !== 'object' || owner === null) throw new Error('managed Agent identity is required')
    if (typeof context.tools.presentAs !== 'function') throw new Error('managed Agent requires scoped native tool presentation')
    const task = AgentTaskSchema.parse(request.agentTask)
    const initialPhase = await options.readPhase()
    if (initialPhase !== 'BUILD' && initialPhase !== 'VERIFY') throw new Error('managed source tools require development phase')
    const verifyHostPolicy = async (kind: 'read' | 'write', path: string): Promise<void> => {
      const decision = await options.policyEngine.authorize({ kind, targetPath: join(root, path) }, { workspace, phase: initialPhase })
      if (decision.effect !== 'allow') throw new Error(`host policy denied ${kind}: ${decision.ruleId}`)
    }
    const deadline = Date.now() + task.budget.maxWallMs
    let calls = 0
    let queue: Promise<unknown> = Promise.resolve()
    const sessions = new Map<string, PatchSession>()
    const patches = new PatchTracker({ workspaceRoot: root, runId: `${task.id}-${randomUUID()}` })
    const policy = new DefaultPolicyEngine({ ownedWriteGrantVerifier: { verify: async ({ canonicalTargetPath }) => {
      await options.verifyCurrentApproval()
      ownership.verifyWrite(task, relative(root, canonicalTargetPath).replaceAll('\\', '/'))
      return true
    } } })
    const allowedTools = new Set(baseAllowedTools)
    if (options.commandRunner !== undefined && options.commandApprovalToken !== undefined) allowedTools.add('backend_team_command')
    if (task.capabilities.canDelegate && request.delegation !== undefined) allowedTools.add('backend_team_delegate_worker')
    const check = async (execution: HarnessToolExecution): Promise<void> => {
      if (execution.agent !== owner) throw new Error('managed Agent identity mismatch')
      if (execution.signal.aborted) throw new Error('managed Agent operation aborted')
      if (Date.now() >= deadline) throw new Error('managed Agent time budget exhausted')
      if (await options.readPhase() !== initialPhase) throw new Error('managed Agent phase changed')
    }
    const enqueue = (execution: HarnessToolExecution, operation: () => Promise<unknown>): Promise<unknown> => {
      if (execution.agent !== owner) return Promise.reject(new Error('managed Agent identity mismatch'))
      if (++calls > task.budget.maxToolCalls) return Promise.reject(new Error('managed Agent tool budget exhausted'))
      const running = queue.then(async () => { await check(execution); return operation() })
      queue = running.catch(() => {})
      return running
    }
    context.tools.guard(execution => execution.agent !== owner ? 'managed Agent identity mismatch' : (allowedTools.has(execution.name) || (options.nodeTests !== undefined && execution.name === 'backend_team_test')) ? undefined : 'tool is disabled for managed backend Agent')
    context.tools.presentAs('native')
    const read: HarnessToolRegistrationDefinition = {
      name: 'backend_team_read', description: 'Read one declared source file. Returns its UTF-8 content and SHA-256. Native file and shell tools are disabled.', parameters: z.toJSONSchema(readSchema),
      output: outputSchema({ path: { type: 'string' }, content: { type: 'string' }, sha256: { type: 'string' } }),
      execute: (input, execution) => enqueue(execution, async () => {
        const { path } = readSchema.parse(input)
        if (!task.capabilities.readProjectFiles || !inScope(path, task.readPaths)) throw new Error('read is outside task scope')
        await verifyHostPolicy('read', path)
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
      name: 'backend_team_write', description: 'Replace or create one explicitly owned source file and record patch evidence. Parent directory must already exist. No commands or deployment are supported.', parameters: z.toJSONSchema(writeSchema),
      output: outputSchema({ path: { type: 'string' }, beforeSha256: { oneOf: [{ type: 'string' }, { type: 'null' }] }, afterSha256: { type: 'string' } }),
      execute: (input, execution) => enqueue(execution, async () => {
        const { path, content } = writeSchema.parse(input)
        if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('managed write exceeds size limit')
        if (!task.capabilities.writeOwnedFiles || !inScope(path, task.writePaths)) throw new Error('write is outside task scope')
        if (isMigrationPath(path) && !task.capabilities.migration) throw new Error('migration files are host-controlled; stop retrying and request the host migration approval flow')
        await verifyHostPolicy('write', path)
        ownership.verifyWrite(task, path)
        await options.verifyCurrentApproval()
        let session = sessions.get(path)
        if (session === undefined) { session = await patches.begin([path]); sessions.set(path, session) }
        const patch = await session.captureAgentEditWithWriter({ path, bytes: content }, async ({ bytes, before }) => {
          const action = { kind: 'write', targetPath: path }
          const policyContext = { workspace, phase: initialPhase }
          const operation = before.state === 'missing' ? policy.executeApprovedCreate.bind(policy) : policy.executeApprovedWrite.bind(policy)
          await operation(action, policyContext, async handle => {
            await check(execution)
            ownership.verifyWrite(task, path)
            const opened = await handle.stat()
            if (before.state === 'present') {
              const current = await captureFileSnapshot(root, path)
              if (current.sha256 !== before.sha256 || current.identity?.ino !== opened.ino || current.identity?.dev !== opened.dev || before.identity?.ino !== opened.ino || before.identity?.dev !== opened.dev) throw new Error('source changed before approved write')
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
        options.nodeTests?.invalidate(task.id)
        return { path, beforeSha256: patch.beforeSha256 ?? null, afterSha256: patch.afterSha256 }
      }),
    }
    context.tools.register(read)
    context.tools.register(write)
    context.tools.register({
      name: 'backend_team_scan', description: 'Check one declared source file for common hard-coded credentials and private keys. Returns locations without secret values. Fix findings before delivery; a pass is not a full security audit.', parameters: z.toJSONSchema(readSchema),
      output: outputSchema({ status: { type: 'string' }, scope: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } }, omittedFindings: { type: 'integer' } }),
      execute: async (input, execution) => {
        await options.verifyCurrentApproval()
        const value = await read.execute(input, execution) as { path: string; content: string }
        await check(execution)
        await options.verifyCurrentApproval()
        return checkCredentials([value])
      },
    })
    context.tools.register({
      name: 'backend_team_typecheck', description: 'Run a read-only strict TypeScript check on declared source files with bundled Node types. Uses fixed ES2022/ESNext/bundler settings, ignores project tsconfig, emits nothing, executes no project scripts and installs nothing. This is a scoped check, not a project build or full project typecheck. Run after all declared inputs exist; fix diagnostics before reporting success.',
      parameters: z.toJSONSchema(z.object({ files: z.array(pathSchema).min(1).max(20) }).strict()),
      output: outputSchema({ argv: { type: 'array', items: { type: 'string' } }, exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' }, scope: { type: 'string' } }),
      execute: (input, execution) => enqueue(execution, async () => {
        if (!task.capabilities.commandExecution || !task.capabilities.readProjectFiles) throw new Error('typecheck is outside task capability')
        const { files } = z.object({ files: z.array(pathSchema).min(1).max(20) }).strict().parse(input)
        for (const path of task.readPaths) await verifyHostPolicy('read', path)
        await options.verifyCurrentApproval()
        const result = await runManagedTypecheck({ workspaceRoot: root, files, readPaths: task.readPaths, signal: execution.signal, maxWallMs: Math.max(1, deadline - Date.now()) })
        await check(execution)
        await options.verifyCurrentApproval()
        return result
      }),
    })
    if (options.nodeTests !== undefined) {
      const parameters = z.object({ files: z.array(pathSchema).min(1).max(20) }).strict()
      context.tools.register({
        name: 'backend_team_test', description: 'Run declared Node test files. Tests may read only declared existing files, cannot write files or spawn processes, and may use loopback HTTP only. Returns actual command arguments, exit code and TAP output. Run after the final edit; report blocked if required inputs do not exist.',
        parameters: z.toJSONSchema(parameters),
        output: outputSchema({ argv: { type: 'array', items: { type: 'string' } }, exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' } }),
        execute: (input, execution) => enqueue(execution, async () => {
          if (!task.capabilities.commandExecution) throw new Error('test execution is outside task capability')
          const { files } = parameters.parse(input)
          for (const path of task.readPaths) await verifyHostPolicy('read', path)
          await options.verifyCurrentApproval()
          const result = await options.nodeTests!.run(task.id, { workspaceRoot: root, files, readPaths: task.readPaths, signal: execution.signal, maxWallMs: Math.max(1, deadline - Date.now()) })
          await check(execution)
          await options.verifyCurrentApproval()
          return result
        }),
      })
    }
    if (options.commandRunner !== undefined && options.commandApprovalToken !== undefined) {
      const commandSchema = z.object({
        executable: pathSchema,
        args: z.array(z.string().max(4096)).max(128),
        cwd: pathSchema.optional(),
        env: z.record(z.string().max(128), z.string().max(4096)).default({}),
        purpose: z.string().trim().min(1).max(256),
        risk: z.enum(['read', 'write', 'install', 'migration', 'destructive']),
        networkPolicy: z.enum(['deny', 'allow']).default('deny'),
        executionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      }).strict()
      context.tools.register({
        name: 'backend_team_command',
        description: 'Run one explicitly declared project command through the host policy and approval boundary. Shell syntax, pipelines, global executables, and implicit approvals are unavailable; network is denied unless the host-approved task explicitly allows it.',
        parameters: z.toJSONSchema(commandSchema),
        output: outputSchema({ argv: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' }, durationMs: { type: 'integer' }, networkPolicy: { type: 'string' }, approvalRequired: { type: 'boolean' } }),
        execute: (input, execution) => enqueue(execution, async () => {
          if (!task.capabilities.commandExecution) throw new Error('command execution is outside task capability')
          const parsed = commandSchema.parse(input)
          if (parsed.risk === 'install' && !task.capabilities.install) throw new Error('dependency installation is outside task capability')
          if (parsed.risk === 'migration' && !task.capabilities.migration) throw new Error('migration execution is outside task capability')
          if (parsed.networkPolicy === 'allow' && task.capabilities.networkHosts.length === 0) throw new Error('network access is outside task capability')
          const executable = join(root, parsed.executable)
          const cwd = parsed.cwd === undefined ? root : join(root, parsed.cwd)
          const request: CommandRequest = {
            executable,
            args: parsed.args,
            cwd,
            env: { ...parsed.env },
            purpose: parsed.purpose,
            risk: parsed.risk,
            networkPolicy: parsed.networkPolicy,
            executionFingerprint: parsed.executionFingerprint ?? commandFingerprint({ executable, args: parsed.args, cwd, env: parsed.env, purpose: parsed.purpose, risk: parsed.risk, networkPolicy: parsed.networkPolicy }),
          }
          await check(execution)
          await options.verifyCurrentApproval()
          const approvalToken = await options.commandApprovalToken!({ taskId: task.id, request })
          if (approvalToken === undefined || approvalToken.length < 16) throw new Error('approved command token is missing or expired')
          const result = await options.commandRunner!.run({ ...request, approvalToken }, execution.signal)
          await check(execution)
          await options.verifyCurrentApproval()
          return { argv: [request.executable, ...request.args], cwd: request.cwd, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, networkPolicy: request.networkPolicy ?? 'deny', approvalRequired: true }
        }),
      })
    }
    if (task.capabilities.canDelegate && request.delegation !== undefined) {
      context.tools.register({
        name: 'backend_team_delegate_worker',
        description: 'Ask the coordinator to create one depth-two worker from this expert task. The coordinator rechecks phase, approval, ownership, paths, budget, and role limits before spawning; workers cannot delegate further.',
        parameters: delegationParameters,
        output: outputSchema({ handoffId: { type: 'string' }, taskId: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' } }),
        execute: (input, execution) => enqueue(execution, async () => {
          if (!task.capabilities.canDelegate) throw new Error('worker delegation is outside task capability')
          await check(execution)
          await options.verifyCurrentApproval()
          const proposed = AgentTaskSchema.parse(input)
          const handoff: AgentHandoff = await request.delegation!.delegateWorker(proposed)
          await check(execution)
          return { handoffId: handoff.id, taskId: handoff.taskId, status: handoff.status, summary: handoff.summary }
        }),
      })
    }
  }
}

function inScope(path: string, scopes: readonly string[]): boolean { return scopes.some(scope => path === scope || path.startsWith(scope + '/')) }
function isMigrationPath(path: string): boolean { return /(?:^|\/)(?:migrations?|drizzle)(?:\/|$)|\.sql$/u.test(path) }
function outputSchema(properties: Record<string, HarnessJsonSchema>): HarnessToolRegistrationDefinition['output'] {
  return { schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
}

function commandFingerprint(input: { readonly executable: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly purpose: string; readonly risk: string; readonly networkPolicy: string }): string {
  return createHash('sha256').update(JSON.stringify({ executable: input.executable, args: input.args, cwd: input.cwd, env: input.env, purpose: input.purpose, risk: input.risk, networkPolicy: input.networkPolicy })).digest('hex')
}
