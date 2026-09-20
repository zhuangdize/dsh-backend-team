import { describe, expect, it } from 'vitest'
import { buildContextPacket } from '../src/context-packet.js'

describe('just-in-time expert context packets', () => {
  it('contains the bounded prompt, artifact evidence, ownership, policy, and budget', () => {
    const packet = buildContextPacket({
      objective: 'Build an order API',
      prompt: { id: 'speckit.specify', sourceRealPath: '/workspace/commands/speckit.specify.md', sourceSha256: 'a'.repeat(64), prompt: 'official prompt' },
      artifactHashes: { 'spec.md': 'b'.repeat(64) },
      requiredOutputSchema: ['spec.md', 'clarification.md'],
      pathOwnership: ['spec.md', 'clarification.md'],
      policySummary: 'No business-code writes; only owned feature artifacts.',
      budget: { maxAgents: 1, maxSteps: 12 },
    })

    expect(packet).toMatchObject({ objective: 'Build an order API', prompt: { id: 'speckit.specify', sourceSha256: 'a'.repeat(64) }, artifactHashes: { 'spec.md': 'b'.repeat(64) }, requiredOutputSchema: ['spec.md', 'clarification.md'], pathOwnership: ['spec.md', 'clarification.md'], policySummary: expect.any(String), budget: { maxAgents: 1, maxSteps: 12 } })
    expect(packet).not.toHaveProperty('conversation')
    expect(packet).not.toHaveProperty('credentials')
    expect(packet).not.toHaveProperty('rawConversation')
  })

  it('rejects malformed prompt evidence and unbounded ownership', () => {
    expect(() => buildContextPacket({
      objective: 'Build an API',
      prompt: { id: 'speckit.specify', sourceRealPath: '/workspace/commands/prompt.md', sourceSha256: 'invalid', prompt: 'prompt' },
      artifactHashes: {}, requiredOutputSchema: ['spec.md'], pathOwnership: ['../src/index.ts'], policySummary: 'safe', budget: { maxAgents: 1, maxSteps: 1 },
    })).toThrow(/prompt|hash|ownership/i)
  })
})
