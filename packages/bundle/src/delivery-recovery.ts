import { checkCredentials } from './credential-check.js'
import { FinalEvidenceBindingsSchema } from './final-development-verification.js'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { DeliveryReviewSchema, FinalVerificationRecordSchema, type FinalVerificationRecord } from '@dsh-backend-team/contracts'
import { sha256Canonical } from '@dsh-backend-team/core'
import { captureFileSnapshot } from '@dsh-backend-team/development/file-snapshot'
import type { DevelopmentPlan } from '@dsh-backend-team/development'

/** Recover only the exact reviewed report for the current plan, inputs and host bindings. */
export async function verifyDeliveryRecord(options: {
  workspaceRoot: string
  record: FinalVerificationRecord
  plan: DevelopmentPlan
  evidenceBindings: unknown
  verifyApproval: () => Promise<void>
}): Promise<void> {
  const record = FinalVerificationRecordSchema.parse(options.record)
  const snapshot = await captureFileSnapshot(options.workspaceRoot, record.delivery.reportPath)
  if (snapshot.state !== 'present' || snapshot.sha256 !== record.reportSha256) throw new Error('验收报告缺失或已变化，请重新验收。')
  const report = z.object({
    delivery: DeliveryReviewSchema,
    planHash: z.string(),
    evidenceBindings: z.unknown().optional(),
    typecheck: z.unknown().optional(),
    files: z.array(z.object({ path: z.string(), sha256: z.string() })),
  }).parse(JSON.parse(gunzipSync(snapshot.compressedBytes).toString('utf8')))
  if (sha256Canonical(report.delivery) !== sha256Canonical(record.delivery) || report.planHash !== sha256Canonical(options.plan) || sha256Canonical(report.evidenceBindings ?? null) !== sha256Canonical(options.evidenceBindings ?? null)) throw new Error('验收对应的计划或配置已变化，请重新验收。')
  const required = new Set([...options.plan.slices.flatMap(slice => slice.expectedPaths), ...options.plan.artifactReadPaths ?? []])
  const outputPaths = new Set(options.plan.slices.flatMap(slice => slice.expectedPaths))
  const outputContents: { path: string; content: string }[] = []
  for (const file of report.files) {
    const current = await captureFileSnapshot(options.workspaceRoot, file.path)
    if (current.sha256 !== file.sha256) throw new Error('验收后的项目文件已变化，请重新验收。')
    if (outputPaths.has(file.path) && current.state === 'present') outputContents.push({ path: file.path, content: gunzipSync(current.compressedBytes).toString('utf8') })
    required.delete(file.path)
  }
  if (required.size > 0) throw new Error('验收报告未覆盖当前项目产物。')
  if (record.delivery.status === 'ready' && checkCredentials(outputContents).status === 'blocked') throw new Error('验收产物的凭据检查未通过，请修复后重新验收。')
  if (options.evidenceBindings !== undefined) {
    const bindings = FinalEvidenceBindingsSchema.parse(options.evidenceBindings)
    if (record.delivery.status === 'ready' && bindings.typecheckFiles !== undefined) {
      const checked = z.object({ exitCode: z.literal(0), files: z.array(z.string()), argv: z.array(z.string()).min(1), scope: z.string().min(1) }).safeParse(report.typecheck)
      if (!checked.success || sha256Canonical(checked.data.files) !== sha256Canonical(bindings.typecheckFiles)) throw new Error('批准的类型检查缺少成功证据，请重新验收。')
    }
    for (const binding of bindings.reviewedReports ?? []) {
      const source = await captureFileSnapshot(options.workspaceRoot, binding.file)
      if (source.state !== 'present' || source.sha256 !== binding.sha256) throw new Error('宿主验收报告已变化。')
      const reviewed = z.object({ files: z.record(z.string(), z.string()) }).parse(JSON.parse(gunzipSync(source.compressedBytes).toString('utf8')))
      for (const [path, hash] of Object.entries(reviewed.files)) {
        if ((await captureFileSnapshot(options.workspaceRoot, path)).sha256 !== hash) throw new Error('宿主验收对应的文件已变化。')
      }
    }
  }
  await options.verifyApproval()
}
