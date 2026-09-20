import { z } from 'zod'
const base = { workspaceId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), taskId: z.string().min(1).optional() }
export const BackendTeamControlActionSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('prepare-database-migration') }).strict(),
  z.object({ ...base, type: z.literal('create-database-snapshot'), reason: z.string().trim().min(1).max(1000).optional(), kind: z.enum(['data', 'schema']).optional() }).strict(),
  z.object({ ...base, type: z.literal('restore-database-snapshot'), snapshotId: z.string().regex(/^[0-9TZ-]+-[a-z0-9_]{1,50}-[a-f0-9]{8}$/u), targetDatabase: z.string().regex(/^[a-z0-9_]{1,50}$/u) }).strict(),
  z.object({ ...base, type: z.literal('submit-clarification'), text: z.string().trim().min(1).max(8_000) }).strict(),
  z.object({ ...base, type: z.literal('decide-approval'), approvalId: z.string().min(1), decision: z.enum(['approve', 'reject']), artifactHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  z.object({ ...base, type: z.literal('pause-run') }).strict(), z.object({ ...base, type: z.literal('resume-run') }).strict(), z.object({ ...base, type: z.literal('retry-failed-step'), stepId: z.string().min(1) }).strict(),
  z.object({ ...base, type: z.literal('open-artifact'), artifactId: z.string().min(1) }).strict(), z.object({ ...base, type: z.literal('start-database') }).strict(), z.object({ ...base, type: z.literal('stop-database') }).strict(), z.object({ ...base, type: z.literal('open-database-gui') }).strict(),
])
export type BackendTeamControlAction = z.infer<typeof BackendTeamControlActionSchema>
