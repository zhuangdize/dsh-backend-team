import { expect, it } from 'vitest'
import { DevelopmentCoordinator, type DevelopmentCheckpoint } from '../src/development-coordinator.js'
import type { DevelopmentPlan } from '../src/vertical-slice.js'

const slice = { id: 'S1', taskIds: [], layers: [], requirementIds: [], inputs: {}, expectedPaths: [], apiOperations: [], dataChanges: [], testEvidence: [], dependencies: [], rollbackBoundary: 'slice', completionConditions: [] }
const plan: DevelopmentPlan = { slices: [slice, { ...slice, id: 'S2', dependencies: ['S1'] }], tasks: [], trace: { requirements: {} }, artifactHashes: {}, requirements: [] }

it('waits for the current slice and checkpoint persistence before acknowledging pause', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const saving = Promise.withResolvers<void>()
  const saved = Promise.withResolvers<void>()
  const executed: string[] = []
  const checkpoints: DevelopmentCheckpoint[] = []
  const coordinator = new DevelopmentCoordinator({
    approvals: { verifyActiveApproval: async () => {} }, patchTracker: { begin: async () => {} }, teamCoordinator: { dispatchExpert: async () => { throw new Error('unused') } },
    saveCheckpoint: async checkpoint => { if (checkpoint.slices.length) { saving.resolve(); await saved.promise } checkpoints.push(checkpoint) },
    sliceExecutor: { execute: async current => { executed.push(current.id); entered.resolve(); await release.promise; return { sliceId: current.id, status: 'passed', attempts: 1, handoffs: [] } } },
  })
  const running = coordinator.execute(plan)
  await entered.promise
  let paused = false
  const pause = coordinator.pause().then(result => { paused = true; return result })
  await expect(coordinator.execute(plan)).rejects.toThrow(/already running/)
  expect(paused).toBe(false)
  release.resolve()
  await saving.promise
  expect(paused).toBe(false)
  expect(executed).toEqual(['S1'])
  saved.resolve()
  await expect(pause).resolves.toMatchObject({ status: 'paused' })
  await expect(running).resolves.toMatchObject({ status: 'paused' })
  expect(checkpoints.at(-1)?.slices.map(item => item.sliceId)).toEqual(['S1'])
  await expect(coordinator.pause()).rejects.toThrow(/not running/)
})

it('fails closed when checkpoint persistence fails, without starting the next slice', async () => {
  const executed: string[] = []
  const coordinator = new DevelopmentCoordinator({
    approvals: { verifyActiveApproval: async () => {} }, patchTracker: { begin: async () => {} }, teamCoordinator: { dispatchExpert: async () => { throw new Error('unused') } },
    saveCheckpoint: async checkpoint => { if (checkpoint.slices.length) throw new Error('disk full') },
    sliceExecutor: { execute: async current => { executed.push(current.id); return { sliceId: current.id, status: 'passed', attempts: 1, handoffs: [] } } },
  })
  await expect(coordinator.execute(plan)).rejects.toThrow('disk full')
  expect(executed).toEqual(['S1'])
})

it('requires a persistent checkpoint sink before accepting a pause request', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const coordinator = new DevelopmentCoordinator({
    approvals: { verifyActiveApproval: async () => {} }, patchTracker: { begin: async () => {} }, teamCoordinator: { dispatchExpert: async () => { throw new Error('unused') } },
    sliceExecutor: { execute: async current => { entered.resolve(); await release.promise; return { sliceId: current.id, status: 'passed', attempts: 1, handoffs: [] } } },
  })
  const running = coordinator.execute(plan)
  await entered.promise
  await expect(coordinator.pause()).rejects.toThrow(/checkpoint/)
  release.resolve()
  await expect(running).resolves.toMatchObject({ status: 'passed' })
})

it('reports completed work as passed when pause arrives during the final slice', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const coordinator = new DevelopmentCoordinator({
    approvals: { verifyActiveApproval: async () => {} }, patchTracker: { begin: async () => {} }, teamCoordinator: { dispatchExpert: async () => { throw new Error('unused') } },
    saveCheckpoint: async () => {},
    sliceExecutor: { execute: async current => { entered.resolve(); await release.promise; return { sliceId: current.id, status: 'passed', attempts: 1, handoffs: [] } } },
  })
  const running = coordinator.execute({ ...plan, slices: [slice] })
  await entered.promise
  const pause = coordinator.pause()
  release.resolve()
  await expect(pause).resolves.toMatchObject({ status: 'passed' })
  await expect(running).resolves.toMatchObject({ status: 'passed' })
})

it('honors a pause arriving during an approval check before the next dispatch', async () => {
  const checking = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let approvals = 0
  let dispatches = 0
  const coordinator = new DevelopmentCoordinator({
    approvals: { verifyActiveApproval: async () => { if (++approvals === 2) { checking.resolve(); await release.promise } } },
    patchTracker: { begin: async () => {} }, teamCoordinator: { dispatchExpert: async () => { throw new Error('unused') } },
    saveCheckpoint: async () => {},
    sliceExecutor: { execute: async current => { dispatches++; return { sliceId: current.id, status: 'passed', attempts: 1, handoffs: [] } } },
  })
  const running = coordinator.execute(plan)
  await checking.promise
  const pause = coordinator.pause()
  release.resolve()
  await expect(pause).resolves.toMatchObject({ status: 'paused', slices: [] })
  await expect(running).resolves.toMatchObject({ status: 'paused' })
  expect(dispatches).toBe(0)
})
