import type { AgentHandle, AgentSpawnRequest } from '@dsh-backend-team/contracts'
export interface VerifiedAgentRuntime { spawn(request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle> }
export class VerifiedAgentRuntimeBinding {
  readonly verifiedProvenance = true as const
  private readonly cancelled = new Set<string>()
  constructor(private readonly runtime: VerifiedAgentRuntime, provenance: { readonly verified: true }) { if (provenance.verified !== true) throw new Error('Agent runtime provenance is not verified') }
  async spawnAgent(request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle> {
    const handle = await this.runtime.spawn(request, signal); return { id: handle.id, result: (resultSignal) => handle.result(resultSignal), cancel: async () => { this.cancelled.add(handle.id); await handle.cancel() } }
  }
  cancelledIds(): readonly string[] { return Object.freeze([...this.cancelled]) }
}
