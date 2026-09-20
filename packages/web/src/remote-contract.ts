import { z } from 'zod'
export const AuthenticatedLocalSessionSchema = z.object({ sessionId: z.string().min(16), workspaceId: z.string().min(1), loopback: z.literal(true), readOnly: z.boolean().default(false) }).strict()
export type AuthenticatedLocalSession = z.infer<typeof AuthenticatedLocalSessionSchema>
