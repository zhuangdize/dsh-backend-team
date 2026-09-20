import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DevelopmentPlan } from '@dsh-backend-team/development'
import { verifyFinalDevelopment } from '../src/final-development-verification.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'final-verification-')); roots.push(root)
  await mkdir(join(root, 'test'))
  await writeFile(join(root, 'test/app.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('actual final test', () => assert.equal(2 + 2, 4))")
  const plan = { slices: [{ expectedPaths: ['test/app.mjs'] }], tasks: [], requirements: [], artifactHashes: {}, trace: { requirements: {} } } as unknown as DevelopmentPlan
  return { workspaceRoot: root, plan, verifyApproval: async () => {} }
}
async function report(root: string, message: string) { return JSON.parse(await readFile(join(root, message.split('报告：')[1]!), 'utf8')) }
it('runs actual declared tests and saves file-bound evidence', async () => {
  const options = await fixture()
  const result = await verifyFinalDevelopment(options)
  expect(result.status, JSON.stringify(await report(options.workspaceRoot, result.message))).toBe('passed')
  const saved = await report(options.workspaceRoot, result.message)
  expect(saved.capture.exitCode).toBe(0)
  expect(saved.capture.stdout).toContain('# tests 1')
  expect(saved.files[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(saved.scope).toContain('未验证')
})
it('does not promote a failing final test to delivery success', async () => {
  const options = await fixture()
  await writeFile(join(options.workspaceRoot, 'test/app.mjs'), "import { test } from 'node:test'; test('failure', () => { throw new Error('final regression') })")
  const result = await verifyFinalDevelopment(options)
  expect(result.status).toBe('failed')
  expect((await report(options.workspaceRoot, result.message)).capture.exitCode).not.toBe(0)
})
it('blocks missing tests and missing planned outputs', async () => {
  const options = await fixture()
  expect((await verifyFinalDevelopment({ ...options, plan: { ...options.plan, slices: [] } })).status).toBe('blocked')
  await rm(join(options.workspaceRoot, 'test/app.mjs'))
  expect((await verifyFinalDevelopment(options)).status).toBe('blocked')
})
it('rejects file drift and approval revocation after execution', async () => {
  const options = await fixture()
  const success = { argv: [], exitCode: 0, stdout: '', stderr: '' }
  const drift = await verifyFinalDevelopment({ ...options, runTests: async () => { await writeFile(join(options.workspaceRoot, 'test/app.mjs'), '// changed'); return success } })
  expect(drift.status).toBe('blocked')
  let approvals = 0
  const revoked = await verifyFinalDevelopment({ ...options, verifyApproval: async () => { if (++approvals === 2) throw new Error('approval revoked') }, runTests: async () => success })
  expect(revoked.status).toBe('blocked')
  expect((await report(options.workspaceRoot, revoked.message)).reason).toContain('approval revoked')
})
it('keeps requirement acceptance incomplete when only aggregate tests passed', async () => {
  const options = await fixture()
  const plan = { ...options.plan, requirements: ['AC-001'], trace: { requirements: { 'AC-001': { sliceIds: ['S1'], taskIds: ['T1'], evidenceIds: ['unit', 'startup'] } } } }
  const result = await verifyFinalDevelopment({ ...options, plan })
  expect(result.status, JSON.stringify(await report(options.workspaceRoot, result.message))).toBe('passed')
  expect(result.delivery?.status).toBe('needs-attention')
  expect(result.delivery?.requirements).toEqual([{ requirementId: 'AC-001', status: 'not-run', evidenceIds: ['unit', 'startup'], missingEvidenceIds: ['unit', 'startup'] }])
  expect((await report(options.workspaceRoot, result.message)).delivery).toEqual(result.delivery)
})

it('binds reviewed evidence only to the exact plan and executed test bytes', async () => {
  const { sha256Canonical } = await import('@dsh-backend-team/core')
  const { createHash } = await import('node:crypto')
  const options = await fixture()
  const plan = { ...options.plan, requirements: ['AC-001'], trace: { requirements: { 'AC-001': { sliceIds: ['S1'], taskIds: ['T1'], evidenceIds: ['unit', 'startup'] } } } }
  const sha256 = createHash('sha256').update(await readFile(join(options.workspaceRoot, 'test/app.mjs'))).digest('hex')
  const evidenceBindings = { planHash: sha256Canonical(plan), tests: [{ file: 'test/app.mjs', sha256, evidenceIds: ['unit'] }] }
  const result = await verifyFinalDevelopment({ ...options, plan, evidenceBindings })
  expect(result.delivery?.requirements[0]).toMatchObject({ status: 'not-run', missingEvidenceIds: ['startup'] })
  expect((await report(options.workspaceRoot, result.message)).captures[0].argv).toContain('--test')
  const completePlan = { ...plan, trace: { requirements: { 'AC-001': { ...plan.trace.requirements['AC-001'], evidenceIds: ['unit'] } } } }
  const complete = await verifyFinalDevelopment({ ...options, plan: completePlan, evidenceBindings: { ...evidenceBindings, planHash: sha256Canonical(completePlan) } })
  expect(complete.delivery?.requirements[0]?.status).toBe('passed')
  expect(complete.delivery?.status).toBe('ready')
  const stale = await verifyFinalDevelopment({ ...options, plan: completePlan, evidenceBindings })
  expect(stale.status).toBe('blocked')
  expect(stale.delivery?.requirements[0]?.status).toBe('not-run')
  await writeFile(join(options.workspaceRoot, 'test/app.mjs'), (await readFile(join(options.workspaceRoot, 'test/app.mjs'), 'utf8')) + '\n// edited')
  expect((await verifyFinalDevelopment({ ...options, plan, evidenceBindings })).status).toBe('blocked')
})

it('keeps undeclared file contents denied in the real Node CLI test mode', async () => {
  const options = await fixture()
  await writeFile(join(options.workspaceRoot, 'secret.txt'), 'not an allowed test input')
  await writeFile(join(options.workspaceRoot, 'test/app.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('undeclared read denied',()=>assert.throws(()=>readFileSync(new URL('../secret.txt',import.meta.url)),e=>['EACCES','EPERM','ERR_ACCESS_DENIED'].includes(e.code)))")
  const result = await verifyFinalDevelopment(options)
  expect(result.status, JSON.stringify(await report(options.workspaceRoot, result.message))).toBe('passed')
})

it('imports only pinned host reports for unchanged outputs and rejects tampering', async () => {
  const { sha256Canonical } = await import('@dsh-backend-team/core')
  const { createHash } = await import('node:crypto')
  const options = await fixture()
  const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
  const plan = { ...options.plan, requirements: ['AC-001'], trace: { requirements: { 'AC-001': { sliceIds: ['S1'], taskIds: ['T1'], evidenceIds: ['unit', 'startup'] } } } }
  const fileHash = hash(await readFile(join(options.workspaceRoot, 'test/app.mjs')))
  const fixtureReport = JSON.stringify({ status:'passed', argv:['fixture-host-check'], startedAt:'2026-09-08T00:00:00.000Z',finishedAt:'2026-09-08T00:00:01.000Z',durationMs:1000,files:{'test/app.mjs':fileHash} })
  await writeFile(join(options.workspaceRoot,'host-report.json'),fixtureReport)
  const evidenceBindings={planHash:sha256Canonical(plan),tests:[{file:'test/app.mjs',sha256:fileHash,evidenceIds:['unit']}],reviewedReports:[{file:'host-report.json',sha256:hash(fixtureReport),evidenceIds:['startup']}]}
  expect((await verifyFinalDevelopment({...options,plan,evidenceBindings})).delivery?.status).toBe('ready')
  await writeFile(join(options.workspaceRoot,'host-report.json'),fixtureReport+' ')
  const tampered=await verifyFinalDevelopment({...options,plan,evidenceBindings})
  expect(tampered.status).toBe('blocked')
  expect(tampered.delivery?.requirements[0]?.missingEvidenceIds).toEqual(['unit','startup'])
})

it('resolves exact reviewed items only while their bound evidence passes', async () => {
  const { sha256Canonical } = await import('@dsh-backend-team/core')
  const { createHash } = await import('node:crypto')
  const options = await fixture()
  const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
  const plan = {...options.plan,requirements:['AC-1'],trace:{requirements:{'AC-1':{sliceIds:['S1'],taskIds:['T1'],evidenceIds:['unit']}}}}
  const result = {slices:[{handoffs:[{unresolvedItems:['run final tests','still needs deployment']}]}]} as unknown as import('@dsh-backend-team/development').DevelopmentRunResult
  const evidenceBindings={planHash:sha256Canonical(plan),tests:[{file:'test/app.mjs',sha256:hash(await readFile(join(options.workspaceRoot,'test/app.mjs'))),evidenceIds:['unit']}],resolutions:[{itemSha256:hash('run final tests'),evidenceIds:['unit'],reason:'Actual final test command passed'}]}
  const accepted = await verifyFinalDevelopment({...options,plan,result,evidenceBindings})
  expect(accepted.delivery?.unresolvedItems).toEqual(['still needs deployment'])
  expect((await report(options.workspaceRoot,accepted.message)).resolvedItems).toHaveLength(1)
  const invalid = await verifyFinalDevelopment({...options,plan,result,evidenceBindings:{...evidenceBindings,planHash:'a'.repeat(64)}})
  expect(invalid.delivery?.unresolvedItems).toEqual(['run final tests','still needs deployment'])
})

it('blocks credentials before executing tests and saves only locations, then passes after repair', async () => {
  const options = await fixture()
  const secret = 'sample-credential-for-regression'
  const testPath = join(options.workspaceRoot, 'test/app.mjs')
  const original = await readFile(testPath, 'utf8')
  await writeFile(testPath, original + `\nconst apiKey = '${secret}';`)
  let called = false
  const result = await verifyFinalDevelopment({ ...options, runTests: async () => { called = true; throw new Error('must not run') } })
  expect(result.status).toBe('blocked')
  expect(called).toBe(false)
  const saved = await report(options.workspaceRoot, result.message)
  expect(saved.credentialCheck).toMatchObject({ status: 'blocked', findings: [{ path: 'test/app.mjs' }] })
  expect(JSON.stringify(saved)).not.toContain(secret)
  expect(result.message).not.toContain(secret)
  await writeFile(testPath, original)
  const repaired = await verifyFinalDevelopment(options)
  expect(repaired.status).toBe('passed')
  expect((await report(options.workspaceRoot, repaired.message)).credentialCheck.status).toBe('passed')
})

it('persists a blocked credential report for review without restoring it as a successful delivery', async () => {
  const { verifyDeliveryRecord } = await import('../src/delivery-recovery.js')
  const { createHash } = await import('node:crypto')
  const options = await fixture()
  await writeFile(join(options.workspaceRoot, 'test/app.mjs'), "const secret = 'synthetic-review-credential';")
  const result = await verifyFinalDevelopment(options)
  expect(result.delivery?.status).toBe('needs-attention')
  const bytes = await readFile(join(options.workspaceRoot, result.delivery!.reportPath))
  await expect(verifyDeliveryRecord({ ...options, record: { delivery: result.delivery!, reportSha256: createHash('sha256').update(bytes).digest('hex') }, evidenceBindings: undefined })).resolves.toBeUndefined()
})
