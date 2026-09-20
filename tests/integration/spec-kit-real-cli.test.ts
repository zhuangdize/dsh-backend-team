import { describe, it } from 'vitest'
import { createRealSpecKitGateOptionsFromEnvironment, runRealSpecKitGate } from '../../packages/spec-workflow/src/spec-kit-real-gate.js'

/**
 * This is intentionally a visible blocked gate.  It must never turn fixture
 * output into a claim about the official CLI.  Running it requires two newly
 * issued, exact approval artifacts: runtime-install and spec-kit-init.
 */
describe('official Spec Kit generic CLI integration', () => {
  const required = process.env.DSH_REQUIRE_REAL_SPEC_KIT_GATE === '1'
  if (!required) it.skip('BLOCKED: requires explicit test-only runtime-install and spec-kit-init approval materials before any network download or CLI execution', () => {})
  else it('runs the concrete persistent-workspace gate from strict environment material', async () => {
    try {
      await runRealSpecKitGate(await createRealSpecKitGateOptionsFromEnvironment(process.env))
    } catch (error: unknown) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      throw error
    }
  })
})
