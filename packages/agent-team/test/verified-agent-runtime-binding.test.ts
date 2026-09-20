import { describe, expect, it } from 'vitest'
import { VerifiedAgentRuntimeBinding } from '../src/index.js'
import type { AgentHandle } from '@dsh-backend-team/contracts'

describe('VerifiedAgentRuntimeBinding', () => {
  it('cancels the real handle and records its id', async () => { let cancelled = false; const handle: AgentHandle = { id: 'agent-1', result: async () => 'ok', cancel: async () => { cancelled = true } }; const binding = new VerifiedAgentRuntimeBinding({ spawn: async () => handle }, { verified: true }); const result = await binding.spawnAgent({} as never); await result.cancel(); expect(cancelled).toBe(true); expect(binding.cancelledIds()).toContain('agent-1') })
  it('does not accept unverified provenance', () => { expect(() => new VerifiedAgentRuntimeBinding({ spawn: async () => ({}) as AgentHandle }, { verified: false as true })).toThrow(/provenance/i) })
})
