import { z } from 'zod'

import {
  ApprovalKindSchema,
  BackendTeamPhaseSchema,
  type ApprovalKind,
} from './state.js'

const TargetPathSchema = z.string().min(1)

export const WorkspaceLayoutSchema = z.object({
  root: z.string().min(1),
  teamDir: z.string().min(1),
  stateDir: z.string().min(1),
  runtimeDir: z.string().min(1),
  cacheDir: z.string().min(1),
  logsDir: z.string().min(1),
  locksDir: z.string().min(1),
  handoffDir: z.string().min(1),
}).strict()

export const PolicyActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), targetPath: TargetPathSchema }).strict(),
  z.object({ kind: z.literal('write'), targetPath: TargetPathSchema }).strict(),
  z.object({ kind: z.literal('delete'), targetPath: TargetPathSchema }).strict(),
  z.object({
    kind: z.literal('install'),
    packages: z.array(z.string().min(1)).min(1),
  }).strict(),
  z.object({ kind: z.literal('migration'), targetPath: TargetPathSchema }).strict(),
  z.object({
    kind: z.literal('shared-config'),
    targetPath: TargetPathSchema,
  }).strict(),
  z.object({
    kind: z.literal('database'),
    connectionString: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('command'),
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
    env: z.record(z.string(), z.string()),
    executionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
])

export const PolicyDecisionSchema = z.object({
  effect: z.enum(['allow', 'ask', 'deny']),
  reason: z.string().min(1),
  ruleId: z.string().min(1),
  approvalKind: ApprovalKindSchema.optional(),
  canonicalTargetPath: z.string().min(1).optional(),
}).strict()

export const PolicyContextSchema = z.object({
  workspace: WorkspaceLayoutSchema,
  phase: BackendTeamPhaseSchema,
}).strict()

export type PolicyAction = z.infer<typeof PolicyActionSchema>
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>
export type PolicyApprovalKind = ApprovalKind
export type PolicyContext = z.infer<typeof PolicyContextSchema>
export type WorkspaceLayout = z.infer<typeof WorkspaceLayoutSchema>

export interface PolicyEngine {
  authorize(action: PolicyAction, context: PolicyContext): Promise<PolicyDecision>
}
