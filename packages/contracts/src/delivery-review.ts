import { z } from 'zod'

/** Test execution and requirement acceptance are separate facts. */
export const DeliveryReviewSchema = z.object({
  status: z.enum(['ready', 'needs-attention']),
  reportPath: z.string().min(1),
  testStatus: z.enum(['passed', 'failed', 'blocked']),
  scope: z.string().min(1),
  requirements: z.array(z.object({
    requirementId: z.string().min(1),
    status: z.enum(['passed', 'failed', 'blocked', 'not-run']),
    evidenceIds: z.array(z.string().min(1)),
    missingEvidenceIds: z.array(z.string().min(1)),
  }).strict()),
  unresolvedItems: z.array(z.string().min(1)),
}).strict().superRefine((review, context) => {
  if (review.status === 'ready' && (review.testStatus !== 'passed' || review.requirements.length === 0 || review.requirements.some(item => item.status !== 'passed' || item.missingEvidenceIds.length > 0) || review.unresolvedItems.length > 0)) {
    context.addIssue({ code: 'custom', message: 'delivery readiness requires complete requirement evidence and no unresolved items' })
  }
})
export type DeliveryReview = z.infer<typeof DeliveryReviewSchema>

export const FinalVerificationRecordSchema = z.object({ delivery: DeliveryReviewSchema, reportSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export type FinalVerificationRecord = z.infer<typeof FinalVerificationRecordSchema>
