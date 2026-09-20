# Backend Agent Team Stage 05: Development and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an approved design into bounded vertical-slice code changes, verify them against requirements and the existing baseline, govern dependencies/security, and recover from failure without overwriting user work.

**Architecture:** A planner converts Spec Kit tasks into typed vertical slices. A patch tracker establishes each Agent's exact before-state, the coordinator schedules developer/tester/security/fixer roles, and a verification engine maps acceptance criteria to reproducible evidence. Dependency and retry policies are independent gates, not prompt suggestions.

**Tech Stack:** TypeScript, Vitest, npm/package-manager adapters, OpenAPI, npm audit, OSV, CycloneDX, new-project baseline NestJS 11.2.2 + Fastify 5.12.1 + Drizzle 0.45.2.

**Spec:** `docs/superpowers/specs/2026-08-25-backend-agent-team-design.md`

## Global Constraints

- Follow the master plan and Stages 01–04.
- Business-code writes require current requirements/design approvals and a `BUILD` or `VERIFY` phase.
- After design approval, owned in-scope code writes are automatic; dependency, shared-config, migration, install, network, and destructive actions retain their own gates.
- Existing projects retain framework, ORM, database, package manager, directories, and conventions unless the approved design explicitly says otherwise.
- Every project Node/package-manager command uses the exact `DevelopmentStrategy.nodeRuntime` through target-workspace `WorkspaceNodeRuntime`; existing projects keep their compatible trusted declaration and new projects use `24.19.0`. Missing/conflicting runtime evidence blocks execution until design approval resolves it.
- A tester may create/fix test code and evidence only; it may not modify implementation.
- Existing baseline failures remain separate from new failures.
- A passed claim requires captured evidence. `not-run` and `blocked` are never converted to pass.
- Automatic retry is limited to two recoverable attempts; permission, contradiction, data risk, and deterministic failures do not retry.

---

### Task 1: Parse Spec Kit tasks into traceable vertical slices

**Files:**
- Create: `packages/development/package.json`
- Create: `packages/development/tsconfig.json`
- Create: `packages/development/src/vertical-slice.ts`
- Create: `packages/development/src/task-plan-parser.ts`
- Create: `packages/development/src/requirement-trace.ts`
- Create: `packages/development/src/index.ts`
- Test: `packages/development/test/task-plan-parser.test.ts`
- Test: `packages/development/test/requirement-trace.test.ts`

**Interfaces:**
- Consumes: approved `tasks.md`, `spec.md`, `architecture.md`, `data-model.md`, `openapi.yaml`, `test-plan.md` hashes.
- Produces: `VerticalSlice`, `DevelopmentPlan`, `RequirementTrace`, `TaskPlanParser.parse()`.

- [ ] **Step 1: Write failing parsing and trace tests**

```ts
it('groups API, domain, persistence and tests into one reviewable slice', async () => {
  const plan = await parser.parse(fixtureArtifacts)
  expect(plan.slices[0].layers).toEqual(['contract', 'domain', 'persistence', 'test'])
  expect(plan.slices[0].requirementIds).toEqual(['AC-001', 'AC-002'])
})

it('rejects an acceptance criterion with no planned evidence', async () => {
  await expect(parser.parse(missingEvidenceFixture)).rejects.toThrow('AC-003 has no evidence task')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/development/test/task-plan-parser.test.ts packages/development/test/requirement-trace.test.ts`

Expected: FAIL with missing parser.

- [ ] **Step 3: Implement strict task markers and parsing**

Require each executable task in `tasks.md` to carry stable IDs and metadata in HTML comments:

```markdown
<!-- backend-team:task id=T-001 slice=S-001 requirements=AC-001,AC-002 owner=developer risk=standard -->
- [ ] Implement tenant-aware order creation
```

Reject duplicate IDs, unknown requirement IDs, missing owner/risk, and dependency cycles. The planning expert repairs invalid files before build begins.

- [ ] **Step 4: Build traceability**

Every slice declares inputs and hashes, expected files/path groups, API operations, data changes, test evidence, dependencies, rollback boundary, and completion conditions. A requirement can map to multiple slices; every requirement must map to at least one planned evidence record.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/development/test
npm run typecheck
git add packages/development
git commit -m "feat: plan traceable vertical backend slices"
```

---

### Task 2: Provide the approved new-project baseline without affecting existing projects

**Files:**
- Create: `runtime-manifests/nvm-0.40.3.json`
- Create: `runtime-manifests/node-runtime-catalog.json`
- Create: `runtime-manifests/node-24.19.0-darwin-arm64.json`
- Create: `runtime-manifests/node-24.19.0-darwin-x64.json`
- Create: `runtime-manifests/node-20.20.0-darwin-arm64.json`
- Create: `runtime-manifests/node-20.20.0-darwin-x64.json`
- Create: `packages/platform-macos/src/node-runtime-manifest.ts`
- Create: `packages/platform-macos/src/node-runtime-manifest-resolver.ts`
- Create: `packages/platform-macos/src/workspace-node-bootstrap.ts`
- Create: `packages/platform-macos/src/workspace-node-runtime.ts`
- Modify: `packages/platform-macos/src/index.ts`
- Test: `packages/platform-macos/test/node-runtime-manifest.test.ts`
- Test: `packages/platform-macos/test/node-runtime-manifest-resolver.test.ts`
- Test: `packages/platform-macos/test/workspace-node-bootstrap.test.ts`
- Test: `packages/platform-macos/test/workspace-node-runtime.test.ts`
- Create: `templates/new-project/node-postgresql/.nvmrc`
- Create: `templates/new-project/node-postgresql/package.json.json`
- Create: `templates/new-project/node-postgresql/tsconfig.json`
- Create: `templates/new-project/node-postgresql/tsconfig.build.json`
- Create: `templates/new-project/node-postgresql/src/main.ts`
- Create: `templates/new-project/node-postgresql/src/app.module.ts`
- Create: `templates/new-project/node-postgresql/src/health/health.controller.ts`
- Create: `templates/new-project/node-postgresql/src/database/database.module.ts`
- Create: `templates/new-project/node-postgresql/src/database/schema.ts`
- Create: `templates/new-project/node-postgresql/drizzle.config.ts`
- Create: `templates/new-project/node-postgresql/test/health.integration.test.ts`
- Create: `packages/development/src/new-project-bootstrapper.ts`
- Test: `packages/development/test/new-project-bootstrapper.test.ts`

**Interfaces:**
- Consumes: `DevelopmentStrategy.nodeRuntime` from Stage 03 for new and existing projects, new-project strategy kind where applicable, design approval, install/dependency approval, a concrete policy-engine-owned guarded artifact adapter (the Stage 01 primitive is internal and unavailable), and `CommandRunner`. This task is blocked until that adapter's exact-scope/redirect tests pass.
- Produces: `NodeRuntimeManifestSchema`, `NodeRuntimeManifestResolver`, `WorkspaceNodeBootstrap`, `WorkspaceNodeRuntime.resolve({ selection, projectKind, architecture, installApproval })` returning the selected manifest, verified target-local loader realpath, and absolute target-local Node/npm/npx realpaths, `NewProjectBootstrapper.preview()/apply()`, `NewProjectManifest`.

- [ ] **Step 1: Write failing strategy-isolation tests**

```ts
it.each([
  ['24.19.0', 'darwin-arm64', newProjectNode24StrategyFixture],
  ['24.19.0', 'darwin-x64', newProjectNode24StrategyFixture],
  ['20.20.0', 'darwin-arm64', existingProjectNode20StrategyFixture],
  ['20.20.0', 'darwin-x64', existingProjectNode20StrategyFixture],
])('resolves strategy-selected %s for %s through the verified target-local runtime', async (exactVersion, architecture, strategy) => {
  const runtime = await nodeRuntime.resolve({
    selection: strategy.nodeRuntime,
    projectKind: strategy.kind,
    architecture,
    installApproval,
  })

  expect(runtime.manifest).toMatchObject({ exactVersion, architecture })
  expect(runtime.loaderRealPath).toBe(join(workspaceRoot, '.backend-team/runtime/nvm/nvm.sh'))
  expect(loaderVerificationRecorder.verifiedAndSourcedPaths).toEqual([runtime.loaderRealPath])
  expect(globalMutationRecorder.events).toEqual([])
  for (const realPath of [runtime.nodeRealPath, runtime.npmRealPath, runtime.npxRealPath]) {
    expect(isAbsolute(realPath)).toBe(true)
    expect(relative(workspaceRoot, realPath)).not.toMatch(/^\.\.(?:\/|$)/)
    expect(realPath).toContain('/.backend-team/runtime/nvm/')
  }
})

it('rejects a new-project strategy selecting EOL Node 20 before download or command', async () => {
  await expect(nodeRuntime.resolve({
    selection: newProjectNode20StrategyFixture.nodeRuntime,
    projectKind: newProjectNode20StrategyFixture.kind,
    architecture: 'darwin-arm64',
    installApproval,
  })).rejects.toThrow(/eol.*existing-project-only|existing-project-only.*eol/i)
  expect(downloader.requests).toEqual([])
  expect(commandRunner.requests).toEqual([])
})

it('fails closed before download or command when the selected runtime has no manifest', async () => {
  await expect(nodeRuntime.resolve({
    selection: { exactVersion: '22.99.0', source: '.nvmrc' },
    projectKind: 'modify-in-place',
    architecture: 'darwin-arm64',
    installApproval,
  })).rejects.toThrow(/reviewed runtime manifest/i)
  expect(downloader.requests).toEqual([])
  expect(commandRunner.requests).toEqual([])
})

it('previews the approved modular-monolith baseline for a new project', async () => {
  const preview = await bootstrapper.preview(newProjectStrategy)
  expect(preview.dependencies).toMatchObject({
    '@nestjs/core': '11.2.2',
    '@nestjs/platform-fastify': '11.2.2',
    'drizzle-orm': '0.45.2',
    pg: '8.23.0',
  })
  expect(preview.nodeRuntime).toEqual({ exactVersion: '24.19.0', source: 'new-project-default' })
})

it('refuses to run for an existing project', async () => {
  await expect(bootstrapper.preview(existingMysqlStrategy)).rejects.toThrow('new-project bootstrap is not applicable')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/platform-macos/test/node-runtime-manifest.test.ts packages/platform-macos/test/node-runtime-manifest-resolver.test.ts packages/platform-macos/test/workspace-node-bootstrap.test.ts packages/platform-macos/test/workspace-node-runtime.test.ts packages/development/test/new-project-bootstrapper.test.ts`

Expected: FAIL with the product runtime manager/bootstrap and new-project templates missing.

- [ ] **Step 3: Implement the product Node runtime gate before any project command**

Define a strict closed `NodeRuntimeManifestSchema` and catalog whose key is exact Node version × `darwin-arm64 | darwin-x64`. Research and review the official source URL, SHA-256, size, architecture, and license for each listed future artifact during this task; do not add a placeholder hash, derive a URL dynamically, or infer one architecture from another. The initial reviewed set covers new-project `24.19.0` and the existing-project fixture `20.20.0` on both architectures. Mark Node `20.20.0` as `eol-existing-project-only`: never select it for a new project, show the EOL/security risk during design confirmation and install approval, but preserve a compatible existing project's approved exact runtime instead of silently migrating it.

Pin NVM `0.40.3` source with the same strict provenance fields. `WorkspaceNodeBootstrap` must obtain it through the concrete policy-engine-owned guarded artifact adapter (not the unavailable Stage 01 internal primitive), verify the reviewed manifest before extraction, install it below the target `.backend-team/runtime/nvm`, and source only that verified local `nvm.sh`. A user/host NVM loader is forbidden in product execution even when read-only; the Stage 01 development exception is not a product fallback.

`NodeRuntimeManifestResolver` accepts the exact `DevelopmentStrategy.nodeRuntime` selection from Stage 03 plus detected macOS architecture and returns only an exact catalog entry. `WorkspaceNodeRuntime.resolve()` consumes that selection through the resolver together with the strategy's project kind, install approval, and the product-local loader; it returns the selected manifest, verified target-local loader realpath, and absolute Node/npm/npx realpaths below the target workspace. Every NVM or Node download consumes exact install approval and goes through the concrete guarded artifact adapter plus manifest verification before extraction/use. Missing catalog entry, incomplete provenance, checksum mismatch, architecture mismatch, EOL use by a new project, absent approval, or missing guarded adapter fails before network, extraction, or command execution.

The runtime does not resolve pnpm/yarn from PATH. It accepts them only as a reviewed project-local absolute executable, or invokes a reviewed project-local JavaScript entry with the selected absolute Node. Tests use real new/existing `DevelopmentStrategy` fixtures and local fixture archives; through `WorkspaceNodeRuntime.resolve()` they verify only a manifest-verified target-local `nvm.sh` is sourced, every Node/npm/npx realpath is absolute and under the target workspace, both versions resolve on both architectures, a new-project Node `20.20.0` selection is rejected as EOL/existing-project-only before downloader/runner calls, absent/unreviewed combinations fail separately before downloader/runner calls, checksum failures fail closed, no PATH fallback occurs, and no shell-profile/global alias/default mutation occurs. Until these tests pass, do not execute the template install or any existing-project Node/package-manager command; Stage 07 release remains blocked.

- [ ] **Step 4: Write the minimal runnable baseline**

Write `.nvmrc` as exact `24.19.0` and `package.json#engines.node` as the supported range `>=24 <25`. Pin runtime dependencies: Nest core/common/platform-fastify `11.2.2`, Fastify `5.12.1`, `@nestjs/swagger` `11.4.7`, Drizzle `0.45.2`, pg `8.23.0`, reflect-metadata `0.2.2`, rxjs `7.8.2`. Pin development dependencies: TypeScript `6.0.3`, Drizzle Kit `0.31.10`, Vitest `4.1.11`, `@types/node` `24.13.3`, `@types/pg` `8.23.1`, ESLint `10.9.1`.

`main.ts` binds to `127.0.0.1` by default, registers OpenAPI, enables shutdown hooks, and reads a validated local `PORT`. Database configuration accepts a credential reference resolved at runtime; the template contains no password or default production URL.

- [ ] **Step 5: Implement preview then apply**

`preview()` returns exact paths, bytes, dependencies, commands, Node runtime version/source, and conflicts. `apply()` requires current design approval plus dependency/install approval, verifies the root is still empty except allowed planning metadata, writes through atomic owned-file APIs, asks `WorkspaceNodeRuntime` to provision `24.19.0` under the target workspace NVM when absent, runs install with lifecycle scripts disabled through the selected absolute npm or reviewed project-local package-manager entry, and records every hash/realpath. It never performs PATH lookup, creates an NVM alias/default, or touches a shell profile.

- [ ] **Step 6: Verify template compilation through an isolated fixture**

The test copies the template, substitutes a local fake database adapter for this stage, installs exact dependencies with `--ignore-scripts` through `WorkspaceNodeRuntime` Node.js `24.19.0`, and runs typecheck/build/health unit test. Assert Node/npm/npx realpaths stay below `.backend-team/runtime/nvm`, PATH-shadow executables receive zero calls, external loader access receives zero calls, and shell profile/global alias snapshots do not change. Real PostgreSQL replaces the fake in Stage 06.

- [ ] **Step 7: Commit**

```bash
npm test -- --run packages/platform-macos/test/node-runtime-manifest.test.ts packages/platform-macos/test/node-runtime-manifest-resolver.test.ts packages/platform-macos/test/workspace-node-bootstrap.test.ts packages/platform-macos/test/workspace-node-runtime.test.ts packages/development/test/new-project-bootstrapper.test.ts
git add runtime-manifests packages/platform-macos templates/new-project packages/development
git commit -m "feat: add approved node postgres project baseline"
```

---

### Task 3: Track Agent-owned patches without overwriting user changes

**Files:**
- Create: `packages/development/src/file-snapshot.ts`
- Create: `packages/development/src/patch-tracker.ts`
- Create: `packages/development/src/concurrent-change-guard.ts`
- Test: `packages/development/test/patch-tracker.test.ts`
- Test: `packages/development/test/concurrent-change-guard.test.ts`

**Interfaces:**
- Consumes: task ownership lease, Git baseline, file bytes before/after.
- Produces: `PatchTracker.begin()/capture()/rollbackOwnChanges()`, `ConcurrentChangeGuard.assertUnchanged()`.

- [ ] **Step 1: Write failing dirty-file and concurrent-edit tests**

```ts
it('rolls back only the Agent hunk in a file dirty before the task', async () => {
  const session = await tracker.begin(['src/service.ts'])
  await fixture.applyUserEditBeforeTask()
  await session.captureAgentEdit(agentEdit)
  await session.rollbackOwnChanges()
  expect(await fixture.read('src/service.ts')).toBe(userDirtyVersion)
})

it('stops when the file changes after snapshot but before Agent write', async () => {
  const snapshot = await guard.capture('src/service.ts')
  await fixture.applyExternalEdit()
  await expect(guard.assertUnchanged(snapshot)).rejects.toThrow('concurrent change detected')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/development/test/patch-tracker.test.ts packages/development/test/concurrent-change-guard.test.ts`

Expected: FAIL with missing tracker.

- [ ] **Step 3: Implement byte-accurate snapshots**

Store mode, SHA-256, byte length, Git status, and compressed bytes for files a task may write under `.backend-team/runs/<run>/patches/`. New files record absence. Reject files above the configured patch limit rather than snapshotting partial data.

- [ ] **Step 4: Implement compare-before-write and own-change rollback**

Immediately before each write, require current hash equals the task snapshot/current accepted task hash. After writing, record before/after hashes and a unified patch. Rollback applies the inverse patch only if the current file still equals the Agent after-hash; otherwise stop and request re-merge. Never call `git reset`, `checkout`, `clean`, or stash.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/development/test/patch-tracker.test.ts packages/development/test/concurrent-change-guard.test.ts
git add packages/development
git commit -m "feat: protect user changes during agent writes"
```

---

### Task 4: Enforce open-source dependency and supply-chain governance

**Files:**
- Create: `packages/dependency-governance/package.json`
- Create: `packages/dependency-governance/tsconfig.json`
- Create: `packages/dependency-governance/src/dependency-proposal.ts`
- Create: `packages/dependency-governance/src/license-policy.ts`
- Create: `packages/dependency-governance/src/lifecycle-policy.ts`
- Create: `packages/dependency-governance/src/npm-audit-adapter.ts`
- Create: `packages/dependency-governance/src/osv-adapter.ts`
- Create: `packages/dependency-governance/src/sbom.ts`
- Create: `packages/dependency-governance/src/index.ts`
- Test: `packages/dependency-governance/test/dependency-governance.test.ts`

**Interfaces:**
- Consumes: project package manager, proposed exact dependencies, network/install approvals, `CommandRunner`.
- Produces: `DependencyGovernance.review()`, `DependencyDecision`, `SecurityFinding`, CycloneDX SBOM path.

- [ ] **Step 1: Write failing policy tests**

```ts
it.each(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'PostgreSQL'])('permits reviewed %s licenses', license => {
  expect(policy.classify(license)).toBe('normal-review')
})

it.each(['GPL-3.0', 'AGPL-3.0', 'SSPL-1.0', 'UNKNOWN'])('requires or denies %s', license => {
  expect(policy.classify(license)).not.toBe('normal-review')
})

it('blocks a severe unpatched vulnerability in a new dependency', async () => {
  const decision = await governance.review(vulnerableProposal)
  expect(decision.effect).toBe('deny')
})
```

- [ ] **Step 2: Install the pinned SBOM tool and run the failing tests**

Run:

```bash
npm install --save-dev --save-exact @cyclonedx/cyclonedx-npm@6.0.1
npm test -- --run packages/dependency-governance/test/dependency-governance.test.ts
```

Expected: FAIL with missing governance service.

- [ ] **Step 3: Implement proposal and license review**

A proposal contains purpose, alternatives, exact direct versions, transitive graph, licenses, repository, maintenance evidence, lifecycle scripts, telemetry/network behavior, replacement path, and requested files. Unknown/missing license denies. GPL/AGPL/SSPL returns `ask-special-license-review`, never automatic allow.

- [ ] **Step 4: Implement install and lifecycle handling**

First install uses the detected package manager's ignore-scripts mode under the strategy-selected target-workspace NVM Node version. Enumerate all dependency lifecycle scripts from the resolved graph. Known necessary scripts are separately shown with package/source/hash and require approval before `npm rebuild <exact-package-list>` or equivalent. Never enable all lifecycle scripts globally as a shortcut, and never fall back to a host Node/package-manager executable.

- [ ] **Step 5: Implement two-source vulnerability checks and SBOM**

Run the package manager audit JSON command and query `https://api.osv.dev/v1/querybatch` with exact ecosystem/name/version after network approval. Normalize severity, affected range, fix versions, and source. Generate CycloneDX JSON from the resolved lockfile and store it under `.backend-team/runs/<run>/governance/bom.json`.

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- --run packages/dependency-governance/test
npm run typecheck
git add packages/dependency-governance package.json package-lock.json
git commit -m "feat: govern open source dependencies"
```

---

### Task 5: Implement the approved development and repair loop

**Files:**
- Create: `packages/development/src/development-coordinator.ts`
- Create: `packages/development/src/slice-executor.ts`
- Create: `packages/development/src/failure-classifier.ts`
- Create: `packages/development/src/retry-policy.ts`
- Test: `packages/development/test/development-coordinator.test.ts`
- Test: `packages/development/test/retry-policy.test.ts`

**Interfaces:**
- Consumes: `DevelopmentPlan`, `TeamCoordinator`, `PatchTracker`, `DependencyGovernance`, approvals, project profile.
- Produces: `DevelopmentCoordinator.execute()`, `SliceExecutor.execute()`, `FailureClassifier.classify()`, `RetryPolicy.decide()`.

- [ ] **Step 1: Write failing phase and retry tests**

```ts
it('refuses business writes when design approval is stale', async () => {
  await expect(coordinator.execute(planWithStaleApproval)).rejects.toThrow('design approval is stale')
})

it.each([
  ['network-timeout', 'retry'],
  ['tool-busy', 'retry'],
  ['permission-denied', 'stop'],
  ['requirements-contradiction', 'stop'],
  ['migration-data-risk', 'stop'],
  ['test-assertion-failed', 'repair'],
])('routes %s to %s', (failure, action) => {
  expect(retryPolicy.decide(failureFixture(failure), 0).action).toBe(action)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/development/test/development-coordinator.test.ts packages/development/test/retry-policy.test.ts`

Expected: FAIL with missing coordinator.

- [ ] **Step 3: Implement slice execution**

For each ready slice: verify current hashes/approvals, acquire ownership, snapshot files, dispatch a developer, verify handoff, dispatch a tester, classify failures, dispatch a fixer when allowed, rerun affected verification, record evidence, and release ownership. Do not mark the slice complete until its acceptance evidence passes.

- [ ] **Step 4: Implement typed failures and bounded retry**

Use categories: requirement contradiction, permission, dependency/network, missing tool, code compile, test assertion, migration risk, resource budget, Harness incompatibility, and interruption. Transient retry count max is two with deterministic backoff in tests. A repair is a new owned task with failure evidence, not a blind rerun of the same prompt.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/development/test
git add packages/development
git commit -m "feat: execute approved development slices"
```

---

### Task 6: Build baseline-aware verification and requirement evidence

**Files:**
- Create: `packages/verification/package.json`
- Create: `packages/verification/tsconfig.json`
- Create: `packages/verification/src/verification-command.ts`
- Create: `packages/verification/src/baseline-runner.ts`
- Create: `packages/verification/src/result-comparator.ts`
- Create: `packages/verification/src/requirement-evidence.ts`
- Create: `packages/verification/src/verification-engine.ts`
- Create: `packages/verification/src/index.ts`
- Test: `packages/verification/test/baseline-runner.test.ts`
- Test: `packages/verification/test/result-comparator.test.ts`
- Test: `packages/verification/test/requirement-evidence.test.ts`

**Interfaces:**
- Consumes: detected commands, requirement trace, approved test plan, `CommandRunner`.
- Produces: `VerificationEngine.captureBaseline()/verifySlice()/verifyAll()`, `VerificationReport`.

- [ ] **Step 1: Write failing baseline comparison tests**

```ts
it('does not count an unchanged historical failure as newly introduced', () => {
  const result = compareResults(baselineWithFailure, finalWithSameFailure)
  expect(result.newFailures).toEqual([])
  expect(result.baselineFailures).toHaveLength(1)
})

it('records blocked instead of pass when a command cannot run', async () => {
  const report = await engine.verifyAll(blockedFixture)
  expect(report.requirements['AC-004'].status).toBe('blocked')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/verification/test`

Expected: FAIL with missing verification engine.

- [ ] **Step 3: Implement command capture and normalization**

Record exact argv/cwd, input hashes, start/end time, exit code, bounded stdout/stderr hashes and redacted excerpts. Normalize test identities by framework where possible; otherwise compare command-level status and stable output fingerprints. Never discard raw redacted artifacts needed for audit.

- [ ] **Step 4: Implement required verification categories**

Support strict typecheck, lint, build, unit, real database integration (activated Stage 06), API/auth/permission, OpenAPI contract, migration, startup/health/graceful shutdown, and security. Mark non-applicable only with a reason tied to project profile/design.

- [ ] **Step 5: Map each acceptance criterion to evidence**

The final report has `passed|failed|not-run|blocked` per requirement, evidence IDs, commands/scenarios, expected/actual summary, related slice, and baseline classification. Overall completion requires every in-scope criterion `passed` and zero new verification failures.

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- --run packages/verification/test
npm run typecheck
git add packages/verification
git commit -m "feat: verify requirements against project baseline"
```

---

### Task 7: Add security review and production-target detection

**Files:**
- Create: `packages/verification/src/security-review.ts`
- Create: `packages/verification/src/secret-scan.ts`
- Create: `packages/verification/src/authorization-tests.ts`
- Test: `packages/verification/test/security-review.test.ts`
- Test: `packages/verification/test/secret-scan.test.ts`
- Create: `presets/checklists/backend-security.yaml`

**Interfaces:**
- Consumes: project profile, patch set, dependency findings, OpenAPI, test evidence.
- Produces: `SecurityReview.run()`, `SecurityFinding`, `ProductionTargetDetector`.

- [ ] **Step 1: Write failing security tests**

```ts
it.each([
  'postgres://user:password@prod.example.com/app',
  'AKIA' + 'IOSFODNN7EXAMPLE', // synthetic scanner fixture; never use a real credential
  '-----BEGIN PRIVATE KEY-----',
])('blocks likely real secret or production target', async value => {
  expect((await review.scanText(value)).some(f => f.severity === 'block')).toBe(true)
})

it('requires negative authorization evidence for protected operations', async () => {
  const report = await review.run(apiFixtureWithoutDeniedCase)
  expect(report.findings.map(f => f.code)).toContain('MISSING_DENY_AUTH_TEST')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/verification/test/security-review.test.ts packages/verification/test/secret-scan.test.ts`

Expected: FAIL with missing review.

- [ ] **Step 3: Implement local deterministic checks**

Scan only owned patch content and approved configuration paths. Detect credential formats, high-entropy values with contextual keys, non-loopback database/service hosts, SQL/command injection sinks, unsafe deserialization, missing input validation, auth bypass, tenant filter omission, and sensitive logging. Report file/line/hashes but redact secret values.

- [ ] **Step 4: Require auth and permission evidence**

For each protected OpenAPI operation, require unauthenticated denial, wrong-role denial, cross-tenant denial when applicable, and allowed-role success. Missing evidence blocks completion; the security expert remains read-only and returns repair instructions to a fixer.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/verification/test
git add packages/verification presets/checklists
git commit -m "feat: enforce backend security evidence"
```

---

### Task 8: Prove new-project, existing-project, failure, and recovery scenarios

**Files:**
- Create: `tests/e2e/new-project-simulated-harness.test.ts`
- Create: `tests/e2e/existing-dirty-project.test.ts`
- Create: `tests/e2e/existing-mysql-preservation.test.ts`
- Create: `tests/e2e/development-recovery.test.ts`
- Create: `docs/operations/development-recovery.md`
- Create: `packages/development/src/development-action-catalog.ts`

**Interfaces:**
- Consumes: all Stage 02–05 services with `MockHarnessAdapter` for the official tools surface, `MockBackendTeamOrchestrationPort` for scripted approvals/Agents/events, and deterministic fake Agent results. These mocks are separate and do not prove a real Harness orchestration API.
- Produces: an application-level development action catalog/composition, workflow events, and mock-driven Stage 05 completion evidence.

- [ ] **Step 1: Write the end-to-end expectations**

The new-project scenario reaches `VERIFY`, creates the pinned modular-monolith baseline, completes two slices, and produces a requirement report. The dirty existing scenario begins with tracked/untracked edits, modifies an overlapping dirty file safely, and preserves initial user bytes outside Agent hunks. The MySQL scenario proves no PostgreSQL/Drizzle dependency or file appears. Recovery interrupts before/after developer, tester, and fixer handoffs.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm test -- --run tests/e2e/new-project-simulated-harness.test.ts tests/e2e/existing-dirty-project.test.ts tests/e2e/existing-mysql-preservation.test.ts tests/e2e/development-recovery.test.ts
```

Expected: FAIL until runtime wiring is complete.

- [ ] **Step 3: Compose application workflow actions**

Define user-facing start/refine/approve/status/resume actions as `BackendTeamApplicationTool` values and route them through the application coordinator under `MockBackendTeamOrchestrationPort`. Development dispatch remains internal. Recheck compatibility, phase, approval hashes, project profile confidence, policy, and ownership at each action boundary. Do not modify the production Bundle or register these actions with Harness; Stage 07 Tasks 2 and 4 own the production orchestration gate and host registration.

- [ ] **Step 4: Implement interruption recovery**

On resume, validate state, approvals, Git baseline/current changes, ownership leases, patch snapshots, handoff acknowledgements, budgets, and last verification. Mark in-flight tasks `interrupted`; accepted verified slices are not rerun, unverified writes are inspected before repair/rollback.

- [ ] **Step 5: Run full Stage 05 verification**

```bash
npm test -- --run packages/development/test packages/verification/test packages/dependency-governance/test tests/e2e/new-project-simulated-harness.test.ts tests/e2e/existing-dirty-project.test.ts tests/e2e/existing-mysql-preservation.test.ts tests/e2e/development-recovery.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all pass with zero unapproved dependency/migration commands and zero outside-ownership writes.

- [ ] **Step 6: Document and commit**

```bash
git add packages/development tests/e2e docs/operations/development-recovery.md
git commit -m "test: prove safe development and recovery flows"
```

## Stage 05 completion gate

Proceed only when the product `WorkspaceNodeRuntime`, product-local NVM bootstrap, exact version × macOS architecture manifest catalog/resolver, and isolation tests pass before every project command; no product path sources a host/user-global NVM loader; new-project `24.19.0` and existing-project `20.20.0` resolve through reviewed per-architecture manifests; and an unmatched selection fails before download/command. The simulated new project then reaches verified output, the dirty existing project preserves user changes, the existing MySQL project retains its stack, dependency/security gates block unsafe additions, tester roles cannot modify implementation, all requirements map to evidence, and every interruption resumes from the last verified slice without fake success. This gate proves application behavior with mocks, not production Harness registration or a real Agent/approval/event binding. Missing product runtime evidence also blocks Stage 07 release.
