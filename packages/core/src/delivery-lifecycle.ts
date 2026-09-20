import { FinalVerificationRecordSchema, type FinalVerificationRecord, type StateStore } from '@dsh-backend-team/contracts'
import { assertTransition } from './state-machine.js'

/** Host-only lifecycle; the caller verifies the report and its workspace inputs. */
export class DeliveryLifecycle {
  constructor(private readonly stateStore: StateStore, private readonly verifyApproval: () => Promise<void>) {}

  async begin(): Promise<void> {
    await this.verifyApproval()
    const state = await this.requireState()
    if (state.phase !== 'BUILD' && state.phase !== 'VERIFY') throw new Error('final verification requires BUILD or VERIFY')
    if (state.phase !== 'VERIFY') assertTransition(state.phase, 'VERIFY')
    await this.stateStore.transact(state.revision, current => {
      const { finalVerification: _previous, ...rest } = current
      void _previous
      return { ...rest, phase: 'VERIFY' }
    })
  }

  async finish(input: FinalVerificationRecord): Promise<void> {
    const record = FinalVerificationRecordSchema.parse(input)
    await this.verifyApproval()
    const state = await this.requireState()
    if (state.phase !== 'VERIFY') throw new Error('final verification is not active')
    const phase = record.delivery.status === 'ready' ? 'DELIVER' : 'VERIFY'
    if (phase !== state.phase) assertTransition(state.phase, phase)
    await this.stateStore.transact(state.revision, current => ({ ...current, phase, finalVerification: record }))
  }

  async invalidate(): Promise<void> {
    const state = await this.requireState()
    if (state.finalVerification === undefined) return
    if (state.phase === 'DELIVER') assertTransition(state.phase, 'VERIFY')
    await this.stateStore.transact(state.revision, current => {
      const { finalVerification: _previous, ...rest } = current
      void _previous
      return { ...rest, phase: current.phase === 'DELIVER' ? 'VERIFY' : current.phase }
    })
  }

  private async requireState() {
    const state = await this.stateStore.load()
    if (state === null) throw new Error('project state is unavailable')
    return state
  }
}
