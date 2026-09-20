import { gunzipSync } from 'node:zlib'
import { sha256Canonical } from '@dsh-backend-team/core'
import type { DevelopmentPlan } from '@dsh-backend-team/development'
import { captureFileSnapshot } from '@dsh-backend-team/development/file-snapshot'
import { FinalEvidenceBindingsSchema } from './final-development-verification.js'
import { readTaskEvidenceReview, workspaceBoundaryReport } from './workspace-boundary-evidence.js'

/** Derive evidence routes from the human-approved test plan, never from an Agent's pass claim. */
export async function approvedTestBindings(root: string, plan: DevelopmentPlan, verifyApproval: () => Promise<void>, host?: { taskId: string; refresh: boolean }) {
  await verifyApproval()
  const { byFile, hostIds, typecheckFiles } = await validateApprovedTestPlan(root, plan)
  const tests = []
  for (const [file, evidenceIds] of byFile) {
    const snapshot = await captureFileSnapshot(root, file)
    if (snapshot.state !== 'present' || snapshot.sha256 === undefined) throw new Error(`缺少测试文件：${file}`)
    tests.push({ file, sha256: snapshot.sha256, evidenceIds })
  }
  await verifyApproval()
  const reports = []
  if (hostIds.size) {
    if (host === undefined) throw new Error('宿主工作区边界检查尚未配置。')
    reports.push({ ...await workspaceBoundaryReport(root, host.taskId, plan, host.refresh), evidenceIds: [...hostIds] })
  }
  const review = FinalEvidenceBindingsSchema.pick({ reviewedReports: true, resolutions: true }).extend({ planHash: FinalEvidenceBindingsSchema.shape.planHash.optional() }).parse(host === undefined ? {} : await readTaskEvidenceReview(root, host.taskId))
  if ((review.reviewedReports !== undefined || review.resolutions !== undefined) && review.planHash !== sha256Canonical(plan)) throw new Error('任务审查记录不属于当前执行计划。')
  const reviewedIds = new Set(review.reviewedReports?.flatMap(report => report.evidenceIds) ?? [])
  if ([...reviewedIds].some(id => !hostIds.has(id))) throw new Error('任务审查报告只能补充已批准的宿主证据项。')
  const remainingReports = reports.map(report => ({ ...report, evidenceIds: report.evidenceIds.filter(id => !reviewedIds.has(id)) })).filter(report => report.evidenceIds.length > 0)
  return FinalEvidenceBindingsSchema.parse({ planHash: sha256Canonical(plan), tests, ...(typecheckFiles === undefined ? {} : { typecheckFiles }), reviewedReports: [...remainingReports, ...(review.reviewedReports ?? [])], ...(review.resolutions === undefined ? {} : { resolutions: review.resolutions }) })
}

/** Validate the generated plan before any business writes or test files exist. */
export async function validateApprovedTestPlan(root: string, plan: DevelopmentPlan) {
  const path = plan.artifactReadPaths?.find(path => path.endsWith('/test-plan.md'))
  if (path === undefined) throw new Error('缺少已批准的测试方案。')
  const document = await captureFileSnapshot(root, path)
  if (document.state !== 'present' || document.sha256 !== plan.artifactHashes['test-plan.md']) throw new Error('测试方案已变化，请重新确认设计。')
  const text = gunzipSync(document.compressedBytes).toString('utf8')
  const mappings = new Map<string, { file: string; requirements: string[] }>()
  const hostMappings = new Map<string, string[]>()
  for (const match of text.matchAll(/^\s*<!-- backend-team:host-evidence id=([A-Za-z0-9_-]+) kind=workspace-boundary requirements=(AC-\d+(?:,AC-\d+)*) -->\s*$/gmu)) {
    const id = match[1]!, requirements = match[2]!
    if (hostMappings.has(id)) throw new Error('宿主证据 ID 重复。')
    hostMappings.set(id, requirements.split(','))
  }
  const files = new Set(plan.slices.flatMap(slice => slice.expectedPaths))
  if ([...files].some(file => [...files].some(other => other.startsWith(file + '/')))) throw new Error('开发计划的 files 必须是具体文件，不能包含目录。')
  for (const match of text.matchAll(/^\s*<!-- backend-team:evidence id=([A-Za-z0-9_-]+) file=((?:test|tests)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|mts|cts|ts)) requirements=(AC-\d+(?:,AC-\d+)*) -->\s*$/gmu)) {
    const [, id, file, requirements] = match as unknown as [string, string, string, string]
    if (mappings.has(id) || hostMappings.has(id) || file.split('/').some(part => part === '.' || part === '..' || part === '') || !files.has(file)) throw new Error('测试方案含重复或未列入开发计划的测试映射。')
    mappings.set(id, { file, requirements: requirements.split(',') })
  }
  const markers = [...text.matchAll(/<!--\s*backend-team:typecheck\b[\s\S]*?-->/gu)]
  let typecheckFiles: string[] | undefined
  // Only a parsed HTML comment is an executable declaration.  The test plan
  // may mention the marker in prose (for example, to explain that the gate is
  // disabled); that text must not activate validation or trigger a repair loop.
  if (markers.length > 0) {
    const marker = markers[0]?.[0].match(/^<!-- backend-team:typecheck files=([A-Za-z0-9_./,-]+) -->$/u)
    if (markers.length !== 1 || !marker) throw new Error('类型检查声明无效：只允许一条明确的文件列表。')
    typecheckFiles = marker[1]!.split(',')
    if (typecheckFiles.length > 20 || new Set(typecheckFiles).size !== typecheckFiles.length || typecheckFiles.some(file => !files.has(file) || file.split('/').some(part => !part || part.startsWith('.')) || !/\.(?:ts|mts|cts)$/u.test(file) || /\.d\.(?:ts|mts|cts)$/u.test(file))) throw new Error('类型检查必须绑定计划中的具体 TypeScript 源文件，不能使用目录、重复文件或未声明文件。')
  }
  const byFile = new Map<string, string[]>()
  const hostIds = new Set<string>()
  for (const [requirement, trace] of Object.entries(plan.trace.requirements)) {
    for (const id of trace.evidenceIds) {
      if (hostMappings.get(id)?.includes(requirement)) { hostIds.add(id); continue }
      const mapping = mappings.get(id)
      if (mapping === undefined || !mapping.requirements.includes(requirement)) throw new Error(`验收项 ${requirement} 的 ${id} 未在已批准测试方案中绑定，不能推断通过。`)
      const ids = byFile.get(mapping.file) ?? []
      if (!ids.includes(id)) ids.push(id)
      byFile.set(mapping.file, ids)
    }
  }
  return { byFile, hostIds, ...(typecheckFiles === undefined ? {} : { typecheckFiles }) }
}
