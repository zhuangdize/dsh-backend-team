import type { JsonObject } from '@dsh-backend-team/contracts'

export interface ContextPrompt {
  readonly id: string
  readonly prompt: string
  readonly sourceRealPath: string
  readonly sourceSha256: string
}
export interface ContextPacketInput {
  readonly objective: string
  readonly prompt: ContextPrompt
  readonly artifactHashes: Readonly<Record<string, string>>
  readonly requiredOutputSchema: readonly string[]
  readonly pathOwnership: readonly string[]
  readonly policySummary: string
  readonly budget: Readonly<{ maxAgents: number; maxSteps: number }>
}
export interface ContextPacket extends JsonObject {
  readonly objective: string
  readonly prompt: JsonObject
  readonly artifactHashes: JsonObject
  readonly requiredOutputSchema: string[]
  readonly pathOwnership: string[]
  readonly policySummary: string
  readonly budget: JsonObject
}

/** Builds a bounded JIT packet; raw conversations, credentials, and repository context have no input field. */
export function buildContextPacket(input: ContextPacketInput): ContextPacket {
  if (input.objective.trim().length === 0 || input.policySummary.trim().length === 0) throw new Error('context packet objective and policy summary are required')
  if (!/^[a-f0-9]{64}$/u.test(input.prompt.sourceSha256) || input.prompt.sourceRealPath.length === 0 || input.prompt.id.length === 0 || input.prompt.prompt.length === 0) throw new Error('context packet prompt evidence is invalid')
  if (!Number.isSafeInteger(input.budget.maxAgents) || input.budget.maxAgents < 1 || !Number.isSafeInteger(input.budget.maxSteps) || input.budget.maxSteps < 1) throw new Error('context packet budget is invalid')
  if (input.pathOwnership.length === 0 || input.pathOwnership.some((path) => !safeFeaturePath(path))) throw new Error('context packet ownership must be feature-relative')
  for (const [path, hash] of Object.entries(input.artifactHashes)) if (!safeFeaturePath(path) || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error('context packet artifact evidence is invalid')
  const packet = {
    objective: input.objective,
    prompt: { id: input.prompt.id, sourceRealPath: input.prompt.sourceRealPath, sourceSha256: input.prompt.sourceSha256, prompt: input.prompt.prompt },
    artifactHashes: { ...input.artifactHashes },
    requiredOutputSchema: [...input.requiredOutputSchema],
    pathOwnership: [...input.pathOwnership],
    policySummary: input.policySummary,
    budget: { maxAgents: input.budget.maxAgents, maxSteps: input.budget.maxSteps },
  }
  return Object.freeze(packet) as ContextPacket
}

function safeFeaturePath(path: string): boolean { return path.length > 0 && !path.startsWith('/') && !path.includes('\0') && !path.includes('\\') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') }
