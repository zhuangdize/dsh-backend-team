import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sha256Canonical } from '@dsh-backend-team/core'
import type { DevelopmentPlan } from '@dsh-backend-team/development'
import type { FinalVerificationRecord } from '@dsh-backend-team/contracts'
import { verifyDeliveryRecord } from '../src/delivery-recovery.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-recovery-')); roots.push(root)
  await mkdir(join(root, '.backend-team'))
  await writeFile(join(root, 'output.mjs'), '// verified output')
  const plan = { slices: [{ expectedPaths: ['output.mjs'] }] } as unknown as DevelopmentPlan
  const delivery: FinalVerificationRecord['delivery'] = { status: 'ready', reportPath: '.backend-team/report.json', testStatus: 'passed', scope: 'fixture', requirements: [{ requirementId: 'AC-1', status: 'passed', evidenceIds: ['one'], missingEvidenceIds: [] }], unresolvedItems: [] }
  const content = JSON.stringify({ delivery, planHash: sha256Canonical(plan), files: [{ path: 'output.mjs', sha256: hash('// verified output') }] })
  await writeFile(join(root, delivery.reportPath), content)
  return { workspaceRoot: root, plan, record: { delivery, reportSha256: hash(content) }, evidenceBindings: undefined, verifyApproval: async () => {} }
}
it('accepts intact saved evidence and rejects changed output after restart', async () => {
  const options = await fixture()
  await expect(verifyDeliveryRecord(options)).resolves.toBeUndefined()
  await writeFile(join(options.workspaceRoot, 'output.mjs'), '// changed')
  await expect(verifyDeliveryRecord(options)).rejects.toThrow('项目文件已变化')
})
it('rejects report tampering, changed plans, changed bindings and revoked approval', async () => {
  const options = await fixture()
  await expect(verifyDeliveryRecord({ ...options, plan: { ...options.plan, slices: [] } })).rejects.toThrow('计划或配置')
  await expect(verifyDeliveryRecord({ ...options, evidenceBindings: { changed: true } })).rejects.toThrow('计划或配置')
  await expect(verifyDeliveryRecord({ ...options, verifyApproval: async () => { throw new Error('stale approval') } })).rejects.toThrow('stale approval')
  await writeFile(join(options.workspaceRoot, options.record.delivery.reportPath), '{}')
  await expect(verifyDeliveryRecord(options)).rejects.toThrow('报告缺失或已变化')
})
it('rechecks host report inputs beyond the development plan', async () => {
  const options = await fixture()
  const root = options.workspaceRoot
  await writeFile(join(root, 'package.json'), '{}')
  const hostContent = JSON.stringify({ files: { 'package.json': hash('{}') } })
  await writeFile(join(root, '.backend-team/host.json'), hostContent)
  const evidenceBindings = { planHash: sha256Canonical(options.plan), tests: [{ file: 'output.mjs', sha256: hash('// verified output'), evidenceIds: ['one'] }], reviewedReports: [{ file: '.backend-team/host.json', sha256: hash(hostContent), evidenceIds: ['host'] }] }
  const reportPath = join(root, options.record.delivery.reportPath)
  const content = JSON.stringify({ ...JSON.parse(await readFile(reportPath, 'utf8')), evidenceBindings })
  await writeFile(reportPath, content)
  const bound = { ...options, evidenceBindings, record: { ...options.record, reportSha256: hash(content) } }
  await expect(verifyDeliveryRecord(bound)).resolves.toBeUndefined()
  await writeFile(join(root, 'package.json'), '{"changed":true}')
  await expect(verifyDeliveryRecord(bound)).rejects.toThrow('宿主验收对应的文件已变化')
})

it('rechecks credentials even for intact historical reports without a scan record', async () => {
  const options = await fixture()
  const content = "const apiKey = 'historical-test-credential';"
  await writeFile(join(options.workspaceRoot, 'output.mjs'), content)
  const path = join(options.workspaceRoot, options.record.delivery.reportPath)
  const updated = JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), files: [{ path: 'output.mjs', sha256: hash(content) }] })
  await writeFile(path, updated)
  await expect(verifyDeliveryRecord({ ...options, record: { ...options.record, reportSha256: hash(updated) } })).rejects.toThrow('凭据检查')
})
