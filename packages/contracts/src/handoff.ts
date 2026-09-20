import { z } from 'zod'
import { ConsumedBudgetSchema } from './budget.js'

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'expected a lowercase SHA-256 digest')
const Identifier = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'identifier contains unsupported characters')
const WorkspacePath = z.string().trim().min(1).max(1024).refine(
  (path) => !/[\u0000-\u001F\u007F]/u.test(path) && !path.startsWith('/') && !path.includes('\\') && !/^[A-Za-z]:/u.test(path) && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
  'path must be workspace-relative without traversal',
)

export const ChangedPathSchema = z.object({
  path: WorkspacePath,
  beforeSha256: Sha256.nullable(),
  afterSha256: Sha256.nullable(),
}).strict().superRefine((path, context) => {
  if (path.beforeSha256 === null && path.afterSha256 === null) context.addIssue({ code: 'custom', message: 'a changed path requires a before or after hash' })
})
export type ChangedPath = z.infer<typeof ChangedPathSchema>

export const CommandVerificationSchema = z.object({
  argv: z.array(z.string().trim().min(1).max(1_000)).min(1),
  exitCode: z.number().int(),
}).strict()
export type CommandVerification = z.infer<typeof CommandVerificationSchema>

export const VerificationRecordSchema = z.object({
  status: z.enum(['passed', 'failed', 'blocked']),
  verifiedBy: Identifier,
  verifiedAt: z.string().datetime(),
  records: z.array(z.object({
    instructionId: Identifier,
    outcome: z.enum(['passed', 'failed', 'blocked', 'not-run']),
    evidencePaths: z.array(WorkspacePath),
  }).strict()).min(1),
}).strict()
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>

const ResultStatus = z.enum(['passed', 'failed', 'blocked', 'interrupted'])

export const AgentResultSchema = z.object({
  taskId: Identifier,
  status: ResultStatus,
  summary: z.string().trim().min(1).max(4_000),
  changedPaths: z.array(ChangedPathSchema),
  commands: z.array(CommandVerificationSchema),
  evidencePaths: z.array(WorkspacePath),
  risks: z.array(z.string().trim().min(1).max(1_000)),
  unresolvedItems: z.array(z.string().trim().min(1).max(1_000)),
  consumedBudget: ConsumedBudgetSchema,
  childResultIds: z.array(Identifier),
  verification: VerificationRecordSchema,
}).strict().superRefine((result, context) => {
  if (result.status !== 'passed') return
  if (result.verification.status !== 'passed') context.addIssue({ code: 'custom', path: ['verification', 'status'], message: 'a passed result requires passed verification' })
  if (result.verification.records.some((record) => record.outcome !== 'passed')) context.addIssue({ code: 'custom', path: ['verification', 'records'], message: 'a passed result requires every verification outcome to pass' })
  if (result.commands.some((command) => command.exitCode !== 0)) context.addIssue({ code: 'custom', path: ['commands'], message: 'a passed result requires every command exit code to be zero' })
})
export type AgentResult = z.infer<typeof AgentResultSchema>

export const ParentVerificationSchema = z.object({
  status: z.enum(['pending', 'accepted', 'needs-rework', 'rejected']),
  verifiedBy: Identifier.optional(),
  verifiedAt: z.string().datetime().optional(),
}).strict().superRefine((verification, context) => {
  const complete = verification.status !== 'pending'
  if (complete && (verification.verifiedBy === undefined || verification.verifiedAt === undefined)) context.addIssue({ code: 'custom', message: 'completed parent verification requires verifier and timestamp' })
  if (!complete && (verification.verifiedBy !== undefined || verification.verifiedAt !== undefined)) context.addIssue({ code: 'custom', message: 'pending parent verification cannot include verifier or timestamp' })
})
export type ParentVerification = z.infer<typeof ParentVerificationSchema>

/** Durable child-to-parent packet retained until parent verification is recorded. */
export const AgentHandoffSchema = z.object({
  id: Identifier,
  taskId: Identifier,
  status: z.enum(['completed', 'failed', 'blocked', 'interrupted']),
  summary: z.string().trim().min(1).max(4_000),
  changedPaths: z.array(ChangedPathSchema),
  commands: z.array(CommandVerificationSchema),
  evidencePaths: z.array(WorkspacePath),
  risks: z.array(z.string().trim().min(1).max(1_000)),
  unresolvedItems: z.array(z.string().trim().min(1).max(1_000)),
  consumedBudget: ConsumedBudgetSchema,
  childResultIds: z.array(Identifier),
  parentVerification: ParentVerificationSchema,
}).strict()
export type AgentHandoff = z.infer<typeof AgentHandoffSchema>
