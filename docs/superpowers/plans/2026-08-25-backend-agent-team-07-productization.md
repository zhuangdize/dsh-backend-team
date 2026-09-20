# Backend Agent Team Stage 07: Productization and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a non-technical DeepSeek Harness control panel and a signed, diagnosable, upgradeable macOS Bundle that installs into a fresh Profile and proves the approved workflow end to end.

**Architecture:** Task 2 owns the sole production `BackendTeamOrchestrationPort`, composing application-persisted events, control-mediated approval, and an Agent spawn/result/cancel/usage binding only after exact public official API/provenance evidence. A host-side projection service turns those persisted events into a read-only view model and exposes a narrow authenticated control API whose mutations always return to the coordinator. A browser client may register one control-panel surface only through a public DeepSeek Harness client seam proven by the same fresh gate; Stage 01 did not verify client, session, event, remote, approval, or Agent APIs. The existing root Bundle remains the only Profile row and must not bundle a second Harness runtime. Release tooling packs one canonical `.tgz`, installs it into isolated Profiles, verifies licenses/SBOM/runtime manifests, and runs the ten acceptance scenarios in the real Web UI with Codex Chrome.

**Tech Stack:** DeepSeek Harness `0.1.0-rc.6` verified Bundle/tools foundation plus a client/host surface that remains blocked until this stage records fresh official evidence, TypeScript, React only if supplied by the proven client platform, Zod, Vitest, npm pack, CycloneDX npm, macOS arm64/x64, Codex Chrome.

**Spec:** `docs/superpowers/specs/2026-08-25-backend-agent-team-design.md`

## Global Constraints

- Follow the master plan and Stages 01–06; do not bypass their compatibility, approval, policy, runtime, or verification gates.
- The client UI is a projection and command surface, not a second state machine. Persisted core state remains authoritative.
- The client cannot launch processes, write files, spawn Agents, approve its own actions, or access database credentials directly.
- The installed Profile contains exactly one Backend Team root row. Reinstall and upgrade are idempotent and duplicate row IDs are release failures.
- React, Harness client services, and Harness UI packages are host-provided peer/external dependencies; the tarball must not contain duplicate physical runtimes.
- The control API and DbGate remain authenticated and loopback-only. A non-loopback Harness configuration forces read-only diagnostics.
- `.backend-team/` project data is never packaged and is preserved by uninstall unless the user separately requests deletion.
- Publishing to a public package registry is outside V1 until registry ownership and signing credentials are explicitly configured; the signed `.tgz` is the canonical release artifact.
- Browser acceptance testing must use Codex Chrome against the real DeepSeek Harness Web UI. Component tests alone cannot release the Bundle.
- Stage 01 compatibility proves only pinned Profile install/boot and official tool execution. It provides no trusted runtime-version Context field and no approval, Agent, event, session, client, remote, or secret-facility binding. This stage must record fresh official API/provenance evidence before implementing each real host binding; mocks never satisfy that gate.
- Release and E2E commands must provision NVM `0.40.3` and the selected exact Node version under each temporary target workspace. No Team command may use runner/system/Homebrew/MacPorts/`~/.nvm` Node/npm/npx, modify a shell profile, or set a global NVM alias/default.

---

### Task 1: Project persisted events into a stable control-panel view model

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/src/view-model.ts`
- Create: `packages/web/src/event-projector.ts`
- Create: `packages/web/src/control-actions.ts`
- Create: `packages/web/src/index.ts`
- Test: `packages/web/test/event-projector.test.ts`
- Test: `packages/web/test/control-actions.test.ts`

**Interfaces:**
- Consumes: `BackendTeamEvent`, `BackendTeamState`, `BackendTeamPhase`, approval records, Agent records, database status, verification evidence, usage budgets.
- Produces: `BackendTeamViewState`, `BackendTeamControlAction`, `BackendTeamViewProjector`.

- [ ] **Step 1: Write failing projection and command-schema tests**

```ts
it('projects duplicate and out-of-order events idempotently', () => {
  const result = projector.replay([event2, event1, event2])
  expect(result.lastSequence).toBe(2)
  expect(result.appliedEventIds).toEqual([event1.id, event2.id])
})

it('does not define an action that can approve on behalf of the user', () => {
  expect(BackendTeamControlActionSchema.safeParse({ type: 'force-approve' }).success).toBe(false)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/web/test/event-projector.test.ts packages/web/test/control-actions.test.ts`

Expected: FAIL because the view model and projector do not exist.

- [ ] **Step 3: Define the stable view model**

Create a versioned Zod schema with these user-facing sections:

```ts
interface BackendTeamViewState {
  schemaVersion: 1
  workspaceName: string
  phase: BackendTeamPhase
  compatibility: { mode: 'supported' | 'read-only'; reason?: string }
  pendingApproval?: { id: string; kind: 'requirements' | 'design' | 'install' | 'migration' | 'shared-config'; summary: string; artifactHash: string }
  experts: readonly { id: string; role: string; status: RunStatus; taskSummary: string; childCount: number }[]
  risk: { level: 'normal' | 'attention' | 'blocked'; messages: readonly string[] }
  database: { runtime: 'not-installed' | 'stopped' | 'starting' | 'ready' | 'failed'; engine: string; guiAvailable: boolean }
  verification: { total: number; passed: number; failed: number; blocked: number; reportPath?: string }
  usage: { activeExperts: number; activeWorkers: number; concurrentWriters: number; remainingTaskBudget: number }
  lastSequence: number
}
```

Never include prompts, secrets, connection passwords, DbGate session URLs, raw environment values, full source diffs, or unrestricted filesystem paths.

- [ ] **Step 4: Implement deterministic event projection**

Require strictly positive persisted event sequences, deduplicate by event ID, sort recovery input by sequence, reject conflicting events with the same sequence, and fall back to a full state snapshot when the projection schema changes. Every emitted view contains the state revision used to produce it so the UI can reject stale commands.

- [ ] **Step 5: Define the only client-issued actions**

Allow `submit-clarification`, `decide-approval`, `pause-run`, `resume-run`, `retry-failed-step`, `open-artifact`, `start-database`, `stop-database`, and `open-database-gui`. Approval decisions carry the displayed artifact hash and state revision. Installation and migration actions may request an approval flow but never carry reusable approval tokens.

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- --run packages/web/test/event-projector.test.ts packages/web/test/control-actions.test.ts
npm run typecheck
git add packages/web package.json package-lock.json
git commit -m "feat: project backend team control state"
```

---

### Task 2: Prove and implement the production orchestration boundary

**Files:**
- Create: `packages/core/src/persisted-event-port.ts`
- Create: `packages/core/src/control-mediated-approval-port.ts`
- Create: `packages/core/src/production-orchestration-port.ts`
- Create: `packages/agent-team/src/verified-agent-runtime-binding.ts`
- Create: `packages/harness-adapter/src/stage07-host-capabilities.ts`
- Create: `packages/web/src/host-plugin.ts`
- Create: `packages/web/src/control-service.ts`
- Create: `packages/web/src/coordinator-control-port.ts`
- Create: `packages/web/src/subscription-hub.ts`
- Create: `packages/web/src/remote-contract.ts`
- Test: `packages/core/test/production-orchestration-port.test.ts`
- Test: `packages/agent-team/test/verified-agent-runtime-binding.test.ts`
- Test: `packages/web/test/control-service.test.ts`
- Test: `packages/web/test/host-plugin.test.ts`
- Test: `packages/web/test/subscription-hub.test.ts`

**Interfaces:**
- Consumes: application `BackendTeamOrchestrationPort`, `StateStore`, `BackendTeamViewProjector`, verified persisted-event storage, control-mediated approval, and exact public host/client/session/model/Agent seams only after the fresh official API/provenance fixtures pass.
- Produces: the sole production `BackendTeamOrchestrationPort`, durable event projection input, coordinator-mediated approval, verified Agent spawn/result/cancel/usage accounting, `CoordinatorControlPort.dispatch(action, context)`, `BackendTeamControlService.getState()/dispatch()/subscribe()`, and host plugin `apply()`.

- [ ] **Step 1: Write failing production-boundary tests**

```ts
it('rejects mocks as a production orchestration implementation', () => {
  expect(() => createProductionOrchestrationPort({ orchestration: new MockBackendTeamOrchestrationPort() }))
    .toThrow(/production orchestration/i)
})

it('persists events before they become visible to subscribers', async () => {
  await orchestration.emit(event)
  expect(await persistedEvents.read(event.workspaceId)).toContainEqual(event)
  expect(projector.lastSequence()).toBe(event.sequence)
})

it('routes an approval decision to the coordinator without mutating state directly', async () => {
  await service.dispatch(session, approvalDecision)
  expect(coordinator.handleUserAction).toHaveBeenCalledWith(approvalDecision)
  expect(stateStore.transact).not.toHaveBeenCalled()
})

it('rejects a command from a stale browser projection', async () => {
  await expect(service.dispatch(session, { ...action, expectedRevision: 4 }))
    .rejects.toMatchObject({ code: 'STALE_VIEW', currentRevision: 5 })
})

it('cancels the real Agent handle and records bounded usage', async () => {
  const handle = await orchestration.spawnAgent(request)
  await handle.cancel()
  expect(agentBinding.cancelledIds()).toContain(handle.id)
  expect(await usageStore.forAgent(handle.id)).toMatchObject({ status: 'cancelled' })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/core/test/production-orchestration-port.test.ts packages/agent-team/test/verified-agent-runtime-binding.test.ts packages/web/test/control-service.test.ts packages/web/test/host-plugin.test.ts packages/web/test/subscription-hub.test.ts`

Expected: FAIL with the production orchestration, durable event, Agent runtime, and host/control boundaries missing.

- [ ] **Step 3: Prove every external seam before implementation**

Inspect pinned public official declarations/source and run disposable Profile fixtures for the exact host/client/session and model/Agent capabilities needed by Tasks 2–4. The generated fixture is authoritative for package names, exports, entry paths, declaration shapes, registration/disposal, spawn/result/cancel behavior, and usage fields; record exact package versions, source paths, compile evidence, real invocation, and redacted logs in a separate Stage 07 compatibility artifact. Do not name or implement an official method before this evidence exists, do not probe private modules, and do not add fictional capabilities to the Stage 01 tools matrix.

Approval and persisted events may use the internal production implementations below and need not pretend to be Harness APIs. Any binding to a real Harness/model/Agent facility still requires exact public API and provenance evidence. A mock, caller-provided version string, component test, or Stage 01 tools smoke never satisfies this gate. If any required host/client/session or Agent spawn/result/cancel/usage seam is absent or incompatible, stop: keep only `backend_team_status`, and hard-block Task 4, browser E2E, and release.

- [ ] **Step 4: Implement durable events and control-mediated approval**

Persist each `BackendTeamEvent` through an application-owned append-only port before projecting or publishing it. Enforce event ID/sequence uniqueness, workspace binding, atomic recovery, bounded subscriber delivery, and redaction. Implement `requestApproval()` with the local authenticated control service: create a pending approval record, display its kind/hash/revision, and resolve only a matching explicit user decision routed back through the coordinator. The production port never self-approves, consumes a stale decision, or exposes reusable approval tokens. These are independent production implementations, not evidence of official Harness event/approval APIs.

- [ ] **Step 5: Implement the verified Agent binding and composite production port**

Implement `spawnAgent()` only against the exact public model/Agent contract captured by Step 3. Map application requests without widening capabilities; return an `AgentHandle` whose result and cancel operations preserve real host identity. Persist lifecycle, cancellation, task-budget, token/usage, timeout, and terminal-result accounting before the coordinator accepts a handoff. Build the sole production `BackendTeamOrchestrationPort` from this Agent binding, the control-mediated approval implementation, and the persisted event port. Reject mock or partial implementations at production composition time.

- [ ] **Step 6: Implement host-neutral authentication and origin checks**

Define an injected authenticated-local-session port without assuming a DeepSeek Harness Context method. Validate the server's actual bound address as loopback, not a client-supplied Host header. Cross-workspace IDs, unknown actions, malformed Zod payloads, stale revisions, and missing/untrusted compatibility provenance are rejected before coordinator dispatch. Read-only diagnostics expose `getState()` but disable `dispatch()`. A Harness-backed session implementation is added only after Step 3 proves its exact public contract and provenance.

Define the boundary the Bundle must implement:

```ts
interface CoordinatorControlPort {
  dispatch(action: BackendTeamControlAction, context: {
    workspaceId: string
    expectedRevision: number
    authenticatedSessionId: string
  }): Promise<
    | { accepted: true; stateRevision: number }
    | { accepted: true; stateRevision: number; navigation: { kind: 'one-time-local-url'; url: string; expiresAt: string } }
  >
}
```

Only `open-database-gui` may return `navigation`. The control service verifies the URL is loopback, marks it no-store/redacted, and never publishes it through subscriptions, state, logs, events, Agent context, or approval artifacts.

- [ ] **Step 7: Implement coordinator-only mutation routing**

Map every valid client action to one typed coordinator command. `decide-approval` revalidates pending approval ID, kind, artifact hash, and revision; the coordinator alone mints or consumes any internal approval token. `open-artifact` resolves an allowlisted spec/report ID through the policy engine instead of accepting a client path.

- [ ] **Step 8: Implement bounded subscriptions and recovery**

Publish view snapshots with monotonically increasing sequence and state revision. Keep at most one pending snapshot per subscriber, close idle subscriptions, redact logs, and require a fresh `getState()` after reconnect or sequence gap. A slow/disconnected browser cannot block coordinator persistence.

- [ ] **Step 9: Run tests and commit**

```bash
npm test -- --run packages/core/test/production-orchestration-port.test.ts packages/agent-team/test/verified-agent-runtime-binding.test.ts packages/web/test/control-service.test.ts packages/web/test/host-plugin.test.ts packages/web/test/subscription-hub.test.ts
npm run typecheck
git add packages/core packages/agent-team packages/harness-adapter packages/web docs/compatibility
git commit -m "feat: bind production backend team orchestration"
```

---

### Task 3: Build the non-technical Harness client panel

**Files:**
- Create: `packages/web/src/client.tsx`
- Create: `packages/web/src/client-context.ts`
- Create: `packages/web/src/components/BackendTeamPanel.tsx`
- Create: `packages/web/src/components/PhaseStepper.tsx`
- Create: `packages/web/src/components/ApprovalCard.tsx`
- Create: `packages/web/src/components/ExpertList.tsx`
- Create: `packages/web/src/components/DatabaseCard.tsx`
- Create: `packages/web/src/components/VerificationCard.tsx`
- Create: `packages/web/src/components/RiskBanner.tsx`
- Create: `packages/web/src/components/RecoveryCard.tsx`
- Create: `packages/web/src/styles.css`
- Test: `packages/web/test/client-registration.test.ts`
- Test: `packages/web/test/backend-team-panel.test.tsx`
- Test: `packages/web/test/approval-card.test.tsx`
- Test: `packages/web/test/accessibility.test.tsx`

**Interfaces:**
- Consumes: `BackendTeamViewState`, `BackendTeamControlAction`, and only the exact client projection/command services established by the successful Task 2 official compatibility gate; `slots`/`remote` names are not assumed before that evidence exists.
- Produces: one client surface through the freshly verified binding, a minimized launcher, and the Backend Team side panel.

- [ ] **Step 1: Write failing behavior and accessibility tests**

```tsx
it('requires the user to inspect the current artifact before approving', async () => {
  render(<ApprovalCard approval={approval} dispatch={dispatch} />)
  expect(screen.getByRole('button', { name: '确认并继续' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '查看方案' }))
  expect(screen.getByRole('button', { name: '确认并继续' })).toBeEnabled()
})

it('registers exactly one proven client surface and removes it on dispose', () => {
  const dispose = applyClient(verifiedClientBinding)
  expect(verifiedClientBinding.registrations()).toHaveLength(1)
  dispose()
  expect(verifiedClientBinding.registrations()).toHaveLength(0)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/web/test/client-registration.test.ts packages/web/test/backend-team-panel.test.tsx packages/web/test/approval-card.test.tsx packages/web/test/accessibility.test.tsx`

Expected: FAIL with missing client and components.

- [ ] **Step 3: Implement the single-surface information hierarchy**

The collapsed control shows phase, blocking state, and one primary action. The expanded side panel orders content as: current step and plain-language explanation; required user decision; active experts and assigned work; database/runtime status; verification evidence; risks/recovery. Technical identifiers and logs stay behind a secondary “诊断详情” disclosure.

- [ ] **Step 4: Implement explicit confirmation and failure UX**

Requirements/design approval displays artifact title, revision, hash suffix, changed-since-last-view marker, “查看” action, “返回修改”, and “确认并继续”. Install/migration dialogs name the exact runtime or migration and impact. Missing/untrusted Harness provenance, budget exhaustion, dirty-worktree conflict, database failure, and interrupted run each receive a specific recovery action; no generic “出错了” response is permitted.

- [ ] **Step 5: Implement accessible, host-compatible UI**

Use semantic buttons/headings/status regions, visible keyboard focus, focus trapping/restoration for the panel, Escape close, reduced-motion support, screen-reader announcements for phase changes, and color-independent status labels. Use Harness design tokens when present and conservative local fallbacks otherwise. Do not import a bundled React runtime or reset host-global CSS.

- [ ] **Step 6: Register through the freshly verified client seam**

Export the client plugin from `packages/web/src/client.tsx`; inject only the exact services and use only the registration/disposal contract recorded by Task 2 evidence. Do not invent service or slot names in advance. Dispose the subscription and client registration together. A missing proven client capability blocks the panel, leaves `backend_team_status` available, and produces no client crash.

- [ ] **Step 7: Run component checks and commit**

```bash
npm test -- --run packages/web/test
npm run typecheck
npm run lint
git add packages/web
git commit -m "feat: add non-technical backend team panel"
```

---

### Task 4: Integrate the host and client into one idempotent Bundle

**Files:**
- Modify: `packages/bundle/package.json`
- Modify: `packages/bundle/tsup.config.ts`
- Modify: `packages/bundle/cordis.patch.yml`
- Modify: `packages/bundle/src/index.ts`
- Create: `packages/bundle/src/backend-team-plugin.ts`
- Create: `packages/bundle/src/coordinator-control-adapter.ts`
- Create: `packages/bundle/test/client-manifest.test.ts`
- Create: `packages/bundle/test/full-plugin.test.ts`
- Modify: `scripts/test-packed-bundle.mjs`

**Interfaces:**
- Consumes: the complete verified Task 2 fixture, production `BackendTeamOrchestrationPort`, host/control plugin, client entry, coordinator, and all Stage 01–06 application services.
- Produces: one `@dsh-backend-team/bundle` package whose host/client declarations, exports, entry filenames, and packed paths exactly match the verified fixture, with one Bundle patch row.

- [ ] **Step 1: Write failing manifest and duplicate-runtime tests**

```ts
it('declares one host row and the browser client entry', async () => {
  expect(bundlePatch.rows.filter(row => row.id === 'backend-team')).toHaveLength(1)
  expect(extractPackageContract(pkg)).toEqual(verifiedHostBindingFixture.packageContract)
  expect(await listPackedFiles(tarball)).toEqual(
    expect.arrayContaining(verifiedHostBindingFixture.requiredPackedPaths),
  )
})

it('does not pack React or DeepSeek Harness runtime modules', async () => {
  const files = await listPackedFiles(tarball)
  expect(files.some(file => /node_modules\/(react|@deepseek-ai\/)/.test(file))).toBe(false)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/bundle/test/client-manifest.test.ts packages/bundle/test/full-plugin.test.ts`

Expected: FAIL because the fixture-derived host/client package contract and full plugin do not exist.

- [ ] **Step 3: Extend the package using the public Bundle contract**

Keep `dsh.bundle.patch = './cordis.patch.yml'` and the single `backend-team` root row. Generate every client declaration, package export key, source/output entry filename, and build entry from the successful Task 2 fixture; this plan deliberately supplies no fallback name or path. If the fixture does not prove the full public package contract, this task remains blocked. Build host and browser entries separately only in the fixture-prescribed shape. Mark React and every proven Harness platform/client package as external peer dependencies; package tests resolve them from the installed Harness Profile, not from nested Bundle copies.

- [ ] **Step 4: Mount all services beneath the existing root row**

After every Task 2 orchestration and host/client gate passes, the one root plugin creates workspace layout, state/policy/platform adapters, the production `BackendTeamOrchestrationPort`, workflow/analyzer/team/development/database services, `CoordinatorControlAdapter`, control service, and diagnostics in dependency order. The adapter maps every `BackendTeamControlAction` to the same typed coordinator/workflow/database methods used by Stages 04–06; it cannot write state or run processes itself. Startup stops at the first missing, incompatible, or unrecoverable capability and reports a typed blocked/read-only state. Disposer order is reversed; it cancels live Agents through verified handles, persists terminal usage/events, stops subscriptions, rejects new work, waits for state persistence, stops DbGate and workspace PostgreSQL by verified identity, then releases proven host registrations. No global Harness guard is installed; authoritative policy checks remain at every side-effect adapter.

- [ ] **Step 5: Make installation and activation idempotent**

Before install, inspect the target Profile dump and classify `absent`, `same-version`, `upgrade`, or `conflict`. `same-version` performs verification only. `upgrade` replaces the package reference while retaining the existing row ID and state. More than one matching row, an unknown forked package, or an edited incompatible row blocks with exact cleanup instructions; the installer never deletes Profile rows silently.

- [ ] **Step 6: Pack and inspect the production tarball**

Extend `test-packed-bundle.mjs` to require every path in the verified fixture plus `cordis.patch.yml`, README, notices, and source-map path redaction; reject `.backend-team`, test fixtures, credentials, absolute paths, nested React/Harness runtimes, and undeclared executable files. Unpack to a temporary directory and import the fixture-identified host entry without activating external side effects.

- [ ] **Step 7: Run tests and commit**

```bash
npm test -- --run packages/bundle/test
npm run build
npm pack --workspace packages/bundle --json
node scripts/test-packed-bundle.mjs
git add packages/bundle packages/web scripts/test-packed-bundle.mjs package.json package-lock.json
git commit -m "feat: integrate backend team bundle and client"
```

---

### Task 5: Implement install, upgrade, diagnostics, rollback, and uninstall

**Files:**
- Create: `scripts/backend-team-profile.mjs`
- Create: `scripts/backend-team-doctor.mjs`
- Create: `scripts/backend-team-uninstall.mjs`
- Create: `packages/core/src/state-migrations.ts`
- Test: `packages/core/test/state-migrations.test.ts`
- Test: `tests/integration/profile-lifecycle.test.ts`
- Create: `docs/operations/install-macos.md`
- Create: `docs/operations/upgrade.md`
- Create: `docs/operations/diagnostics.md`
- Create: `docs/operations/uninstall.md`

**Interfaces:**
- Consumes: packed Bundle path, isolated or user-selected DSH Profile, `BackendTeamState`, compatibility matrix.
- Produces: lifecycle CLI operations `inspect`, `install`, `verify`, `upgrade`, `rollback`, `uninstall`, `doctor`.

- [ ] **Step 1: Write failing lifecycle and migration tests**

```ts
it('upgrades one Profile row without duplicating its id', async () => {
  await lifecycle.install(profile, v1Tarball)
  await lifecycle.upgrade(profile, v2Tarball)
  expect(await profile.rows()).toEqual([
    expect.objectContaining({ id: 'backend-team', name: '@dsh-backend-team/bundle' }),
  ])
})

it('uninstalls the Bundle but preserves project data', async () => {
  await lifecycle.uninstall(profile, workspace)
  await expect(pathExists(join(workspace, '.backend-team', 'state'))).resolves.toBe(true)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/core/test/state-migrations.test.ts tests/integration/profile-lifecycle.test.ts`

Expected: FAIL with missing migration and lifecycle tools.

- [ ] **Step 3: Implement versioned, atomic state migration**

Each state schema version has a pure `from -> to` function and fixture test. Before upgrade, lock the workspace, stop active work, fsync a state/approval/handoff snapshot, migrate a copy, validate it, then atomically switch. A migration failure leaves the old package and state selected. Rollback is allowed only when the target code can read the current schema or a verified pre-upgrade snapshot is restored.

- [ ] **Step 4: Implement Profile lifecycle around official DSH commands**

Use the pinned Harness installation/Bundle commands recorded in Stage 01; pass Profile paths explicitly and never rewrite Harness configuration text directly. Install/upgrade requires confirmation showing Profile, Bundle version/hash, and affected row. After every change run Profile dump, real Harness boot, diagnostic tool call, and client asset load. On failure, restore the prior package selection and re-run its smoke test.

- [ ] **Step 5: Implement actionable diagnostics**

`doctor` reports Harness compatibility, Node/macOS architecture, Bundle identity, duplicate rows, workspace permissions, state schema, remaining budgets, uv/Python/Spec Kit status, PostgreSQL/DbGate status, non-loopback listeners, dependency/SBOM hashes, and most recent redacted failure. It performs no installation, repair, state mutation, or process start.

- [ ] **Step 6: Implement conservative uninstall**

Stop only verified Team processes, remove the single Profile row/package through official DSH commands, verify a clean boot, and preserve project specs, state, reports, local PostgreSQL data, and snapshots. The guide gives a separate, explicit data-removal procedure requiring the exact workspace path and backup choice; the default command never invokes it.

- [ ] **Step 7: Run tests and commit**

```bash
npm test -- --run packages/core/test/state-migrations.test.ts tests/integration/profile-lifecycle.test.ts
npm run typecheck
git add scripts packages/core docs/operations
git commit -m "feat: add safe bundle lifecycle operations"
```

---

### Task 6: Produce auditable release metadata and artifacts

**Files:**
- Create: `scripts/build-release.mjs`
- Create: `scripts/verify-release.mjs`
- Create: `.github/workflows/release-bundle.yml`
- Create: `docs/licenses/third-party-notices.md`
- Create: `docs/licenses/distribution-decision.md`
- Create: `docs/operations/release.md`
- Create during the V1 release: `dist/backend-agent-team-0.1.0.tgz`
- Create during the V1 release: `dist/backend-agent-team-0.1.0.tgz.sha256`
- Create during the V1 release: `dist/backend-agent-team-0.1.0.cdx.json`
- Test: `tests/integration/release-artifact.test.ts`

**Interfaces:**
- Consumes: package lock, runtime manifests, license inventory, verified test evidence, clean Git revision.
- Produces: signed/checksummed Bundle tarball, CycloneDX SBOM, provenance attestation, third-party notices, release verification report.

- [ ] **Step 1: Write failing release-policy tests**

```ts
it('refuses release when a runtime manifest lacks a concrete URL or hash', async () => {
  await expect(release.verify(incompleteManifest)).rejects.toMatchObject({ code: 'INCOMPLETE_RUNTIME_PROVENANCE' })
})

it('keeps GPL DbGate packages outside the Bundle tarball', async () => {
  expect(await tarballContains(tarball, /dbgate/)).toBe(false)
  expect(notices).toContain('DbGate Community 7.2.3')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run tests/integration/release-artifact.test.ts`

Expected: FAIL because release builders and metadata are missing.

- [ ] **Step 3: Freeze the distribution boundary**

The Bundle tarball contains MIT/Apache/BSD-compatible JavaScript dependencies permitted by the reviewed license policy. Workspace-downloaded NVM, Node.js, uv, Python, Spec Kit, PostgreSQL, and DbGate remain separate artifacts governed by manifests and install consent. Record NVM/Node artifact provenance and licenses, PostgreSQL License, MIT uv/Spec Kit terms, and GPL-3.0 DbGate obligations; a legal/distribution review decision is required before any future offline aggregation.

- [ ] **Step 4: Build only from a clean, verified revision**

Require a clean Git tree, NVM `0.40.3` and exact Node.js `24.19.0`/npm versions resolved below the target workspace, lockfile integrity, complete runtime manifests, passing full tests/typecheck/lint/build, no high/critical npm audit or OSV finding without an unexpired reviewed exception, and two-architecture evidence. Use local-NVM `npm pack` output as input, calculate SHA-256, create CycloneDX JSON, attach source revision/toolchain/runtime-manifest digests and executable realpaths, and sign through the configured release service. Missing signing credentials blocks an official release; it may produce only a clearly labeled local-development artifact.

- [ ] **Step 5: Verify from a clean extraction**

The verifier checks the tarball hash/signature, SBOM component/version agreement with the lockfile, notice completeness, no forbidden files/secrets/absolute source paths, no nested Harness/React/DbGate runtime, exact Bundle/client exports, and successful fresh-Profile install/boot/tool/client smoke on each supported architecture.

- [ ] **Step 6: Run release checks and commit metadata**

```bash
npm test -- --run tests/integration/release-artifact.test.ts
npm run test
npm run typecheck
npm run lint
npm run build
node scripts/build-release.mjs --channel local-development
node scripts/verify-release.mjs --channel local-development
git add scripts .github/workflows/release-bundle.yml docs/licenses docs/operations/release.md tests/integration/release-artifact.test.ts
git commit -m "build: add auditable bundle release pipeline"
```

Do not commit generated `dist/` artifacts to Git; attach official artifacts and attestations to the configured release service only after its credential gate passes.

---

### Task 7: Prove the complete product in fresh Profiles and both macOS architectures

**Files:**
- Create: `tests/e2e/scenarios.ts`
- Create: `tests/e2e/backend-team-harness.test.ts`
- Create: `tests/e2e/browser-acceptance.md`
- Create: `scripts/create-e2e-profile.mjs`
- Create: `scripts/run-e2e-scenario.mjs`
- Create: `.github/workflows/macos-e2e.yml`
- Create: `docs/compatibility/release-evidence.md`
- Modify: `docs/operations/install-macos.md`

**Interfaces:**
- Consumes: signed release candidate, fresh isolated `DSH_HOME`, deterministic test-model adapter, release-only real DeepSeek credentials, Codex Chrome, dual-architecture runners.
- Produces: machine evidence for ten approved acceptance scenarios plus browser screenshots/interaction record and real-model smoke evidence.

- [ ] **Step 1: Encode the ten acceptance scenarios as executable fixtures**

Map each row from the master-plan acceptance table to explicit initial workspace/Profile state, scripted user inputs, expected phase transitions, permitted file/process/network/database effects, expected reports, and cleanup assertions. Include new app, existing PostgreSQL app, existing MySQL app, interruption at every phase, delegation bounds, production/outside-workspace attacks, DbGate schema design, global-pollution audit, missing/untrusted Harness provenance, and arm64/x64 installation.

- [ ] **Step 2: Run the new scenarios and verify failure before wiring the final product**

Run: `npm test -- --run tests/e2e/backend-team-harness.test.ts`

Expected: FAIL until fresh-Profile setup, Bundle lifecycle, deterministic model, browser assertions, and product services are connected.

- [ ] **Step 3: Build hermetic E2E Profiles and workspaces**

Create a new temporary `DSH_HOME` and target workspace per scenario, obtain install consent, bootstrap NVM `0.40.3` plus the required exact Node version under that target workspace, install only the release-candidate tarball through official DSH commands, allocate loopback ports, seed no user credentials, and snapshot filesystem/process/listener/global tool/shell-profile/NVM-alias state before and after. Every Team Node/package-manager command records a realpath below the temporary workspace. Cleanup stops verified temporary processes and retains failed test artifacts under the CI job only.

- [ ] **Step 4: Run deterministic workflow and adversarial suites**

Use a deterministic test-model implementation whose exact production binding has passed Task 2 to make phase/delegation assertions reproducible while exercising the real Harness Bundle, production `BackendTeamOrchestrationPort`, policy-enforced side-effect adapters, state store, Spec Kit, PostgreSQL, and package code. Inject process crashes, stale approvals, state corruption copies, writer collisions, malicious tool actions, network redirects, dirty Git changes, migration failures, duplicate Profile rows, and missing/untrusted installer/Profile provenance; assert typed recovery and zero forbidden side effects. Do not simulate a trusted version field on the production rc.6 Context. If approval, Agent spawn/result/cancel/usage, durable event, host/client, or authenticated session production seams are missing, this E2E and release remain blocked.

- [ ] **Step 5: Run the real browser acceptance with Codex Chrome**

Against the actual DeepSeek Harness Web UI, use Codex Chrome to open the Backend Team panel, submit requirements, inspect/approve requirements, inspect/approve design, observe expert/subagent activity, approve workspace runtime installation, start PostgreSQL, open authenticated DbGate, design a table/field/index, review the generated migration, continue development, inspect verification evidence, interrupt/resume, and uninstall the Bundle. Record expected accessible labels, screenshots, console/network errors, Profile row count, and preserved workspace data in `browser-acceptance.md`.

- [ ] **Step 6: Run one credential-gated real DeepSeek model smoke**

On a protected release runner, supply credentials only through an injected credential port backed by a facility whose public API/provenance was freshly verified; Stage 01 did not prove any host credential facility. Complete one small new-backend scenario through requirements approval, design approval, one vertical slice, PostgreSQL migration, and verification. Redact prompts/logs before retention. Missing verified credential storage, missing credentials, or a failed real-model run blocks an official release; deterministic tests cannot be used to claim real-model compatibility.

- [ ] **Step 7: Prove both architectures and no host pollution**

Run fresh-Profile install/boot/tool/client/PostgreSQL/DbGate smoke on native macOS arm64 and native Intel x64. Compare the before/after snapshot: no global NVM/Node/npm/Python/uv package, NVM alias/default, shell-profile change, system service, Docker resource, Homebrew/MacPorts write, non-loopback listener, or path outside the temporary DSH Profile/target workspace/test artifact root is allowed.

- [ ] **Step 8: Run the full release gate and commit evidence**

```bash
npm run test
npm run typecheck
npm run lint
npm run build
node scripts/verify-release.mjs --channel release-candidate
npm test -- --run tests/e2e/backend-team-harness.test.ts
git add tests/e2e scripts/create-e2e-profile.mjs scripts/run-e2e-scenario.mjs .github/workflows/macos-e2e.yml docs/compatibility/release-evidence.md docs/operations/install-macos.md
git commit -m "test: prove backend team release candidate"
```

The task remains open until dual-architecture CI, Codex Chrome acceptance, and the real-model smoke all pass with linked evidence. A skipped, mocked-only, or “not run” check is not a release pass.

---

## Stage 07 Completion Gate

Stage 07 is complete only when one production-shaped `.tgz`:

1. installs and upgrades through official DSH commands in a fresh Profile without duplicate rows;
2. constructs the sole production `BackendTeamOrchestrationPort` from durable application events, control-mediated explicit approval, and a verified Agent spawn/result/cancel/usage binding, while rejecting mocks and missing seams;
3. loads the Stage 01 diagnostic tool on externally verified Harness `0.1.0-rc.6` and loads host/client/session/model/Agent entries only if the separate Stage 07 official API/provenance fixtures prove them on that exact dependency wave;
4. exposes only coordinator-routed, revision-checked controls through authenticated loopback sessions;
5. passes component accessibility checks and the real Web UI flow through Codex Chrome;
6. preserves project data across rollback/uninstall and leaves no global/system pollution;
7. has complete checksum, signature, SBOM, license, runtime provenance, and dual-architecture evidence; and
8. passes all ten approved scenarios plus a credential-gated real DeepSeek model smoke.

Public registry publishing is a separate decision after namespace ownership and release signing are configured; it is not implied by this stage.
