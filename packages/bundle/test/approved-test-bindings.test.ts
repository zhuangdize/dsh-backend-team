import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { DevelopmentPlan } from '@dsh-backend-team/development'
import { approvedTestBindings, validateApprovedTestPlan } from '../src/approved-test-bindings.js'
import { ensureWorkspaceBaseline } from '../src/workspace-boundary-evidence.js'

it('uses only approved evidence mappings and refuses unmapped or changed plans', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'approved-tests-')))
  try {
    await mkdir(join(root, 'specs/task'), { recursive: true })
    await mkdir(join(root, 'test'))
    const document = '<!-- backend-team:evidence id=orders-test file=test/orders.test.mjs requirements=AC-001 -->\nCheck an invalid order is rejected.'
    await writeFile(join(root, 'specs/task/test-plan.md'), document)
    await writeFile(join(root, 'test/orders.test.mjs'), "import 'node:test'")
    const plan: DevelopmentPlan = { requirements: ['AC-001'], tasks: [], slices: [{ id: 'S1', taskIds: [], layers: ['test'], requirementIds: ['AC-001'], inputs: {}, expectedPaths: ['test/orders.test.mjs'], apiOperations: [], dataChanges: [], testEvidence: ['orders-test'], dependencies: [], rollbackBoundary: 'S1', completionConditions: [] }],
      trace: { requirements: { 'AC-001': { sliceIds: ['S1'], taskIds: [], evidenceIds: ['orders-test'] } } }, artifactReadPaths: ['specs/task/test-plan.md'], artifactHashes: { 'test-plan.md': createHash('sha256').update(document).digest('hex') } }
    const approval = vi.fn(async () => undefined)
    expect((await approvedTestBindings(root, plan, approval)).tests).toMatchObject([{ file: 'test/orders.test.mjs', evidenceIds: ['orders-test'] }])
    expect(approval).toHaveBeenCalledTimes(2)
    await expect(validateApprovedTestPlan(root, { ...plan, slices: [{ ...plan.slices[0]!, expectedPaths: ['test', 'test/orders.test.mjs'] }] })).rejects.toThrow('不能包含目录')
    await rm(join(root, 'test/orders.test.mjs'))
    await expect(validateApprovedTestPlan(root, plan)).resolves.toBeDefined()
    await expect(approvedTestBindings(root, plan, approval)).rejects.toThrow('缺少测试文件')
    await expect(approvedTestBindings(root, { ...plan, trace: { requirements: { 'AC-001': { sliceIds: ['S1'], taskIds: [], evidenceIds: ['invented-pass'] } } } }, approval)).rejects.toThrow('未在已批准测试方案中绑定')
    await writeFile(join(root, 'specs/task/test-plan.md'), document + '\nchanged')
    await expect(approvedTestBindings(root, plan, approval)).rejects.toThrow('测试方案已变化')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('ignores a prose mention of the optional typecheck marker', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'approved-typecheck-prose-')))
  try {
    await mkdir(join(root, 'specs/task'), { recursive: true })
    await mkdir(join(root, 'test'))
    const document = '<!-- backend-team:evidence id=orders-test file=test/orders.test.mjs requirements=AC-001 -->\nThe plan does not enable `backend-team:typecheck`; the repository typecheck runs later.'
    await writeFile(join(root, 'specs/task/test-plan.md'), document)
    await writeFile(join(root, 'test/orders.test.mjs'), "import 'node:test'")
    const plan: DevelopmentPlan = { requirements: ['AC-001'], tasks: [], slices: [{ id: 'S1', taskIds: [], layers: ['test'], requirementIds: ['AC-001'], inputs: {}, expectedPaths: ['test/orders.test.mjs'], apiOperations: [], dataChanges: [], testEvidence: ['orders-test'], dependencies: [], rollbackBoundary: 'S1', completionConditions: [] }],
      trace: { requirements: { 'AC-001': { sliceIds: ['S1'], taskIds: [], evidenceIds: ['orders-test'] } } }, artifactReadPaths: ['specs/task/test-plan.md'], artifactHashes: { 'test-plan.md': createHash('sha256').update(document).digest('hex') } }
    await expect(validateApprovedTestPlan(root, plan)).resolves.toBeDefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('binds approved host checks to actual workspace evidence without inventing a test file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'approved-host-')))
  try {
    await mkdir(join(root, '.backend-team'))
    await mkdir(join(root, 'test'))
    await mkdir(join(root, 'specs/task'), { recursive: true })
    await ensureWorkspaceBaseline(root, 'demo', ['test'])
    const document = '<!-- backend-team:host-evidence id=boundary kind=workspace-boundary requirements=AC-001 -->\n<!-- backend-team:evidence id=demo-test file=test/demo.mjs requirements=AC-001 -->'
    await writeFile(join(root, 'specs/task/test-plan.md'), document)
    await writeFile(join(root, 'test/demo.mjs'), 'export const example = true')
    const plan = { requirements: ['AC-001'], tasks: [], slices: [{ expectedPaths: ['test/demo.mjs'] }], trace: { requirements: { 'AC-001': { sliceIds: [], taskIds: [], evidenceIds: ['boundary', 'demo-test'] } } }, artifactReadPaths: ['specs/task/test-plan.md'], artifactHashes: { 'test-plan.md': createHash('sha256').update(document).digest('hex') } } as unknown as DevelopmentPlan
    await expect(approvedTestBindings(root, plan, async () => undefined)).rejects.toThrow('宿主工作区边界检查尚未配置')
    const bindings = await approvedTestBindings(root, plan, async () => undefined, { taskId: 'demo', refresh: true })
    expect(bindings.tests).toMatchObject([{file: 'test/demo.mjs', evidenceIds: ['demo-test']}])
    expect(bindings.reviewedReports).toMatchObject([{ evidenceIds: ['boundary'], file: '.backend-team/task-evidence/demo-boundary.json' }])
    const reviewPath = join(root, '.backend-team/task-evidence/demo-review.json')
    const review = { planHash: bindings.planHash, reviewedReports: [{ file: '.backend-team/review.json', sha256: 'a'.repeat(64), evidenceIds: ['boundary'] }] }
    await writeFile(reviewPath, JSON.stringify(review), { mode: 0o600 })
    expect((await approvedTestBindings(root, plan, async () => undefined, { taskId: 'demo', refresh: false })).reviewedReports).toEqual(review.reviewedReports)
    await writeFile(reviewPath, JSON.stringify({ ...review, planHash: 'b'.repeat(64) }))
    await expect(approvedTestBindings(root, plan, async () => undefined, { taskId: 'demo', refresh: false })).rejects.toThrow('不属于当前执行计划')
    await writeFile(reviewPath, JSON.stringify({ ...review, reviewedReports: [{ ...review.reviewedReports[0], evidenceIds: ['demo-test'] }] }))
    await expect(approvedTestBindings(root, plan, async () => undefined, { taskId: 'demo', refresh: false })).rejects.toThrow('只能补充已批准的宿主证据项')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'darwin').each(['ts', 'mts', 'cts'])('carries approved %s evidence through real final verification and rejects stale evidence', async extension => {
  const { verifyFinalDevelopment } = await import('../src/final-development-verification.js')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'approved-typescript-')))
  try {
    await mkdir(join(root, 'specs/task'), { recursive: true })
    await mkdir(join(root, 'test'))
    const file = `test/typed.test.${extension}`
    const document = `<!-- backend-team:evidence id=typed-test file=${file} requirements=AC-001 -->\nVerify the typed calculation.`
    await writeFile(join(root, 'specs/task/test-plan.md'), document)
    const code = (extension === 'cts' ? "const {test} = require('node:test'); const assert = require('node:assert/strict');" : "import {test} from 'node:test'; import assert from 'node:assert/strict';") + " const value: number = 4; test('calculation', () => assert.equal(value, 4));"
    await writeFile(join(root, file), code)
    const plan = { requirements: ['AC-001'], tasks: [], slices: [{ expectedPaths: [file] }], trace: { requirements: { 'AC-001': { sliceIds: [], taskIds: [], evidenceIds: ['typed-test'] } } }, artifactReadPaths: ['specs/task/test-plan.md'], artifactHashes: { 'test-plan.md': createHash('sha256').update(document).digest('hex') } } as unknown as DevelopmentPlan
    const verifyApproval = vi.fn(async () => undefined)
    const evidenceBindings = await approvedTestBindings(root, plan, verifyApproval)
    expect(evidenceBindings.tests).toMatchObject([{ file, evidenceIds: ['typed-test'] }])
    const result = await verifyFinalDevelopment({ workspaceRoot: root, plan, evidenceBindings, verifyApproval })
    expect(result.status, result.message).toBe('passed')
    expect(result.delivery?.status).toBe('ready')
    expect(result.delivery?.scope).toContain('未验证类型检查')
    await writeFile(join(root, file), code + '\n// new revision')
    expect((await verifyFinalDevelopment({ workspaceRoot: root, plan, evidenceBindings, verifyApproval })).status).toBe('blocked')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'darwin')('enforces the approved scoped typecheck as a final gate and recovers only matching success evidence', async () => {
  const { verifyFinalDevelopment } = await import('../src/final-development-verification.js')
  const { verifyDeliveryRecord } = await import('../src/delivery-recovery.js')
  const { readFile } = await import('node:fs/promises')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'approved-typecheck-gate-')))
  const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
  try {
    await mkdir(join(root, 'specs/task'), { recursive: true })
    await mkdir(join(root, 'test'))
    await mkdir(join(root, 'src'))
    const document = '<!-- backend-team:evidence id=test file=test/app.ts requirements=AC-001 -->\n<!-- backend-team:typecheck files=src/app.ts,test/app.ts -->\nRequired strict scoped check; not full project tsconfig.'
    await writeFile(join(root, 'specs/task/test-plan.md'), document)
    await writeFile(join(root, 'test/app.ts'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('behavior',()=>assert.equal(1,1));")
    await writeFile(join(root, 'src/app.ts'), 'const value: number = "wrong";')
    const plan = { requirements: ['AC-001'], tasks: [], slices: [{ expectedPaths: ['src/app.ts', 'test/app.ts'] }], trace: { requirements: { 'AC-001': { sliceIds: [], taskIds: [], evidenceIds: ['test'] } } }, artifactReadPaths: ['specs/task/test-plan.md'], artifactHashes: { 'test-plan.md': hash(document) } } as unknown as DevelopmentPlan
    const verifyApproval = async () => {}
    const evidenceBindings = await approvedTestBindings(root, plan, verifyApproval)
    expect(evidenceBindings.typecheckFiles).toEqual(['src/app.ts', 'test/app.ts'])
    const runTests = vi.fn(async () => { throw new Error('must not execute after type errors') })
    const failed = await verifyFinalDevelopment({ workspaceRoot: root, plan, evidenceBindings, verifyApproval, runTests })
    expect(failed.status).toBe('blocked')
    expect(runTests).not.toHaveBeenCalled()
    const failedReport = JSON.parse(await readFile(join(root, failed.delivery!.reportPath), 'utf8'))
    expect(failedReport.typecheck.stdout).toContain('TS2322')
    expect(failed.delivery?.status).toBe('needs-attention')
    await writeFile(join(root, 'src/app.ts'), 'const value: number = 42;')
    const passed = await verifyFinalDevelopment({ workspaceRoot: root, plan, evidenceBindings, verifyApproval })
    expect(passed.status, passed.message).toBe('passed')
    expect(passed.delivery?.status).toBe('ready')
    const reportPath = join(root, passed.delivery!.reportPath)
    const content = await readFile(reportPath, 'utf8')
    const record = { delivery: passed.delivery!, reportSha256: hash(content) }
    await expect(verifyDeliveryRecord({ workspaceRoot: root, plan, record, evidenceBindings, verifyApproval })).resolves.toBeUndefined()
    const saved = JSON.parse(content)
    delete saved.typecheck
    const missing = JSON.stringify(saved)
    await writeFile(reportPath, missing)
    await expect(verifyDeliveryRecord({ workspaceRoot: root, plan, record: { ...record, reportSha256: hash(missing) }, evidenceBindings, verifyApproval })).rejects.toThrow('类型检查缺少成功证据')
    for (const marker of ['<!-- backend-team:typecheck files=src/missing.ts -->', '<!-- backend-team:typecheck files=src/app.ts,src/app.ts -->', '<!-- backend-team:typecheck files=src/app.ts -->\n<!-- backend-team:typecheck files=src/app.ts -->', '<!-- backend-team:typecheck files= -->']) {
      const changed = document.replace('<!-- backend-team:typecheck files=src/app.ts,test/app.ts -->', marker)
      await writeFile(join(root, 'specs/task/test-plan.md'), changed)
      await expect(validateApprovedTestPlan(root, { ...plan, artifactHashes: { 'test-plan.md': hash(changed) } })).rejects.toThrow('类型检查')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
