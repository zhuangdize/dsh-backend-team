import { runManagedTypecheck } from './managed-typecheck.js'
import { checkCredentials } from './credential-check.js'
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { sha256Canonical } from '@dsh-backend-team/core'
import type { DevelopmentPlan, DevelopmentRunResult } from '@dsh-backend-team/development'
import { allRequirementsPassed, buildRequirementEvidence, compareResults, type CommandCapture, type ProjectVerificationResult, type ComprehensiveSecurityReport } from '@dsh-backend-team/verification'
import { DeliveryReviewSchema, type DeliveryReview } from '@dsh-backend-team/contracts'
import { captureFileSnapshot, compareFileSnapshot } from '@dsh-backend-team/development/file-snapshot'
import { runManagedNodeTests } from './managed-node-tests.js'
import { workspaceBoundaryExpectedPaths } from './workspace-boundary-evidence.js'

export const FinalEvidenceBindingsSchema = z.object({
  planHash: z.string().regex(/^[a-f0-9]{64}$/u),
  typecheckFiles: z.array(z.string().min(1)).min(1).max(20).optional(),
  tests: z.array(z.object({ file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u), evidenceIds: z.array(z.string().min(1)).min(1) }).strict()).min(1),
  reviewedReports: z.array(z.object({ file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u), evidenceIds: z.array(z.string().min(1)).min(1) }).strict()).optional(),
  resolutions: z.array(z.object({ itemSha256: z.string().regex(/^[a-f0-9]{64}$/u), evidenceIds: z.array(z.string().min(1)).min(1), reason: z.string().min(1) }).strict()).optional(),
}).strict()

/** Rechecks the complete declared Node workload after all slices, without another model call. */
export async function verifyFinalDevelopment(options: {
  readonly workspaceRoot: string
  readonly plan: DevelopmentPlan
  readonly result?: DevelopmentRunResult
  readonly evidenceBindings?: z.infer<typeof FinalEvidenceBindingsSchema>
  readonly verifyApproval: () => Promise<void>
  readonly runTests?: typeof runManagedNodeTests
  /** Optional host-approved project script checks (typecheck/build/lint). */
  readonly projectVerification?: () => Promise<ProjectVerificationResult>
  /** Optional complete security/DB/API evidence supplied by the host. */
  readonly securityVerification?: () => Promise<ComprehensiveSecurityReport>
}): Promise<{ readonly status: 'passed' | 'failed' | 'blocked'; readonly message: string; readonly delivery?: DeliveryReview }> {
  await options.verifyApproval()
  const root = await realpath(options.workspaceRoot)
  const expectedPaths = await workspaceBoundaryExpectedPaths(root, options.plan)
  const paths = [...new Set([...expectedPaths, ...options.plan.artifactReadPaths ?? []])].sort()
  const files = paths.filter(path => /(?:^|\/)(?:test|tests)\/.*\.(?:mjs|cjs|js|mts|cts|ts)$/u.test(path))
  if (files.length === 0) return { status: 'blocked', message: '最终验证未完成：计划中没有可运行的 Node 测试文件。尚未确认项目可交付。' }
  const snapshots = await Promise.all(paths.map(path => captureFileSnapshot(options.workspaceRoot, path)))
  if (snapshots.some(snapshot => snapshot.state !== 'present')) return { status: 'blocked', message: '最终验证未完成：计划要求的产物缺失，请恢复文件后重试。' }
  const parent = join(root, '.backend-team')
  await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new Error('unsafe final verification directory')
  const directory = await mkdtemp(join(parent, 'final-verification-'))
  let status: 'passed' | 'failed' | 'blocked' = 'blocked'
  let reason = ''
  let capture: Awaited<ReturnType<typeof runManagedNodeTests>> | undefined
  let typecheck: (Awaited<ReturnType<typeof runManagedTypecheck>> & { files: readonly string[] }) | undefined
  let projectVerification: ProjectVerificationResult | undefined
  let securityVerification: ComprehensiveSecurityReport | undefined
  const outputPaths = new Set(options.plan.slices.flatMap(slice => slice.expectedPaths))
  const credentialCheck = checkCredentials(snapshots.filter(snapshot => outputPaths.has(snapshot.path) && snapshot.state === 'present').map(snapshot => ({ path: snapshot.path, content: gunzipSync(snapshot.compressedBytes!).toString('utf8') })))
  const startedAt = new Date().toISOString()
  try {
    if (credentialCheck.status === 'blocked') throw new Error('产物凭据检查未通过，请移除硬编码凭据并重新验收：' + credentialCheck.findings.map(finding => `${finding.path}:${finding.line} (${finding.code})`).slice(0, 8).join('、'))
    if (options.projectVerification !== undefined) {
      projectVerification = await options.projectVerification()
      if (projectVerification.report.status !== 'passed') throw new Error(`项目级验证未通过（${projectVerification.report.status}），请查看对应命令证据。`)
    }
    if (options.securityVerification !== undefined) {
      securityVerification = await options.securityVerification()
      if (securityVerification.status !== 'passed') throw new Error('完整安全、数据库或契约验证未通过，请查看安全证据。')
    }
    if (options.evidenceBindings !== undefined) {
      const approved = FinalEvidenceBindingsSchema.parse(options.evidenceBindings)
      if (approved.planHash !== sha256Canonical(options.plan)) throw new Error('类型检查或测试对应的计划已变化，请重新确认。')
      if (approved.typecheckFiles !== undefined) {
        if (approved.typecheckFiles.some(file => !outputPaths.has(file))) throw new Error('类型检查文件不在批准的开发产物内。')
        const checked = await runManagedTypecheck({ workspaceRoot: root, files: approved.typecheckFiles, readPaths: paths, signal: AbortSignal.timeout(120000), maxWallMs: 120000 })
        typecheck = { ...checked, files: approved.typecheckFiles }
        await options.verifyApproval()
        if (checked.exitCode !== 0) throw new Error('批准的文件类型检查未通过，请按报告诊断修复后重新验收。')
      }
    }
    capture = await (options.runTests ?? runManagedNodeTests)({ workspaceRoot: root, files, readPaths: paths, testCli: true, signal: AbortSignal.timeout(120000), maxWallMs: 120000 })
    status = capture.exitCode === 0 ? 'passed' : 'failed'
    await options.verifyApproval()
    for (const snapshot of snapshots) {
      if (!(await compareFileSnapshot(root, snapshot)).unchanged) { status = 'blocked'; reason = '验证期间项目文件发生变化，必须重新检查。'; break }
    }
  } catch (error: unknown) { status = 'blocked'; reason = error instanceof Error ? error.message : '最终验证未能执行' }
  const reportPath = relative(root, join(directory, 'report.json'))
  const scope = (typecheck === undefined ? '' : '已执行批准的文件级类型检查（固定严格配置，不代表项目全量检查）。') + (projectVerification === undefined ? '' : '已执行项目声明的 typecheck/build/lint 脚本并记录命令结果。') + (securityVerification === undefined ? '' : '已执行宿主提供的安全、数据库和契约证据。') + '验证范围：计划内 Node 测试、产物凭据检查及已配置的宿主证据；未验证' + (typecheck === undefined && projectVerification === undefined ? '类型检查、构建、lint' : '') + '部署或外部服务。'
  const captures: CommandCapture[] = []
  if (options.evidenceBindings !== undefined) {
    try {
      const bindings = FinalEvidenceBindingsSchema.parse(options.evidenceBindings)
      if (bindings.planHash !== sha256Canonical(options.plan)) throw new Error('证据对应表的任务计划已变化，需要重新审核。')
      const known = new Set(Object.values(options.plan.trace.requirements).flatMap(item => item.evidenceIds))
      const ids = new Set<string>()
      for (const binding of bindings.tests) {
        if (!files.includes(binding.file) || snapshots.find(item => item.path === binding.file)?.sha256 !== binding.sha256) throw new Error('证据对应表的测试文件已变化或不在本次测试范围内，需要重新审核。')
        for (const id of binding.evidenceIds) { if (!known.has(id) || ids.has(id)) throw new Error('证据对应表包含未知或重复的证据项。'); ids.add(id) }
      }
      if (capture !== undefined) {
        if (/^# (?:skipped|todo) [1-9][0-9]*\s*$/mu.test(capture.stdout)) { status = 'blocked'; reason = '测试存在跳过或待实现的用例，不能确认对应证据通过。' }
        const digest = (text: string) => createHash('sha256').update(text).digest('hex')
        captures.push({ id: [...ids][0]!, argv: capture.argv, cwd: root, purpose: 'unit', evidenceIds: [...ids], startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), exitCode: capture.exitCode, status, stdoutSha256: digest(capture.stdout), stderrSha256: digest(capture.stderr), stdoutExcerpt: capture.stdout.slice(0, 4096), stderrExcerpt: capture.stderr.slice(0, 4096) })
      }
      for (const binding of bindings.reviewedReports ?? []) {
        for (const id of binding.evidenceIds) { if (!known.has(id) || ids.has(id)) throw new Error('宿主报告包含未知或重复的证据项。'); ids.add(id) }
        const snapshot = await captureFileSnapshot(root, binding.file)
        if (snapshot.state !== 'present' || snapshot.sha256 !== binding.sha256) throw new Error('已审核的宿主报告缺失或内容已变化。')
        const content = gunzipSync(snapshot.compressedBytes).toString('utf8')
        const report = z.object({ status: z.literal('passed'), argv: z.array(z.string().min(1)).min(1), startedAt: z.string().datetime(), finishedAt: z.string().datetime(), durationMs: z.number().nonnegative(), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)) }).passthrough().parse(JSON.parse(content))
        if (options.plan.slices.flatMap(slice => slice.expectedPaths).some(path => report.files[path] === undefined)) throw new Error('宿主报告没有绑定全部开发产物。')
        for (const [path, hash] of Object.entries(report.files)) {
          if ((await captureFileSnapshot(root, path)).sha256 !== hash) throw new Error('宿主报告对应的项目文件已变化。')
        }
        // This is explicitly reviewed host evidence, never an Agent-selected
        // JSON file. The protected binding pins both its content and plan.
        captures.push({ id: binding.evidenceIds[0]!, argv: report.argv, cwd: root, purpose: 'unknown', evidenceIds: binding.evidenceIds, startedAt: report.startedAt, finishedAt: report.finishedAt, durationMs: report.durationMs, status: status === 'passed' ? 'passed' : 'blocked', stdoutSha256: snapshot.sha256, stderrSha256: createHash('sha256').update('').digest('hex'), stdoutExcerpt: content.slice(0, 4096), stderrExcerpt: '', reason: `reviewed host report: ${binding.file}` })
      }
    } catch (error: unknown) { captures.length = 0; status = 'blocked'; reason = error instanceof Error ? error.message : '证据对应表无效' }
  }
  const requirementMap = buildRequirementEvidence(options.plan.trace, captures, compareResults([], captures))
  const requirements = Object.values(requirementMap)
  const originalUnresolvedItems = [...new Set(options.result?.slices.flatMap(slice => slice.handoffs.flatMap(handoff => handoff.unresolvedItems)) ?? [])]
  const resolvedItems: { item: string; evidenceIds: readonly string[]; reason: string }[] = []
  const unresolvedItems = originalUnresolvedItems.filter(item => {
    const hash = createHash('sha256').update(item).digest('hex')
    const resolution = options.evidenceBindings?.resolutions?.find(entry => entry.itemSha256 === hash)
    if (status !== 'passed' || resolution === undefined || !resolution.evidenceIds.every(id => captures.some(capture => capture.status === 'passed' && capture.evidenceIds.includes(id)))) return true
    resolvedItems.push({ item, evidenceIds: resolution.evidenceIds, reason: resolution.reason })
    return false
  })
  const delivery = DeliveryReviewSchema.parse({ status: status === 'passed' && allRequirementsPassed(requirementMap) && unresolvedItems.length === 0 ? 'ready' : 'needs-attention', reportPath, testStatus: status, scope, requirements: requirements.map(({ requirementId, status, evidenceIds, missingEvidenceIds }) => ({ requirementId, status, evidenceIds, missingEvidenceIds })), unresolvedItems })
  await writeFile(join(root, reportPath), JSON.stringify({ schemaVersion: 1, status, reason, scope, credentialCheck, typecheck, ...(projectVerification === undefined ? {} : { projectVerification }), ...(securityVerification === undefined ? {} : { securityVerification }), delivery, resolvedItems, evidenceBindings: options.evidenceBindings, captures, checkedAt: new Date().toISOString(), planHash: sha256Canonical(options.plan), files: snapshots.map(snapshot => ({ path: snapshot.path, sha256: snapshot.sha256 })), testFiles: files, capture }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  const outcome = status === 'passed' ? `最终项目测试通过（${files.length} 个测试文件）。` : status === 'failed' ? '最终项目测试失败，请修复后重试。' : '最终验证受阻，请查看报告后重试。'
  return { status, delivery, message: `${outcome}${delivery.status === 'ready' ? '已配置的需求验收通过。' : '需求验收仍有待处理项，请查看交付检查。'}${scope} 报告：${reportPath}` }
}
