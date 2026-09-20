# Backend Agent Team Stage 01: Harness Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a loadable, diagnostic-only DeepSeek Harness Bundle with strict contracts, durable state, authoritative adapter-boundary policy enforcement, macOS primitives, and fail-closed Harness compatibility.

**Architecture:** Pure domain code depends only on shared contracts. Node/macOS filesystem and process behavior sits behind adapters, while the Bundle entry contains only DeepSeek Harness registration. The first release can report compatibility and enforce safety but cannot yet alter a user's project.

**Tech Stack:** existing NVM `0.40.3` loader sourced read-only with worktree-local `NVM_DIR`, exact Node.js `24.19.0`/npm `11.17.0`, strict TypeScript 6.0.3, npm workspaces, ESM, Vitest 4.1.11, Zod 4.4.3, tsup 8.5.1, ESLint 10.9.1, execa 10.0.1.

**Spec:** `docs/superpowers/specs/2026-08-25-backend-agent-team-design.md`

## Global Constraints

- Follow every global constraint in `docs/superpowers/plans/2026-08-25-backend-agent-team-master-plan.md`.
- The Stage 01 production Bundle is diagnostic-only: it performs no user-project business-code write, project dependency installation, database start, or Agent spawn.
- Runtime imports from private DeepSeek Harness `src/` paths are forbidden.
- The official rc.6 Context supplies no trusted runtime-version field; production therefore reports an unknown, read-only diagnostic state and registers no write-capable tool.
- Current repository commands source the existing user NVM loader at the redacted path `<existing-user-nvm>/nvm.sh` read-only after setting `NVM_DIR=$PWD/.backend-team/runtime/nvm`, then select exact Node.js `24.19.0`; this does not prove a standalone workspace-local NVM implementation.
- The current setup must not modify the existing loader, shell profiles, or a global NVM alias/default. A distributable product runtime manager/bootstrap is deferred to Stage 05 Task 2 and blocks the first project command.
- Every filesystem path is canonicalized before authorization; symlink escapes are denied.
- Every production subprocess uses `shell: false`, an explicit `cwd`, a filtered environment, and an abort signal. The documented development setup command sources the existing NVM shell function only to install/select the pinned local Node runtime; it is not a shipped runner seam.

---

### Task 1: Bootstrap the repository and shared contracts

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/state.ts`
- Create: `packages/contracts/src/policy.ts`
- Create: `packages/contracts/src/harness.ts`
- Test: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Produces: `BackendTeamStateSchema`, `BackendTeamPhase`, `RunStatus`, `WorkspaceLayout`, `PolicyAction`, `PolicyDecision`, `BackendTeamApplicationTool`, `BackendTeamOrchestrationPort`, `CommandRunner`, `BackendTeamEvent`.
- Consumes: none.

- [x] **Step 1: Historical planning baseline (completed; do not rerun)**

The repository was initialized and the approved design/plans were committed before the current implementation work. This records provenance only: do not run `git init`, recreate a root commit, add a remote, or rewrite history when executing this plan from the current repository.

- [ ] **Step 2: Write the failing contracts test**

```ts
import { describe, expect, it } from 'vitest'
import { BackendTeamStateSchema, PolicyDecisionSchema } from '../src/index.js'

describe('shared contracts', () => {
  it('rejects an illegal persisted phase', () => {
    expect(() => BackendTeamStateSchema.parse({
      schemaVersion: 1,
      revision: 0,
      workspaceRoot: '/tmp/project',
      phase: 'CODING_WITHOUT_APPROVAL',
      runs: [],
      approvals: [],
    })).toThrow()
  })

  it('requires an explicit reason for every policy decision', () => {
    expect(() => PolicyDecisionSchema.parse({ effect: 'deny' })).toThrow()
  })
})
```

- [ ] **Step 3: Select the approved current NVM/Node environment and install exact development dependencies**

For this repository execution, use the already-installed NVM `0.40.3` loader without modifying it. Set `NVM_DIR` to the worktree before sourcing the loader, then install/select exact Node.js `24.19.0` and npm `11.17.0` there. Do not change a shell profile or set `nvm alias default`:

```bash
(
  set -euo pipefail
  export NVM_DIR="$PWD/.backend-team/runtime/nvm"
  : "${EXISTING_NVM_LOADER:?set EXISTING_NVM_LOADER to the approved absolute loader path}"
  case "$EXISTING_NVM_LOADER" in /*) ;; *) echo 'EXISTING_NVM_LOADER must be absolute' >&2; exit 1 ;; esac
  test -f "$EXISTING_NVM_LOADER"
  . "$EXISTING_NVM_LOADER"
  test "$(nvm --version)" = '0.40.3'
  nvm install 24.19.0
  nvm use 24.19.0
  node_realpath="$(realpath "$(command -v node)")"
  npm_realpath="$(realpath "$(command -v npm)")"
  case "$node_realpath" in "$NVM_DIR/versions/node/v24.19.0"/*) ;; *) echo 'selected node is outside the local NVM runtime' >&2; exit 1 ;; esac
  case "$npm_realpath" in "$NVM_DIR/versions/node/v24.19.0"/*) ;; *) echo 'selected npm is outside the local NVM runtime' >&2; exit 1 ;; esac
  test "$(node --version)" = 'v24.19.0'
  test "$(npm --version)" = '11.17.0'
  npm install --global --prefix "$NVM_DIR/versions/node/v24.19.0" npm@11.17.0 --ignore-scripts
  npm install --save-dev --save-exact --ignore-scripts typescript@6.0.3 @types/node@24.13.3 vitest@4.1.11 @vitest/coverage-v8@4.1.11 tsup@8.5.1 eslint@10.9.1 typescript-eslint@8.68.0
  npm install --save-exact --ignore-scripts zod@4.4.3
)
```

Create the root `package.json` with `private: true`, `type: "module"`, workspaces `packages/*`, engine `>=24 <25`, and scripts `build`, `test`, `test:coverage`, `typecheck`, `lint`, and `pack:bundle`.

Expected: `package-lock.json` records exact dependencies; `node --version` is `v24.19.0`; npm is `11.17.0`; Node/npm/npx resolve below `$PWD/.backend-team/runtime/nvm`; `npm ls --all` exits 0; shell profiles and global NVM aliases/defaults are unchanged. Sourcing the approved existing user loader at the redacted path `<existing-user-nvm>/nvm.sh` is an acknowledged host-loader dependency and is not evidence of standalone product bootstrap.

- [ ] **Step 4: Run the test and confirm the contracts are missing**

Run: `npm test -- --run packages/contracts/test/contracts.test.ts`

Expected: FAIL because `../src/index.js` or the exported schemas do not exist.

- [ ] **Step 5: Implement the minimal strict contracts**

Use discriminated unions and `.strict()` Zod objects. The persisted state starts as:

```ts
export const BackendTeamPhaseSchema = z.enum([
  'DISCOVER', 'SPECIFY', 'AWAIT_REQUIREMENTS_APPROVAL', 'DESIGN',
  'AWAIT_DESIGN_APPROVAL', 'PLAN', 'BUILD', 'VERIFY', 'DELIVER',
])

export const ApprovalRecordSchema = z.object({
  kind: z.enum(['requirements', 'design', 'install', 'migration', 'shared-config']),
  artifactHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  approvedAt: z.string().datetime(),
  tokenId: z.string().min(16),
}).strict()

export const BackendTeamStateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  workspaceRoot: z.string().startsWith('/'),
  phase: BackendTeamPhaseSchema,
  runs: z.array(RunRecordSchema),
  approvals: z.array(ApprovalRecordSchema),
}).strict()
```

Define `PolicyDecision` as `{ effect: 'allow' | 'ask' | 'deny'; reason: string; ruleId: string; approvalKind?: ... }`. Define the stable interfaces verbatim from the master plan and export them only through `packages/contracts/src/index.ts`.

- [ ] **Step 6: Verify contracts, types, lint, and package build**

Run:

```bash
npm test -- --run packages/contracts/test/contracts.test.ts
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the contract boundary**

```bash
git add .gitignore package.json package-lock.json tsconfig.base.json vitest.config.ts eslint.config.js packages/contracts
git commit -m "build: establish strict shared contracts"
```

---

### Task 2: Implement content hashing and an atomic revisioned state store

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/content-hash.ts`
- Create: `packages/core/src/state-store.ts`
- Create: `packages/core/src/state-machine.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/content-hash.test.ts`
- Test: `packages/core/test/state-store.test.ts`
- Test: `packages/core/test/state-machine.test.ts`

**Interfaces:**
- Consumes: `BackendTeamState`, `BackendTeamPhase`, and `StateStore` from contracts.
- Produces: `sha256Canonical(value): string`, `FileStateStore`, `assertTransition(from, to): void`, and `StateRevisionConflictError`.

- [ ] **Step 1: Write failing tests for stable hashes, atomic revisions, and illegal transitions**

```ts
it('hashes objects independently of key insertion order', () => {
  expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }))
})

it('rejects a stale writer', async () => {
  await store.create(initialState)
  await store.transact(0, state => ({ ...state, phase: 'SPECIFY' }))
  await expect(store.transact(0, state => state)).rejects.toBeInstanceOf(StateRevisionConflictError)
})

it('forbids skipping both approval gates', () => {
  expect(() => assertTransition('SPECIFY', 'BUILD')).toThrow('illegal phase transition')
})
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- --run packages/core/test`

Expected: FAIL with missing exports.

- [ ] **Step 3: Implement canonical hashing without normalizing user prose**

Recursively sort object keys, preserve array order and exact string bytes, encode with UTF-8 JSON, and hash with Node `createHash('sha256')`. Reject `undefined`, functions, symbols, cycles, `NaN`, and infinities so approval hashes never depend on lossy serialization.

- [ ] **Step 4: Implement compare-and-swap state persistence**

`FileStateStore` writes `.backend-team/state/current.json.tmp-<random>`, calls `FileHandle.sync()`, renames it to `current.json`, then syncs the parent directory. A transaction acquires `current.lock` with `open(..., 'wx', 0o600)`, reads and validates current state, checks `expectedRevision`, writes revision + 1, and removes only the lock it created in `finally`.

The lock file content is exact JSON:

```ts
interface LockOwner {
  pid: number
  nonce: string
  createdAt: string
  workspaceRoot: string
}
```

This task does not remove stale locks automatically; recovery owns that decision later.

- [ ] **Step 5: Implement the explicit phase graph**

```ts
const NEXT: Readonly<Record<BackendTeamPhase, readonly BackendTeamPhase[]>> = {
  DISCOVER: ['SPECIFY'],
  SPECIFY: ['AWAIT_REQUIREMENTS_APPROVAL'],
  AWAIT_REQUIREMENTS_APPROVAL: ['SPECIFY', 'DESIGN'],
  DESIGN: ['AWAIT_DESIGN_APPROVAL'],
  AWAIT_DESIGN_APPROVAL: ['DESIGN', 'PLAN'],
  PLAN: ['BUILD'],
  BUILD: ['VERIFY'],
  VERIFY: ['BUILD', 'DELIVER'],
  DELIVER: [],
}
```

Reject every edge not listed. Returning to an earlier phase is performed through named invalidation operations added in Plan 02, not a generic transition bypass.

- [ ] **Step 6: Run focused and repository checks**

Run:

```bash
npm test -- --run packages/core/test
npm run typecheck
npm run lint
```

Expected: all pass; the stale-writer test proves the file revision remains 1.

- [ ] **Step 7: Commit**

```bash
git add packages/core package-lock.json package.json
git commit -m "feat: add durable revisioned workflow state"
```

---

### Task 3: Build the authoritative policy engine

**Files:**
- Create: `packages/policy-engine/package.json`
- Create: `packages/policy-engine/tsconfig.json`
- Create: `packages/policy-engine/src/canonical-path.ts`
- Create: `packages/policy-engine/src/approval-token.ts`
- Create: `packages/policy-engine/src/rules.ts`
- Create: `packages/policy-engine/src/policy-engine.ts`
- Create: `packages/policy-engine/src/index.ts`
- Test: `packages/policy-engine/test/path-policy.test.ts`
- Test: `packages/policy-engine/test/action-policy.test.ts`
- Test: `packages/policy-engine/test/approval-token.test.ts`

**Interfaces:**
- Consumes: `PolicyAction`, `PolicyContext`, `PolicyDecision`, `WorkspaceLayout`.
- Produces: `DefaultPolicyEngine`, `canonicalizeTargetPath()`, `ApprovalTokenService`, and `PolicyDeniedError`.

- [ ] **Step 1: Write adversarial failing tests**

Test all of these exact cases:

```ts
it.each([
  '../outside.txt',
  '.backend-team/runtime/link-to-outside/secret',
  '/tmp/other-project/file.ts',
])('denies workspace escape: %s', async target => {
  expect((await engine.authorize(writeAction(target), context)).effect).toBe('deny')
})

it.each([
  'postgres://user:pass@prod.example.com/app',
  'postgres://user:pass@10.2.3.4/app',
])('denies non-local database target: %s', async connectionString => {
  expect((await engine.authorize(databaseAction(connectionString), context)).effect).toBe('deny')
})

it('does not treat a hidden tool as harmless', async () => {
  expect((await engine.authorize(shellAction('rm', ['-rf', 'src']), context)).effect).toBe('deny')
})
```

Create the symlink in the test fixture and skip with an explicit platform reason only when the OS denies symlink creation.

- [ ] **Step 2: Run and confirm the policy package is absent**

Run: `npm test -- --run packages/policy-engine/test`

Expected: FAIL with unresolved module.

- [ ] **Step 3: Implement canonical path authorization**

For existing targets, compare `realpath(target)` to `realpath(workspaceRoot)`. For a new target, walk upward to the nearest existing parent, resolve that parent, and append only validated basename segments. Require `relative(root, target)` to be neither absolute nor start with `..`. Deny NUL bytes and ambiguous missing parents.

- [ ] **Step 4: Implement rule order and explicit outcomes**

Rules execute in this order and stop on the first decision:

```text
deny-production-database
deny-non-loopback-service
deny-workspace-escape
deny-system-or-global-install
deny-destructive-git
deny-unowned-delete
require-install-approval
require-migration-approval
require-shared-config-approval
allow-known-read
allow-approved-owned-write
deny-unknown
```

Never run shell text through `sh -c`. A Harness shell tool request is parsed conservatively; quoting, expansion, redirection, pipelines, substitutions, unresolved globs, and multiple commands yield `ask` or `deny`, never automatic `allow`.

- [ ] **Step 5: Implement single-use, scope-bound approval tokens**

An approval token contains a random 256-bit secret known only to the coordinator and a persisted hash record containing `tokenId`, `kind`, `workspaceRoot`, canonical action digest, expiry, and `usedAt`. `consume()` verifies constant-time digest equality, matching workspace/kind/action, unexpired status, and unused status, then marks it used in the same state transaction.

- [ ] **Step 6: Run adversarial tests and coverage**

Run:

```bash
npm test -- --run packages/policy-engine/test
npm run test:coverage -- --run packages/policy-engine/test
npm run typecheck
```

Expected: all tests pass and branch coverage for `rules.ts` is at least 95%.

- [ ] **Step 7: Commit**

```bash
git add packages/policy-engine package.json package-lock.json
git commit -m "feat: enforce workspace and risk policy"
```

---

### Task 4: Implement macOS workspace, download, and process primitives

**Files:**
- Create: `packages/platform-macos/package.json`
- Create: `packages/platform-macos/tsconfig.json`
- Create: `packages/platform-macos/src/workspace-layout.ts`
- Create: `packages/platform-macos/src/artifact-downloader.ts`
- Create: `packages/platform-macos/src/process-supervisor.ts`
- Create: `packages/platform-macos/src/node-command-runner.ts`
- Create: `packages/platform-macos/src/index.ts`
- Test: `packages/platform-macos/test/workspace-layout.test.ts`
- Test: `packages/platform-macos/test/artifact-downloader.test.ts`
- Test: `packages/platform-macos/test/process-supervisor.test.ts`
- Test: `packages/platform-macos/test/node-command-runner.test.ts`

**Interfaces:**
- Consumes: `WorkspaceLayout`, `CommandRequest`, `CommandResult`, `CommandRunner`, `PolicyEngine`.
- Produces: `createWorkspaceLayout(root)` and `NodeCommandRunner`. `ArtifactDownloader` and `ProcessSupervisor` remain internal, unavailable primitives until a concrete policy-engine-owned capability/token adapter is implemented; they are intentionally absent from the public platform package barrel and package subpaths are not exported.

- [ ] **Step 1: Write failing layout and provenance tests**

```ts
it('places every managed directory below .backend-team', () => {
  const layout = createWorkspaceLayout('/work/app')
  for (const path of Object.values(layout).filter(value => typeof value === 'string')) {
    expect(path === '/work/app' || path.startsWith('/work/app/.backend-team/')).toBe(true)
  }
})

it('removes a checksum-mismatched partial download', async () => {
  await expect(downloader.fetch(badManifest)).rejects.toThrow('sha256 mismatch')
  await expect(pathExists(badManifest.destination)).resolves.toBe(false)
})

it('will not stop a reused pid', async () => {
  await expect(supervisor.stop({ ...record, startFingerprint: 'wrong' })).rejects.toThrow('process identity mismatch')
})

```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- --run packages/platform-macos/test`

Expected: FAIL because implementations are missing.

- [ ] **Step 3: Implement workspace creation with restrictive permissions**

Create only required directories, using mode `0o700` for state/runtime/cache/log/lock/handoff and `0o600` for files containing connection metadata. Update `.gitignore` with:

```gitignore
.backend-team/runtime/
.backend-team/cache/
.backend-team/logs/
.backend-team/locks/
.backend-team/state/*.secret.json
.backend-team/**/*.pid.json
```

Do not ignore `specs/` or `.specify/`.

- [ ] **Step 4: Implement verified downloads**

`ArtifactDownloader.fetch()` requires a policy-engine-owned, single-use `ArtifactFetchCapability` bound to the complete URL/host/sha256/size/canonical-destination scope; it accepts only HTTPS, follows at most three redirects, re-authorizes that exact scope before every request, streams to `<destination>.partial`, enforces declared maximum bytes, computes SHA-256 while streaming, fsyncs, then atomically renames. It never executes the artifact and never removes quarantine metadata.

- [ ] **Step 5: Implement supervised processes and the guarded command runner**

Persist this process record before reporting readiness:

```ts
interface ManagedProcessRecord {
  id: string
  pid: number
  executableRealPath: string
  startFingerprint: string
  workspaceRoot: string
  startedAt: string
  purpose: string
}
```

On macOS, derive `startFingerprint` from `ps -o lstart= -p <pid>` plus executable real path. Stop with `SIGTERM`, wait up to five seconds, then use `SIGKILL` only after identity is rechecked. `ProcessSupervisor.start()` requires a policy-engine-owned, single-use capability bound to executable/args/canonical cwd/complete filtered environment/purpose and runs spawn only inside its callback; it requires an explicit AbortSignal and never persists child environment secrets. `NodeCommandRunner` canonicalizes executable/cwd, carries the required `executionFingerprint` into the policy action and single-use approval scope, calls `PolicyEngine.authorize()` immediately before `execa(executable, args, { shell: false, cwd, env, signal })`, and caps captured output. A max-buffer outcome returns bounded text with `outputLimitExceeded: true`; it never silently presents truncated output as complete. Product-level Node runtime selection is not implemented in Stage 01 and is owned by Stage 05 Task 2.

- [ ] **Step 6: Run tests and inspect for global writes**

Run:

```bash
npm test -- --run packages/platform-macos/test
npm run typecheck
find "$PWD" -path '*/.backend-team/*' -print
```

Expected: tests pass; fixtures create managed paths only below their temporary workspace.

- [ ] **Step 7: Commit**

```bash
git add .gitignore packages/platform-macos package.json package-lock.json
git commit -m "feat: add isolated macos runtime primitives"
```

---

### Task 5: Add the Harness compatibility seam and mock adapter

**Files:**
- Create: `packages/harness-adapter/package.json`
- Create: `packages/harness-adapter/tsconfig.json`
- Create: `packages/harness-adapter/tsconfig.test.json`
- Create: `packages/harness-adapter/src/structural-context.ts`
- Create: `packages/harness-adapter/src/compatibility-locator.ts`
- Create: `packages/harness-adapter/src/compatibility.ts`
- Create: `packages/harness-adapter/src/deepseek-harness-adapter.ts`
- Create: `packages/harness-adapter/src/mock-harness-adapter.ts`
- Create: `packages/harness-adapter/src/mock-backend-team-port.ts`
- Create: `packages/harness-adapter/src/index.ts`
- Create: `packages/harness-adapter/scripts/copy-compatibility-json.mjs`
- Create: `packages/harness-adapter/scripts/validate-compatibility-json.mjs`
- Create: `docs/compatibility/deepseek-harness.json`
- Test: `packages/harness-adapter/test/compatibility.test.ts`
- Test: `packages/harness-adapter/test/official-api.test.ts`
- Test: `packages/harness-adapter/test/official-mock.test.ts`
- Test: `packages/harness-adapter/test/mock-backend-team-port.test.ts`
- Test: `packages/harness-adapter/test/official-types.compile.ts`
- Test: `packages/harness-adapter/test/public-surface.test.ts`

**Interfaces:**
- Consumes: the official rc.6 `ctx.tools` surface plus application `BackendTeamOrchestrationPort`, `ApprovalRequest`, `AgentSpawnRequest`, and `BackendTeamEvent` contracts.
- Produces: `HarnessStructuralContext`, `HarnessToolDefinition`, `HarnessMonotonicGuard`, `assessHarnessCompatibility()`, `DeepSeekHarnessAdapter`, `MockHarnessAdapter`, `MockBackendTeamOrchestrationPort`, and `HarnessCapabilityReport`.

- [ ] **Step 1: Write failing compatibility tests**

```ts
it.each([
  ['complete tools service', makeContext()],
  ['missing guard', makeContext({ guard: undefined })],
])('keeps production read-only for %s', async (_label, context) => {
  const adapter = await DeepSeekHarnessAdapter.create(context)
  expect(adapter.getCapabilityReport()).toMatchObject({ version: 'unknown', mode: 'read-only' })
})

it('keeps official tools and application orchestration mocks separate', async () => {
  const tools = new MockHarnessAdapter()
  const dispose = tools.register(diagnosticTool)
  const orchestration = new MockBackendTeamOrchestrationPort({
    approvals: [{ effect: 'approve', reason: 'fixture' }],
  })
  expect(tools.snapshot()).toEqual({ tools: ['backend_team_status'], guards: 0 })
  await expect(orchestration.requestApproval(approvalRequest)).resolves.toMatchObject({ effect: 'approve' })
  dispose()
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- --run packages/harness-adapter/test`

Expected: FAIL with missing adapter modules.

- [ ] **Step 3: Freeze the compatibility evidence format**

Start `docs/compatibility/deepseek-harness.json` with one exact `0.1.0-rc.6` entry in `pending-real-smoke` status. Its only expected host capabilities are `register-tool` and `monotonic-guard`, its Node range is `>=24 <25`, and its verification plan records the future pack/add/dump/Cordis-boot-and-`tools.execute` commands. Parse it with a strict Zod discriminated union. Only Task 7 may promote the entry to `verified` and attach evidence.

- [ ] **Step 4: Implement structural runtime checks**

Do not import Harness runtime packages into the production Bundle. Model only the verified official `ctx.tools.register(ToolDefinition): () => void` and `ctx.tools.guard(ToolGuard): () => void` contracts. Compile a test-only seam against pinned `@deepseek-ai/dsh-tools@0.1.0-rc.6` declarations, preserve method receivers/disposers, and never read fictional runtime, approval, Agent, event, or session properties. Because official Context supplies no trusted runtime-version field, compatibility assessment stays read-only even when the checked-in external matrix entry is verified.

- [ ] **Step 5: Implement real and mock adapters**

`DeepSeekHarnessAdapter` is tools-only and structural: it can register a validated diagnostic `ToolDefinition`, can expose ordinary registration/monotonic-guard methods only behind its fail-closed writable-mode check, and its local report uses runtime version `unknown`. It has no `requestApproval`, `spawnAgent`, or `emit` method. `MockHarnessAdapter` mirrors official `register`/`guard` behavior and disposer lifecycles; `MockBackendTeamOrchestrationPort` separately scripts approvals, Agents, and events for later application tests. Neither mock proves real host support.

- [ ] **Step 6: Verify package isolation**

Run:

```bash
npm test -- --run packages/harness-adapter/test
npm run typecheck --workspace @dsh-backend-team/harness-adapter
npm run build
```

Expected: tests, official-type compile checks, and build pass. Pinned official packages remain test-only development dependencies; the published Bundle must not contain a second Harness runtime.

- [ ] **Step 7: Commit**

```bash
git add packages/harness-adapter docs/compatibility package.json package-lock.json
git commit -m "feat: add fail-closed harness compatibility adapter"
```

---

### Task 6: Package a diagnostic-only DeepSeek Harness Bundle

**Files:**
- Create: `packages/bundle/package.json`
- Create: `packages/bundle/tsconfig.json`
- Create: `packages/bundle/tsconfig.test.json`
- Create: `packages/bundle/tsup.config.ts`
- Create: `packages/bundle/cordis.patch.yml`
- Create: `packages/bundle/README.md`
- Create: `packages/bundle/LICENSES/THIRD_PARTY_NOTICES.md`
- Create: `packages/bundle/src/compatibility-locator.ts`
- Create: `packages/bundle/src/index.ts`
- Create: `packages/bundle/src/diagnostic-plugin.ts`
- Create: `packages/bundle/scripts/compatibility-gate.mjs`
- Create: `packages/bundle/scripts/compatibility-gate.d.mts`
- Create: `packages/bundle/scripts/copy-compatibility-json.mjs`
- Test: `packages/bundle/test/manifest.test.ts`
- Test: `packages/bundle/test/plugin.test.ts`
- Create: `scripts/test-packed-bundle.mjs`

**Interfaces:**
- Consumes: `DeepSeekHarnessAdapter`, `HarnessStructuralContext`, and `HarnessToolDefinition`.
- Produces: npm package `@dsh-backend-team/bundle`; official plugin exports `name`, `inject = ['tools']`, and `apply(ctx)`; one diagnostic tool named `backend_team_status`.

- [ ] **Step 1: Write failing package-shape and mode tests**

```ts
it('declares the official bundle patch manifest', async () => {
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.files).toEqual(expect.arrayContaining(['lib', 'cordis.patch.yml']))
})

it('registers one complete diagnostic and no global guard', async () => {
  const context = makeOfficialToolsContext()
  await apply(context)
  expect(context.registrations.map(tool => tool.name)).toEqual(['backend_team_status'])
  expect(context.guards).toEqual([])
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/bundle/test`

Expected: FAIL because the Bundle package does not exist.

- [ ] **Step 3: Implement the official Bundle manifest**

`packages/bundle/package.json` must contain:

```json
{
  "name": "@dsh-backend-team/bundle",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSES"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` inserts exactly one root row with ID `backend-team` and name `@dsh-backend-team/bundle`. The plugin exports `name = '@dsh-backend-team/bundle'`, `inject = ['tools']`, and `apply(ctx)`.

- [ ] **Step 4: Implement fail-closed plugin activation**

`apply(ctx)` creates the tools-only adapter and registers exactly one closed `backend_team_status` definition through official `ctx.tools.register`. Parameters are an empty object with `additionalProperties: false`; output has a closed schema plus a renderer; `execute(args, execution)` validates empty args and uses the official execution `signal`. Its result remains `version: 'unknown'`, `mode: 'read-only'`, and `evidenceStatus: 'unknown'`. Stage 01 installs no global `ctx.tools.guard`, policy plugin, development/install/database tool, or Agent tool. Missing official tools capability fails explicitly.

- [ ] **Step 5: Build and inspect the tarball**

Run:

```bash
npm run build
npm pack --workspace packages/bundle --json
node scripts/test-packed-bundle.mjs
```

The script opens the generated tarball listing and rejects source maps containing absolute paths, missing `cordis.patch.yml`, missing `lib/index.js`, unexpected `.ts` sources, `.backend-team` data, secrets, or repository docs.

- [ ] **Step 6: Run package tests and full repository checks**

Run:

```bash
npm test -- --run packages/bundle/test
npm run typecheck
npm run lint
npm run build
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/bundle scripts/test-packed-bundle.mjs package.json package-lock.json
git commit -m "feat: package diagnostic harness bundle"
```

---

### Task 7: Prove installation and real Harness activation in a disposable profile

**Files:**
- Create: `tests/integration/foundation-fixture.ts`
- Create: `tests/integration/foundation-flow.test.ts`
- Create: `tests/integration/smoke-runner.test.ts`
- Create: `scripts/dsh-fresh-profile-smoke.mjs`
- Create: `docs/compatibility/0.1.0-rc.6-foundation.md`
- Modify: `docs/compatibility/deepseek-harness.json`

**Interfaces:**
- Consumes: packed Bundle and a pinned public DeepSeek Harness CLI `0.1.0-rc.6` dependency wave available to the isolated compatibility runner.
- Produces: external fresh-Profile compatibility evidence and the Stage 01 completion gate; it does not supply production runtime-version provenance.

- [ ] **Step 1: Write the failing cross-package integration test**

```ts
it('keeps caller-provided provenance diagnostic-only', async () => {
  const fixture = await createFoundationFixture({ harnessVersion: '0.1.0-rc.5' })
  const result = await fixture.boot()
  expect(result.mode).toBe('read-only')
  expect(result.registeredTools).toEqual(['backend_team_status'])
  expect(result.workspaceWrites).toEqual([])
})
```

This fixture supplies an untrusted string to a test helper; the production Bundle never receives it. It proves only diagnostic/read-only behavior when provenance is missing or untrusted, not detection of an unsupported runtime version.

- [ ] **Step 2: Run the test and verify the fixture is missing**

Run: `npm test -- --run tests/integration/foundation-flow.test.ts`

Expected: FAIL with missing fixture helper.

- [ ] **Step 3: Implement the isolated smoke runner**

The runner must:

1. Create a temporary `DSH_HOME`, XDG/npm caches/config, package store, and target workspace under an isolated run root.
2. Run from the explicitly selected current development environment: source the existing NVM `0.40.3` loader read-only with `NVM_DIR` set to the worktree-local `.backend-team/runtime/nvm`, select Node.js `24.19.0`/npm `11.17.0`, and use the reviewed pnpm `11.7.0` entry from the isolated dependency wave. Require the public npm registry and cutoff `2026-08-14T00:00:00.000Z`, disable lifecycle scripts, and verify every `@deepseek-ai/dsh*` manifest is exactly `0.1.0-rc.6`. This is current-environment evidence, not a standalone NVM bootstrap test.
3. Pack the Bundle and run `dsh plugin --profile backend-team-test add <absolute-tgz> --ignore-scripts --store-dir <workspace-local>`.
4. Run `dsh --profile backend-team-test --dump-config` and assert one `backend-team` root row naming `@dsh-backend-team/bundle`.
5. Pack and install a generated test-only observer, boot the real Cordis Profile, wait for `ctx.tools.get('backend_team_status')`, and call official `ctx.tools.execute({ callId, name, arguments, signal })` rather than importing the handler.
6. Require the returned diagnostic to remain `version: 'unknown'`, `mode: 'read-only'`, and `evidenceStatus: 'unknown'`.
7. Stop only the process it started; record that the host NVM loader was sourced read-only, prove Node/npm remained below the worktree-local `NVM_DIR`, and prove shell profiles plus global NVM aliases/defaults were not changed; retain redacted command, tool-result, audit, runtime-provenance, and failure artifacts.

If the pinned Harness executable is unavailable, the test result is `blocked`, not `passed`.

- [ ] **Step 4: Run mock integration, real smoke, and the full suite**

Run:

```bash
npm test -- --run tests/integration/foundation-flow.test.ts
node scripts/dsh-fresh-profile-smoke.mjs
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: every command passes and the smoke log records one Bundle row plus a successful real diagnostic tool call.

- [ ] **Step 5: Record compatibility evidence**

Write `docs/compatibility/0.1.0-rc.6-foundation.md` with the exact split between the existing read-only host NVM loader and worktree-local `NVM_DIR`/Node/npm, plus pnpm/macOS provenance, pinned DSH dependency-wave controls, Bundle tarball hash, commands, exit codes, redacted artifact paths, official `tools.execute` result, npm-audit observation, and known limitations. Promote only the JSON compatibility entry to `verified`, add the canonical UTC timestamp and evidence SHA-256, and require evidence commands to match the verification plan exactly. State explicitly that this evidence neither proves standalone workspace-local NVM bootstrap nor promotes the production Bundle out of its unknown read-only report.

- [ ] **Step 6: Commit the completed foundation stage**

```bash
git add tests/integration scripts/dsh-fresh-profile-smoke.mjs docs/compatibility
git commit -m "test: prove bundle activation on pinned harness"
```

## Stage 01 completion gate

Run:

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm pack --workspace packages/bundle --json
node scripts/dsh-fresh-profile-smoke.mjs
```

Proceed to Stage 02 only when the packed Bundle loads exactly once, official rc.6 `ctx.tools.execute` invokes `backend_team_status`, the external matrix entry is verified, the production diagnostic remains unknown/read-only with no global guard, the current Node/npm executables resolve below the worktree-local `NVM_DIR`, policy adversarial tests pass, and no shell profile/global NVM alias/default or outside-workspace file was changed. This gate acknowledges the read-only host NVM loader and does not claim the future product runtime manager exists. Approval, Agent spawn, events, sessions, credentials, and trusted runtime-version host bindings remain unverified and require fresh official compatibility gates in the stages that need them.
