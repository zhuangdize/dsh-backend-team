import { z } from 'zod'
import { FinalVerificationRecordSchema } from './delivery-review.js'
import { ConsumedBudgetSchema } from './budget.js'

export const BackendTeamPhaseSchema = z.enum([
  'DISCOVER',
  'SPECIFY',
  'AWAIT_REQUIREMENTS_APPROVAL',
  'DESIGN',
  'AWAIT_DESIGN_APPROVAL',
  'PLAN',
  'BUILD',
  'VERIFY',
  'DELIVER',
])

export const RunStatusSchema = z.enum([
  'running',
  'passed',
  'failed',
  'blocked',
  'interrupted',
])

export const ApprovalKindSchema = z.enum([
  'requirements',
  'design',
  'install',
  'migration',
  'shared-config',
])

const CanonicalTimestampSchema = z.string().datetime().refine(
  (value) => {
    const date = new Date(value)
    return Number.isFinite(date.valueOf()) && date.toISOString() === value
  },
  'timestamp must be canonical UTC RFC3339',
)

export const ApprovalProvenanceSchema = z.object({
  sessionId: z.string().min(16),
  taskId: z.string().uuid().optional(),
}).strict()

export const RunRecordSchema = z.object({
  id: z.string().min(1),
  status: RunStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  summary: z.string().min(1).nullable(),
  consumedBudget: ConsumedBudgetSchema.optional(),
}).strict()

export const ApprovalRecordSchema = z.object({
  kind: ApprovalKindSchema,
  artifactHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  approvedAt: z.string().datetime(),
  tokenId: z.string().min(16),
  provenance: ApprovalProvenanceSchema.optional(),
}).strict()

export const ApprovalTokenRecordSchema = z.object({
  tokenId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  kind: ApprovalKindSchema,
  workspaceRoot: z.string().startsWith('/'),
  secretDigest: z.string().regex(/^[a-f0-9]{64}$/),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: CanonicalTimestampSchema,
  usedAt: CanonicalTimestampSchema.nullable(),
}).strict()

export const BackendTeamStateSchema = z.object({
  requirementChanges: z.array(z.object({
    id: z.string().uuid(), text: z.string().min(1).max(8000), requestedAt: z.string().datetime(), requestedBy: z.string().min(16),
    fromPhase: BackendTeamPhaseSchema, status: z.enum(['preparing', 'awaiting-review']),
    previousDocuments: z.array(z.object({ path: z.string(), content: z.string().max(262144) }).strict()).max(10),
    previousApprovals: z.array(ApprovalRecordSchema), previousRuns: z.array(RunRecordSchema), previousFinalVerification: FinalVerificationRecordSchema.optional(),
  }).strict()).optional(),
  workflowError: z.string().max(1000).optional(),
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  workspaceRoot: z.string().startsWith('/'),
  phase: BackendTeamPhaseSchema,
  finalVerification: FinalVerificationRecordSchema.optional(),
  runs: z.array(RunRecordSchema),
  approvals: z.array(ApprovalRecordSchema),
  approvalTokens: z.array(ApprovalTokenRecordSchema).default([]),
}).strict()

export const BackendTeamEventSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    type: z.literal('phase-changed'),
    revision: z.number().int().nonnegative(),
    phase: BackendTeamPhaseSchema,
  }).strict(),
  z.object({
    id: z.string().min(1),
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    type: z.literal('run-recorded'),
    revision: z.number().int().nonnegative(),
    run: RunRecordSchema,
  }).strict(),
  z.object({
    id: z.string().min(1),
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    type: z.literal('approval-recorded'),
    revision: z.number().int().nonnegative(),
    approval: ApprovalRecordSchema,
  }).strict(),
])

export type BackendTeamPhase = z.infer<typeof BackendTeamPhaseSchema>
export type RunStatus = z.infer<typeof RunStatusSchema>
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>
export type RunRecord = z.infer<typeof RunRecordSchema>
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>
export type ApprovalTokenRecord = z.infer<typeof ApprovalTokenRecordSchema>
export type BackendTeamState = z.infer<typeof BackendTeamStateSchema>
export type BackendTeamEvent = z.infer<typeof BackendTeamEventSchema>
