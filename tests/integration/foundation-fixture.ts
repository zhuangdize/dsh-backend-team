import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../../packages/bundle/src/index.js'
import { MockHarnessAdapter, type HarnessToolDefinition, type HarnessToolExecution } from '@dsh-backend-team/harness-adapter'

export interface FoundationFixtureOptions {
  readonly harnessVersion: string
  readonly writeProbe?: boolean
}

export interface FoundationBootResult {
  readonly mode: 'read-only'
  readonly requestedHarnessVersion: string
  readonly compatibilityCase: 'untrusted-provenance' | 'unknown'
  readonly registeredTools: readonly string[]
  readonly workspaceWrites: readonly string[]
}

export interface FoundationFixture {
  readonly boot: () => Promise<FoundationBootResult>
}

/**
 * A cross-package fixture that runs registration and official ToolDefinition
 * execution inside a monitored temporary cwd. The production Bundle receives
 * only the official tools service; the cwd monitor catches relative writes.
 * The version is intentionally not passed to the Bundle: the official rc.6
 * Context has no trusted runtime-version field, so production must remain
 * read-only regardless of caller-supplied version strings.
 */
export async function createFoundationFixture(options: FoundationFixtureOptions): Promise<FoundationFixture> {
  if (typeof options.harnessVersion !== 'string' || options.harnessVersion.length === 0) {
    throw new TypeError('harnessVersion must be a non-empty string')
  }

  await mkdir(join(process.cwd(), '.backend-team', 'artifacts'), { recursive: true })
  const workspaceRoot = await mkdtemp(join(process.cwd(), '.backend-team', 'artifacts', 'foundation-fixture-'))
  const compatibilityCase = options.harnessVersion === '0.1.0-rc.5' ? 'untrusted-provenance' : 'unknown'

  return {
    async boot() {
      const previousCwd = process.cwd()
      try {
        process.chdir(workspaceRoot)
        const harness = new MockHarnessAdapter()
        let captured: HarnessToolDefinition | undefined
        const tools = {
          register(definition: unknown) {
            captured = definition as HarnessToolDefinition
            return harness.register(definition)
          },
          guard(guard: unknown) {
            return harness.guard(guard)
          },
        }
        const before = await readdir(workspaceRoot)
        await apply({ tools })
        const snapshot = harness.snapshot()
        if (captured === undefined) throw new Error('Bundle did not register an official diagnostic ToolDefinition')
        const controller = new AbortController()
        const execution: HarnessToolExecution = {
          token: Symbol('foundation-fixture'),
          callId: 'foundation-fixture-call',
          rootCallId: 'foundation-fixture-root',
          name: 'backend_team_status',
          arguments: {},
          signal: controller.signal,
        }
        const report = await captured.execute({}, execution)
        if (typeof report !== 'object' || report === null || Array.isArray(report) || (report as { version?: unknown }).version !== 'unknown') {
          throw new Error('diagnostic ToolDefinition trusted an unverified runtime version')
        }
        if (options.writeProbe === true) await writeFile('foundation-write-probe.txt', 'write-observation-probe\n', { flag: 'wx' })
        const after = await readdir(workspaceRoot)
        const workspaceWrites = after.filter((entry) => !before.includes(entry))
        if (typeof report !== 'object' || report === null || Array.isArray(report) || (report as { mode?: unknown }).mode !== 'read-only') {
          throw new Error('diagnostic ToolDefinition returned a write-enabled or invalid report')
        }
        return {
          mode: 'read-only',
          requestedHarnessVersion: options.harnessVersion,
          compatibilityCase,
          registeredTools: snapshot.tools,
          workspaceWrites,
        }
      } finally {
        process.chdir(previousCwd)
        await rm(workspaceRoot, { recursive: true, force: true })
      }
    },
  }
}
