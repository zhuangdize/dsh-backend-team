import { createProjectAwareCommands } from './project-aware-commands.js'
import { gunzipSync } from 'node:zlib'
import { FileDevelopmentCheckpointStore } from '@dsh-backend-team/development/checkpoint-store'
import { prepareDevelopmentDirectories, validateDevelopmentPaths } from './development-directories.js'
import { verifyDeliveryRecord } from './delivery-recovery.js'
import { approvedTestBindings, validateApprovedTestPlan } from './approved-test-bindings.js'
import { ensureWorkspaceBaseline, prepareWorkspaceChangeBaseline, validateWorkspacePlanBoundary } from './workspace-boundary-evidence.js'
import { captureFileSnapshot } from '@dsh-backend-team/development/file-snapshot'
import type { DevelopmentRunSnapshot } from '@dsh-backend-team/development'
import { RequirementChangeService, ControlMediatedApprovalPort } from '@dsh-backend-team/core'
import { DatabaseMigrationReview } from './database-migration-review.js'
import { FileMigrationReviewStore } from './migration-review-store.js'
import { verifyFinalDevelopment, FinalEvidenceBindingsSchema } from './final-development-verification.js'
import { createNativePostgresql } from './native-postgresql.js'
import { constants } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { createWorkspaceLayout, initializeWorkspaceLayout } from '@dsh-backend-team/platform-macos'
import { ArtifactRegistry, ArtifactValidator, SpecKitCommandLoader, SpecKitProject, FEATURE_ARTIFACT_PATHS } from '@dsh-backend-team/spec-workflow'
import { FileDevelopmentPlanLoader } from '@dsh-backend-team/development/plan-loader'
import { BackendTeamControlActionSchema } from '../../web/src/control-actions.js'
import { BackendTeamStateSchema, type PolicyEngine } from '@dsh-backend-team/contracts'
import { PatchTracker } from '@dsh-backend-team/development/patch-tracker'
import { SharedLongTaskRunLease } from '@dsh-backend-team/agent-team'
import { createProductionDevelopmentRun, createDshProductionHost, type BackendTeamProductionContext, type ProductionHost } from './production.js'
import { createProductionWorkflowCommandImplementations } from './production-workflow-commands.js'

const Config = z.object({ finalEvidenceBindings: FinalEvidenceBindingsSchema.optional(), database: z.object({ enabled: z.literal(true), executableRoot: z.string().min(1), migrationToolingRoot: z.string().min(1).optional(), /** Relative project path for the reviewed Drizzle schema output. */ ormSchemaPath: z.string().min(1).optional(), dbgate: z.object({ enabled: z.literal(true), runtimeRoot: z.string().min(1), port: z.number().int().min(1024).max(65535) }).strict().optional() }).strict().optional(), development: z.object({ enabled: z.literal(true), writeRoots: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).refine(path => !['specs', 'node_modules'].includes(path))).min(1).max(10).default(['src', 'test']) }).strict().optional(), enabled: z.literal(true), workspaceRoot: z.string().min(1), feature: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/), workspaceName: z.string().min(1).max(100).optional(), provider: z.string().min(1).optional(), model: z.string().min(1).optional(), maxTokens: z.number().int().positive().max(1_000_000).default(262144), maxWallMs: z.number().int().positive().max(1_200_000).default(180000) }).strict()

/** Explicit opt-in document workflow host; installation and code/database execution are separate capabilities. */
export async function createConfiguredWorkflowHost(context: BackendTeamProductionContext, input: unknown, task: { taskId?: string; registerRoutes?: boolean } = {}): Promise<ProductionHost | undefined> {
  if (input === undefined || (typeof input === 'object' && input !== null && Reflect.get(input, 'enabled') === false)) return undefined
  const config = Config.parse(input)
  const root = await realpath(config.workspaceRoot)
  if (root !== resolve(config.workspaceRoot)) throw new Error('workflow workspace must be canonical')
  const layout = createWorkspaceLayout(root)
  const initialized = await new SpecKitProject(layout).requireInitializedGeneric()
  const commandLoader = new SpecKitCommandLoader({ commandsDirectory: initialized.commandsDirectory })
  for (const command of ['speckit.specify', 'speckit.clarify', 'speckit.plan', 'speckit.tasks']) await commandLoader.load(command, '')
  // Verify host services before preparing any workspace state.
  const { createVerifiedDshHostPort, createVerifiedDshSessionPort } = await import('./dsh-production-ports.js')
  createVerifiedDshHostPort(context)
  createVerifiedDshSessionPort({ context, workspaceId: root, workspaceRoot: root })
  await initializeWorkspaceLayout(layout)
  const featureDirectory = join(root, 'specs', config.feature)
  for (const path of [join(root, 'specs'), featureDirectory, join(featureDirectory, 'contracts')]) {
    try { await mkdir(path, { mode: 0o700 }) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('unsafe workflow feature directory')
  }
  if (config.development !== undefined) {
    if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('development execution requires macOS and Node 24')
    for (const name of config.development.writeRoots) {
      const directory = join(root, name)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('unsafe development output directory')
    }
  }
  const database = config.database === undefined ? undefined : await createNativePostgresql(root, config.database.executableRoot, config.database.dbgate, undefined, config.database.migrationToolingRoot, config.database.ormSchemaPath)
  const migrationStore = database === undefined || config.database?.migrationToolingRoot === undefined ? undefined : new FileMigrationReviewStore(root, task.taskId)
  let migrationReview: DatabaseMigrationReview | undefined
  if (task.taskId !== undefined && config.development !== undefined) await ensureWorkspaceBaseline(root, task.taskId, config.development.writeRoots)
  const recoveryToken = await recoveryKey(join(layout.stateDir, 'workflow-host.key'))
  const artifactRegistry = new ArtifactRegistry(root, { environment: { SPECIFY_FEATURE_DIRECTORY: featureDirectory } })
  const artifactValidator = new ArtifactValidator(artifactRegistry)
  const rawTaskPlanLoader = new FileDevelopmentPlanLoader(root, artifactRegistry)
  const taskPlanLoader = { load: async () => { const plan = await rawTaskPlanLoader.load(); if (config.development !== undefined) await validateDevelopmentPaths(root, plan, config.development.writeRoots); if (task.taskId !== undefined) await validateApprovedTestPlan(root, plan); return plan } }
  const ownedDocuments = new Set(FEATURE_ARTIFACT_PATHS.map(file => join(featureDirectory, file)))
  const policyEngine: PolicyEngine = { authorize: async (action, policyContext) => {
    const target = 'targetPath' in action && typeof action.targetPath === 'string' ? resolve(root, action.targetPath) : ''
    const developmentPhase = ['BUILD', 'VERIFY'].includes(policyContext.phase)
    const source = config.development?.writeRoots.some(name => target.startsWith(join(root, name) + '/')) ?? false
    const developmentAllowed = config.development !== undefined && developmentPhase && (action.kind === 'read' ? source || ownedDocuments.has(target) : action.kind === 'write' && source && !ownedDocuments.has(target))
    const allowed = developmentAllowed || (action.kind === 'read' || action.kind === 'write') && typeof action.targetPath === 'string' && ownedDocuments.has(resolve(root, action.targetPath)) && ['SPECIFY', 'DESIGN', 'PLAN'].includes(policyContext.phase)
    return { effect: allowed ? 'allow' : 'deny', ruleId: 'configured-document-workflow', reason: allowed ? 'owned specification document; role and guarded file checks apply' : 'capability is not enabled by this document workflow host' }
  } }
  const unavailable = async () => { throw new Error('database and development execution are not configured in this document workflow host') }
  // One host lease covers the complete development run and every nested Agent
  // session. The in-process wrapper keeps the underlying cross-process lock
  // held until both layers have released it.
  const developmentCheckpoints = config.development === undefined ? undefined : new FileDevelopmentCheckpointStore(root, task.taskId)
  const sharedRunLease = developmentCheckpoints === undefined ? undefined : new SharedLongTaskRunLease({ acquire: () => developmentCheckpoints.acquireRun() })
  let developmentRun: import('./production.js').ProductionDevelopmentRunPort | undefined
  const host = await createDshProductionHost({
    ...task,
    restorePendingApprovals: hasUserQuestions(context),
    ...(database === undefined ? {} : { databasePort: database.port, databaseFeed: database.feed }),
    context, workspaceRoot: root, workspaceName: config.workspaceName ?? config.feature,
    recoveryToken, policyEngine,
    ...(config.provider === undefined ? {} : { provider: config.provider }), ...(config.model === undefined ? {} : { model: config.model }),
    ...(sharedRunLease === undefined ? {} : {
      longTask: {
        runLease: sharedRunLease,
        contextOptions: { contextWindowTokens: 131_072, outputLimitTokens: 8_192, toolBufferTokens: 8_192, safetyMarginTokens: 4_096, retainRecentMessages: 12, maxSummaryTokens: 2_048 },
        shouldBind: task => task.capabilities.businessCodeWrite || task.capabilities.testCodeWrite || task.capabilities.configurationWrite || task.capabilities.commandExecution || task.capabilities.migration,
      },
    }),
    specification: { autoAdvance: true, resume: async () => { if (developmentRun === undefined) throw new Error('development execution is not configured'); await developmentRun.resume() }, commandLoader: createProjectAwareCommands(layout, commandLoader, config.development?.writeRoots ?? []), artifactRegistry, artifactValidator, taskPlanLoader, budget: { maxAgents: 1, maxSteps: 24, maxTokens: config.maxTokens, maxWallMs: config.maxWallMs } },
    initialState: { executionAvailable: config.development !== undefined, workflowRetryAvailable: true },
    ...(config.development === undefined ? {} : {
      enableManagedNodeTests: true,
      developmentRunFactory: async composition => {
        const lifecycle = composition.deliveryLifecycle
        if (lifecycle === undefined) throw new Error('delivery lifecycle is unavailable')
        const savedState = await composition.stateStore.load()
        const saved = savedState?.finalVerification
        let initialSnapshot: DevelopmentRunSnapshot = { status: 'idle' }
        if (saved !== undefined) {
          try {
            const plan = await taskPlanLoader.load()
            const evidenceBindings = task.taskId === undefined ? config.finalEvidenceBindings : await approvedTestBindings(root, plan, composition.verifyDevelopmentApproval, { taskId: task.taskId, refresh: false })
            await verifyDeliveryRecord({ workspaceRoot: root, record: saved, plan, evidenceBindings, verifyApproval: composition.verifyDevelopmentApproval })
            initialSnapshot = { status: saved.delivery.status === 'ready' ? 'passed' : 'blocked', delivery: saved.delivery, message: '已恢复上次验收结果。' }
          } catch {
            await lifecycle.invalidate()
            initialSnapshot = { status: 'blocked', message: '上次验收依据已变化或无法核对，请重新验收。' }
          }
        }
        if (initialSnapshot.status === 'idle' && savedState?.workflowError !== undefined) {
          initialSnapshot = { status: 'blocked', message: savedState.workflowError }
        }
        if (initialSnapshot.status === 'idle') {
          const historicalFailure = await lastTerminalRunFailure(composition.events)
          if (historicalFailure !== undefined) {
            initialSnapshot = { status: historicalFailure.status, message: historicalFailure.message }
            if (composition.stateStore.transact !== undefined) {
              const current = await composition.stateStore.load()
              if (current !== null && current.workflowError === undefined) await composition.stateStore.transact(current.revision, state => ({ ...state, workflowError: historicalFailure.message }))
            }
          }
        }
        const patches = new PatchTracker({ workspaceRoot: root, runId: 'development-' + randomUUID() })
        developmentRun = createProductionDevelopmentRun({ ...(task.taskId === undefined ? {} : { taskId: task.taskId }), workspaceRoot: root, ...(sharedRunLease === undefined ? {} : { runLease: sharedRunLease }), loadPlan: async () => { await composition.verifyDevelopmentApproval(); const plan = await taskPlanLoader.load(); if (task.taskId) await validateWorkspacePlanBoundary(root, task.taskId, plan, config.development!.writeRoots); await prepareDevelopmentDirectories(root, plan, config.development!.writeRoots); return plan }, coordinator: composition.coordinator, verifyDesignApproval: composition.verifyDevelopmentApproval, recoverAbandonedOwnership: composition.recoverAbandonedOwnership, initialSnapshot, verifyFinal: async (plan, result) => {
          await lifecycle.begin()
          const evidenceBindings = task.taskId === undefined ? config.finalEvidenceBindings : await approvedTestBindings(root, plan, composition.verifyDevelopmentApproval, { taskId: task.taskId, refresh: true })
          const verification = await verifyFinalDevelopment({ workspaceRoot: root, plan, result, ...(evidenceBindings === undefined ? {} : { evidenceBindings }), verifyApproval: composition.verifyDevelopmentApproval })
          if (verification.delivery !== undefined) {
            const report = await captureFileSnapshot(root, verification.delivery.reportPath)
            if (report.state !== 'present' || report.sha256 === undefined) throw new Error('final report is unavailable')
            const record = { delivery: verification.delivery, reportSha256: report.sha256 }
            await verifyDeliveryRecord({ workspaceRoot: root, record, plan, evidenceBindings, verifyApproval: composition.verifyDevelopmentApproval })
            await lifecycle.finish(record)
          }
          return { ...verification, status: verification.delivery?.status === 'ready' ? verification.status : verification.status === 'passed' ? 'blocked' as const : verification.status }
        }, beforeResume: async () => {
          const current = await composition.stateStore.load()
          if (current?.workflowError !== undefined) {
            if (composition.stateStore.transact === undefined) throw new Error('任务状态不支持清除恢复错误')
            await composition.stateStore.transact(current.revision, ({ workflowError: _error, ...rest }) => { void _error; return rest })
          }
        }, beginPatch: paths => patches.begin(paths), budget: { maxTokens: config.maxTokens, maxWallMs: config.maxWallMs, maxToolCalls: 100, maxRetries: 2, maxChildren: 0 } })
        return developmentRun
      },
    }),
    coordinatorImplementationFactory: composition => {
      const approvals = composition.approvals
      if (!(approvals instanceof ControlMediatedApprovalPort)) throw new Error('migration controls require the native approval port')
      const migration = database === undefined || migrationStore === undefined ? undefined : new DatabaseMigrationReview({ workspaceRoot: root, approvals, readRevision: async () => (await composition.stateStore.load())!.revision, prepare: () => database.prepareMigration(), restore: record => database.restoreMigration(record), store: migrationStore })
      migrationReview = migration
      const change = new RequirementChangeService({
        stateStore: {
          load: async () => { const state = await composition.stateStore.load(); return state === null ? null : BackendTeamStateSchema.parse(state) },
          transact: (revision, update) => { if (!composition.stateStore.transact) throw new Error('任务状态不支持持久化变更'); return composition.stateStore.transact(revision, update) },
        },
        stopDevelopment: async () => { if (!developmentRun?.pauseAndWait) throw new Error('当前宿主不支持安全暂停并修改需求'); await developmentRun.pauseAndWait() },
        assertIdle: () => { const activity = composition.scheduler?.snapshot(); if (!activity || activity.activeExperts || activity.activeWriters || activity.queued) throw new Error('请等待团队停止写入后再修改需求') },
        snapshotDocuments: async () => {
          const snapshot = await artifactRegistry.snapshot()
          return Promise.all(snapshot.artifacts.map(async artifact => ({ path: artifact.path, content: gunzipSync((await captureFileSnapshot(root, artifact.absolutePath.slice(root.length + 1), { maxBytes: 262144 })).compressedBytes).toString('utf8') })))
        },
        archiveCheckpoint: id => new FileDevelopmentCheckpointStore(root, task.taskId).archiveForChange(id),
        prepareExecutionBaseline: async id => { if (task.taskId && config.development) await prepareWorkspaceChangeBaseline(root, task.taskId, id, config.development.writeRoots) },
        generateRequirements: text => composition.workflow!.start(text),
        publishApproval: () => composition.requestWorkflowApproval('requirements'),
      })
      const snapshotPort = database?.port
      const createSnapshot = snapshotPort?.createSnapshot
      const restoreSnapshot = snapshotPort?.restoreSnapshot
      return createProductionWorkflowCommandImplementations(composition, {
      changeRequirements: (text, revision, sessionId) => change.request(text, revision, sessionId),
      recoverRequirements: () => change.recover(),
      prepareDatabaseMigration: async (input, context) => {
        const action = BackendTeamControlActionSchema.parse(input)
        if (action.type !== 'prepare-database-migration' || action.workspaceId !== root || typeof context !== 'object' || context === null || Reflect.get(context, 'workspaceId') !== root || Reflect.get(context, 'expectedRevision') !== action.expectedRevision || typeof Reflect.get(context, 'authenticatedSessionId') !== 'string') throw new Error('authenticated migration action is required')
        if (migration === undefined) throw new Error('数据库迁移尚未配置')
        const activity = composition.scheduler?.snapshot()
        if (activity !== undefined && (activity.activeExperts > 0 || activity.activeWriters > 0 || activity.queued > 0)) throw new Error('请等待当前开发任务完成后再迁移数据库')
        await migration.prepare(action.expectedRevision)
      },
      openArtifact: async (input) => {
        const action = BackendTeamControlActionSchema.parse(input)
        if (action.type !== 'open-artifact') throw new Error('artifact action is required')
        const preview = await migration?.preview(action.artifactId)
        if (preview !== undefined) return { artifactPreview: preview }
        const { readApprovalArtifactPreview } = await import('./approval-artifact-preview.js')
        return { artifactPreview: await readApprovalArtifactPreview({ workspaceRoot: root, artifactRegistry, approvals: composition.approvals, readRevision: async () => (await composition.stateStore.load())!.revision }, action) }
      },
      pauseRun: unavailable, resumeRun: unavailable, startDatabase: database === undefined ? unavailable : async () => { await database.port.start() }, stopDatabase: database === undefined ? unavailable : async () => { migration?.assertIdle(); await database.port.stop() }, openDatabaseGui: database === undefined || config.database?.dbgate === undefined ? unavailable : async (_action, context) => {
        const sessionId = typeof context === 'object' && context !== null ? Reflect.get(context, 'authenticatedSessionId') as unknown : undefined
        if (typeof sessionId !== 'string' || sessionId.length < 16) throw new Error('authenticated GUI session is required')
        return { navigation: { ...await database.port.openGui(sessionId), kind: 'one-time-local-url' } }
      },
      ...(createSnapshot === undefined ? {} : { createDatabaseSnapshot: async (input: unknown) => {
        const action = BackendTeamControlActionSchema.parse(input)
        if (action.type !== 'create-database-snapshot') throw new Error('database snapshot action is required')
        await createSnapshot(action.reason ?? 'Agent 在数据库变更前创建的工作区备份', action.kind ?? 'data')
      } }),
      ...(restoreSnapshot === undefined ? {} : { restoreDatabaseSnapshot: async (input: unknown) => {
        const action = BackendTeamControlActionSchema.parse(input)
        if (action.type !== 'restore-database-snapshot') throw new Error('database restore action is required')
        await restoreSnapshot(action.snapshotId, action.targetDatabase)
      } }),
    })
    },
  })
  if (migrationReview !== undefined && migrationStore !== undefined && database !== undefined) {
    try {
      let pendingMigration = false
      try {
        pendingMigration = await migrationStore.load() !== undefined
      } catch (error: unknown) {
        // The host performs an inexpensive presence check before starting the
        // database. A malformed record can fail at this first read, so use the
        // same actionable wording as DatabaseMigrationReview and clear only a
        // safe regular file before exposing the blocked state.
        await migrationStore.clear().catch(() => undefined)
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`待审批迁移记录无效，已阻止恢复：${reason.slice(0, 700)}`, { cause: error })
      }
      if (pendingMigration) {
        // Reopen the workspace-local cluster before rebuilding the persisted,
        // hash-bound migration preview. Recovery never applies SQL.
        await database.port.start()
        await migrationReview.restorePending()
      }
    } catch (error: unknown) {
      // Keep the verified host alive so the user can inspect the task and the
      // database failure in the normal DSH surface. Recovery remains blocked;
      // no SQL is applied and the pending record is still guarded by its
      // canonical/hash checks on the next retry.
      try {
        if (host.mode !== 'supported') throw error
        const stateStore = host.activation.composition.stateStore
        const state = await stateStore.load()
        if (state === null || stateStore.transact === undefined) throw error
        const message = formatRecoveryFailure(error)
        await stateStore.transact(state.revision, current => ({ ...current, workflowError: message }))
      } catch (persistError: unknown) {
        await host.dispose().catch(() => undefined)
        throw persistError === error ? error : new AggregateError([error, persistError], '数据库迁移恢复失败，且无法保存诊断状态')
      }
    }
  }
  return host
}

export function formatRecoveryFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `数据库迁移恢复失败，已阻止自动应用：${detail.slice(0, 900)}`
}

async function lastTerminalRunFailure(events: { read(): Promise<readonly unknown[]> }): Promise<{ readonly status: 'blocked' | 'failed'; readonly message: string } | undefined> {
  const entries = await events.read().catch(() => [])
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (typeof entry !== 'object' || entry === null || Reflect.get(entry, 'type') !== 'run-recorded') continue
    const run = Reflect.get(entry, 'run')
    if (typeof run !== 'object' || run === null) continue
    const status = Reflect.get(run, 'status')
    if (status !== 'blocked' && status !== 'failed') continue
    const summary = Reflect.get(run, 'summary')
    return { status, message: typeof summary === 'string' && summary.length > 0 ? summary.slice(0, 1000) : '上次团队执行未完成，请查看技术详情后恢复。' }
  }
  return undefined
}

function hasUserQuestions(context: BackendTeamProductionContext): boolean {
  try {
    const questions = Reflect.get(context, 'userQuestions')
    return questions !== null && typeof questions === 'object' && typeof Reflect.get(questions, 'ask') === 'function'
  } catch {
    return false
  }
}

async function recoveryKey(path: string): Promise<string> {
  let handle
  let created = false
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if (created && handle !== undefined) {
    try { await handle.writeFile(randomBytes(32).toString('hex')); await handle.sync() } finally { await handle.close() }
  }
  const reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await reader.stat(); const current = await lstat(path)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64 || (stat.mode & 0o077) !== 0 || current.isSymbolicLink() || stat.dev !== current.dev || stat.ino !== current.ino) throw new Error('workflow recovery key is unsafe')
    const key = await reader.readFile('utf8')
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('workflow recovery key is invalid')
    return key
  } finally { await reader.close() }
}
