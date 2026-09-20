import { spawn } from 'node:child_process'
import { mkdtemp, rm, symlink, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HandoffStore } from '@dsh-backend-team/agent-team'
import { DevelopmentRunController } from '../src/development-run-controller.js'
import { FileDevelopmentCheckpointStore } from '../src/file-development-checkpoint-store.js'
import type { DevelopmentPlan } from '../src/vertical-slice.js'

const slice = { id: 'S1', taskIds: [], layers: [], requirementIds: [], inputs: {}, expectedPaths: ['src/fixture.ts'], apiOperations: [], dataChanges: [], testEvidence: [], dependencies: [], rollbackBoundary: 'slice', completionConditions: [] }
const plan: DevelopmentPlan = { slices: [slice, { ...slice, id: 'S2', dependencies: ['S1'] }], tasks: [], trace: { requirements: {} }, artifactHashes: {}, requirements: [] }

it('persists a paused boundary and resumes it through a newly constructed controller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-controller-'))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let writes = 0
  try {
    const handoffStore = new HandoffStore(root), checkpoints = new FileDevelopmentCheckpointStore(root)
    const options = { loadPlan: async () => plan, checkpoints, handoffStore,
      approvals: { verifyActiveApproval: async () => {} },
      patchTracker: { begin: async () => { if (++writes === 1) { entered.resolve(); await release.promise } } },
      teamCoordinator: { dispatchExpert: async (input: { id: string }) => {
        const id = 'handoff-' + input.id
        handoffStore.write({ id, taskId: input.id, status: 'completed', summary: 'fixture', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [], consumedBudget: { tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0 }, childResultIds: [], parentVerification: { status: 'pending' } }, 'parent')
        return handoffStore.acknowledge(id, 'parent')
      } },
    }
    const first = new DevelopmentRunController(options)
    await first.resume()
    await entered.promise
    await expect(first.resume()).rejects.toThrow('already running')
    await first.pause()
    expect(first.snapshot().status).toBe('pausing')
    release.resolve()
    await first.dispose()
    expect(first.snapshot().status).toBe('paused')
    expect((await checkpoints.load())?.slices.map(s => s.sliceId)).toEqual(['S1'])
    const second = new DevelopmentRunController(options)
    const finished = Promise.withResolvers<void>()
    second.subscribe(() => { if (second.snapshot().status === 'passed') finished.resolve() })
    await second.resume()
    await finished.promise
    expect(writes).toBe(2)
    await second.dispose()
    expect((await checkpoints.load())?.slices).toHaveLength(2)
  } finally { release.resolve(); await rm(root, { recursive: true, force: true }) }
})

it('rejects symlink checkpoint directories and malformed persisted evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-guard-'))
  try {
    await mkdir(join(root, '.backend-team'))
    await symlink(tmpdir(), join(root, '.backend-team/development'))
    await expect(new FileDevelopmentCheckpointStore(root).load()).rejects.toThrow('unsafe')
    await rm(join(root, '.backend-team/development'))
    await mkdir(join(root, '.backend-team/development'))
    await writeFile(join(root, '.backend-team/development/checkpoint.json'), '{}')
    await expect(new FileDevelopmentCheckpointStore(root).load()).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('holds one workspace run lease across loading and execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-controller-lock-'))
  const loading = Promise.withResolvers<void>()
  const releaseLoading = Promise.withResolvers<void>()
  const executing = Promise.withResolvers<void>()
  const releaseExecution = Promise.withResolvers<void>()
  let executions = 0
  try {
    const singleSlicePlan = { ...plan, slices: [plan.slices[0]!] }
    const checkpoints = new FileDevelopmentCheckpointStore(root)
    const options = {
      loadPlan: async () => { loading.resolve(); await releaseLoading.promise; return singleSlicePlan },
      checkpoints,
      approvals: { verifyActiveApproval: async () => {} },
      patchTracker: { begin: async () => {} },
      teamCoordinator: { dispatchExpert: async () => { throw new Error('must not dispatch') } },
      sliceExecutor: { execute: async () => { executions++; executing.resolve(); await releaseExecution.promise; return { sliceId: 'S1', status: 'passed' as const, attempts: 0, handoffs: [] } } },
    }
    const first = new DevelopmentRunController(options)
    const firstReady = first.resume()
    await loading.promise
    const second = new DevelopmentRunController({ ...options, loadPlan: async () => singleSlicePlan })
    await expect(second.resume()).rejects.toThrow(/run lock is busy/)
    expect(second.snapshot().status).toBe('failed')
    expect(executions).toBe(0)
    await second.dispose()
    releaseLoading.resolve()
    await executing.promise
    releaseExecution.resolve()
    await firstReady
    await first.dispose()
    const third = new DevelopmentRunController({ ...options, loadPlan: async () => singleSlicePlan,
      checkpoints: { load: async () => null, save: checkpoint => checkpoints.save(checkpoint), acquireRun: () => checkpoints.acquireRun() } })
    const thirdFinished = Promise.withResolvers<void>()
    third.subscribe(() => { if (third.snapshot().status === 'passed') thirdFinished.resolve() })
    await expect(third.resume()).resolves.toBeUndefined()
    await thirdFinished.promise
    await third.dispose()
    expect(executions).toBe(2)
    expect((await checkpoints.load())?.slices.map(item => item.sliceId)).toEqual(['S1'])
  } finally {
    releaseLoading.resolve()
    releaseExecution.resolve()
    await rm(root, { recursive: true, force: true })
  }
})

it('releases the macOS descriptor lease when the owner process exits', async () => {
  if (process.platform !== 'darwin') return
  const root = await mkdtemp(join(tmpdir(), 'run-controller-process-lock-'))
  const moduleUrl = new URL('../dist/file-development-checkpoint-store.js', import.meta.url).href
  const ownerScript = `import { FileDevelopmentCheckpointStore } from ${JSON.stringify(moduleUrl)}; const release = await new FileDevelopmentCheckpointStore(process.argv[1]).acquireRun(); process.stdout.write('ready\\n'); setInterval(() => {}, 1000); void release`
  const contenderScript = `import { FileDevelopmentCheckpointStore } from ${JSON.stringify(moduleUrl)}; try { const release = await new FileDevelopmentCheckpointStore(process.argv[1]).acquireRun(); await release(); process.exit(2) } catch (error) { process.exit(error instanceof Error && /run lock is busy/u.test(error.message) ? 0 : 3) }`
  const runContender = async (): Promise<number> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', contenderScript, root], { stdio: ['ignore', 'ignore', 'pipe'] })
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 3))
  })
  const owner = spawn(process.execPath, ['--input-type=module', '-e', ownerScript, root], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      owner.once('error', reject)
      owner.stdout.once('data', data => String(data).includes('ready') ? resolve() : reject(new Error('run lock owner did not become ready')))
      owner.once('exit', code => reject(new Error(`run lock owner exited before acquiring: ${code}`)))
    })
    expect(await runContender()).toBe(0)
    owner.kill('SIGKILL')
    await new Promise<void>((resolve, reject) => { owner.once('error', reject); owner.once('exit', () => resolve()) })
    expect(await runContender()).toBe(2)
  } finally {
    if (!owner.killed && owner.exitCode === null) owner.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

it('fails the run if releasing its workspace lease fails', async () => {
  const controller = new DevelopmentRunController({
    loadPlan: async () => ({ ...plan, slices: [] }),
    checkpoints: { load: async () => null, save: async () => {}, acquireRun: async () => async () => { throw new Error('lease close failed') } },
    approvals: { verifyActiveApproval: async () => {} }, patchTracker: { begin: async () => {} }, teamCoordinator: { dispatchExpert: async () => { throw new Error('must not dispatch') } },
  })
  await controller.resume()
  await expect(controller.dispose()).rejects.toThrow('lease close failed')
  expect(controller.snapshot().status).toBe('failed')
})

it('exposes the actual slice failure instead of only reporting an unsuccessful run', async () => {
  const controller = new DevelopmentRunController({ loadPlan: async () => plan, checkpoints: {load: async () => null, save: async () => {}}, approvals: {verifyActiveApproval: async () => {}}, patchTracker: {begin: async () => {}}, teamCoordinator: {dispatchExpert: async () => {throw new Error('permission denied: source scope')} } })
  const finished = Promise.withResolvers<void>()
  controller.subscribe(() => {if(controller.snapshot().status === 'blocked') finished.resolve()})
  await controller.resume(); await finished.promise
  expect(controller.snapshot()).toMatchObject({status: 'blocked', message: 'permission denied: source scope'})
  await controller.dispose()
})

it('runs the durable error-clear hook before an explicit retry', async () => {
  let calls = 0
  const controller = new DevelopmentRunController({
    initialSnapshot: { status: 'blocked', message: 'previous run was blocked' },
    beforeResume: async () => { calls++ },
    loadPlan: async () => ({ ...plan, slices: [] }),
    checkpoints: { load: async () => null, save: async () => {} },
    approvals: { verifyActiveApproval: async () => {} },
    patchTracker: { begin: async () => {} },
    teamCoordinator: { dispatchExpert: async () => { throw new Error('unused') } },
  })
  await controller.resume()
  expect(calls).toBe(1)
  await controller.dispose()
})

it('waits for final verification and exposes its failure instead of slice success', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  let leaseHeld = false
  const controller = new DevelopmentRunController({
    loadPlan: async () => ({ ...plan, slices: [plan.slices[0]!] }),
    checkpoints: { load: async () => null, save: async () => {}, acquireRun: async () => { leaseHeld = true; return async () => { leaseHeld = false } } },
    approvals: { verifyActiveApproval: async () => {} }, patchTracker: { begin: async () => {} },
    teamCoordinator: { dispatchExpert: async () => { throw new Error('must not dispatch') } },
    sliceExecutor: { execute: async () => ({ sliceId: 'S1', status: 'passed', attempts: 0, handoffs: [] }) },
    verifyFinal: async () => { entered.resolve(); await release.promise; expect(leaseHeld).toBe(true); return { status: 'failed', message: 'final test failed' } },
  })
  controller.subscribe(() => { if (controller.snapshot().status === 'failed') finished.resolve() })
  try {
    await controller.resume(); await entered.promise
    expect(controller.snapshot().status).toBe('running')
    release.resolve(); await finished.promise
    expect(controller.snapshot()).toEqual({ status: 'failed', message: 'final test failed' })
  } finally { release.resolve(); await controller.dispose() }
  expect(leaseHeld).toBe(false)
})

it('archives the old plan checkpoint once and prevents reuse after replanning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-change-'))
  try {
    const store = new FileDevelopmentCheckpointStore(root)
    const checkpoint = { planHash: 'a'.repeat(64), slices: [] }
    await store.save(checkpoint)
    const id = '12345678-1234-1234-1234-123456789abc'
    await store.archiveForChange(id)
    expect(await store.load()).toBeNull()
    await store.archiveForChange(id)
    expect(JSON.parse(await readFile(join(root, '.backend-team/development/checkpoint-before-' + id + '.json'), 'utf8'))).toEqual(checkpoint)
    await store.save({ planHash: 'b'.repeat(64), slices: [] })
    await expect(store.archiveForChange(id)).rejects.toThrow('already exists')
    expect((await store.load())?.planHash).toBe('b'.repeat(64))
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('waits for final verification and lease release before returning a safe pause', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let leased = false
  const controller = new DevelopmentRunController({
    loadPlan: async () => ({ ...plan, slices: [] }),
    checkpoints: { load: async () => null, save: async () => {}, acquireRun: async () => { leased = true; return async () => { leased = false } } },
    approvals: { verifyActiveApproval: async () => {} }, patchTracker: { begin: async () => {} },
    teamCoordinator: { dispatchExpert: async () => { throw new Error('unused') } },
    verifyFinal: async () => { entered.resolve(); await release.promise; return { status: 'passed' } },
  })
  await controller.resume(); await entered.promise
  let stopped = false
  const stopping = controller.pauseAndWait().then(() => { stopped = true })
  await Promise.resolve()
  expect(stopped).toBe(false); expect(leased).toBe(true)
  release.resolve(); await stopping
  expect(leased).toBe(false)
  await controller.pauseAndWait()
  await controller.dispose()
})
