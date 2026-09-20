import { z } from 'zod'

const NonNegativeInteger = z.number().int().nonnegative()
const PositiveInteger = z.number().int().positive()

/** Immutable ceilings granted to one task; schedulers may only reserve lower remaining amounts. */
export const AgentBudgetSchema = z.object({
  maxTokens: PositiveInteger,
  maxWallMs: PositiveInteger,
  maxToolCalls: PositiveInteger,
  maxRetries: NonNegativeInteger,
  maxChildren: z.number().int().min(0).max(3),
}).strict()
export type AgentBudget = z.infer<typeof AgentBudgetSchema>

/** Monotonic usage reported by an agent result or durable handoff. */
export const ConsumedBudgetSchema = z.object({
  tokens: NonNegativeInteger,
  wallMs: NonNegativeInteger,
  toolCalls: NonNegativeInteger,
  retries: NonNegativeInteger,
  children: NonNegativeInteger,
}).strict()
export type ConsumedBudget = z.infer<typeof ConsumedBudgetSchema>
