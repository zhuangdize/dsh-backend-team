import { describe, expect, it } from 'vitest'
import { applyClient } from '../src/index.js'
describe('client binding', () => {
  it('registers one surface and disposes it', () => { const registrations: string[] = []; const binding = { verifiedProvenance: true as const, register: (surface: { id: string; dispose: () => void }) => { registrations.push(surface.id); return () => { registrations.pop() } } }; const dispose = applyClient(binding, () => undefined); expect(registrations).toEqual(['backend-team']); dispose(); expect(registrations).toEqual([]) })
  it('runs both removal callbacks only once when disposed repeatedly', () => {
    let removeCalls = 0
    let localDisposeCalls = 0
    const binding = { verifiedProvenance: true as const, register: () => { return () => { removeCalls += 1 } } }
    const dispose = applyClient(binding, () => { localDisposeCalls += 1 })
    dispose()
    dispose()
    expect(removeCalls).toBe(1)
    expect(localDisposeCalls).toBe(1)
  })
})
