# Backend Agent Team Stage 02: Official Spec Kit Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workspace-isolated official Spec Kit workflow that creates requirements and design artifacts, pauses at two hash-bound approval gates, invalidates stale approvals, and resumes safely.

**Architecture:** `RuntimeInstaller` creates a user-approved local uv/Python environment under `.backend-team/`; `SpecKitAdapter` invokes the official `specify-cli` from that environment and loads official commands through Spec Kit's `generic` integration. Backend Team owns artifact validation, extensions, approvals, state transitions, and recovery, while never replacing official Spec Kit behavior.

**Tech Stack:** TypeScript, workspace-local uv 0.12.3, uv-managed Python 3.13.15, official GitHub Spec Kit tag `v0.16.5`, Zod, Vitest.

**Implementation status (2026-08-27):** Tasks 1–7 are implemented on `codex/stage-02-spec-kit-workflow`. The exact runtime-install approval `4b9755c38d7a73c025dda49c4b244f02a989e1239d234f87982ccc8afb08eee0` and exact `spec-kit-init` approval `d102cca00f38eba3b5c660396cf3a04af950e1f94b9bfd93e8c0ae5b7cc5d7e1` were explicitly supplied and consumed. The persistent isolated gate recorded uv `0.12.3`, Python `3.13.15`, Spec Kit `0.16.5`, generic integration, and unchanged outside-workspace snapshots. Final Node 24.19.0 verification: 45 test files passed, 1 external gate visibly skipped, 528 tests passed.

**Spec:** `docs/superpowers/specs/2026-08-25-backend-agent-team-design.md`

## Global Constraints

- Follow the master plan and completed Stage 01 contracts exactly.
- Never inspect or invoke a host-global `python`, `python3`, `pip`, `pipx`, `uv`, or `specify` as a fallback.
- Installing uv, Python, or Spec Kit requires an `install` approval token bound to exact artifacts, versions, destinations, bytes, and commands.
- uv, Python, virtual environment, tools, commands, and cache stay under `.backend-team/`.
- Spec Kit self-upgrade is disabled; version changes occur only through a reviewed runtime manifest change.
- Use official `specify init --integration generic`; do not claim DeepSeek Harness is an official built-in Spec Kit integration.
- Requirements approval allows design only. Design approval allows planning/build, subject to action-specific safety gates.

---

### Task 1: Define runtime manifests and installation consent

**Files:**
- Create: `runtime-manifests/uv-0.12.3.json`
- Create: `runtime-manifests/spec-kit-0.16.5.json`
- Create: `packages/policy-engine/src/install-session.ts`
- Create: `packages/policy-engine/test/install-session.test.ts`
- Modify: `packages/policy-engine/src/index.ts`
- Modify: `packages/platform-macos/src/artifact-downloader.ts`
- Modify: `packages/platform-macos/src/node-command-runner.ts`
- Modify: `packages/platform-macos/src/index.ts`
- Test: `packages/platform-macos/test/node-command-runner.test.ts`
- Create: `packages/spec-workflow/package.json`
- Create: `packages/spec-workflow/tsconfig.json`
- Create: `packages/spec-workflow/src/runtime-manifest.ts`
- Create: `packages/spec-workflow/src/install-plan.ts`
- Create: `packages/spec-workflow/src/index.ts`
- Test: `packages/spec-workflow/test/runtime-manifest.test.ts`
- Test: `packages/spec-workflow/test/install-plan.test.ts`
- Modify: `scripts/build-workspaces.mjs`
- Test: `tests/integration/build-workspace-order.test.ts`

**Interfaces:**
- Consumes: `WorkspaceLayout`, `ApprovalTokenService`, Stage 01's internal `ArtifactDownloader`, `NodeCommandRunner`, and `CommandRunner`.
- Produces: `RuntimeManifest`, `InstallPlan`, `InstallPlanBuilder`, `InstallApprovalDigest`, `InstallSessionService`, a callback-scoped `ApprovedInstallSession`, and the now-guarded public platform artifact adapter.
- `InstallSessionService.execute()` consumes one token bound to the canonical full `InstallPlan`, exposes only the plan's exact artifact and command operations during its callback, and permanently revokes the session in `finally`. It re-authorizes each concrete operation immediately before the platform side effect. The session cannot be reused for another install plan or for `specify init`.

- [ ] **Step 1: Write failing manifest and consent tests**

```ts
it('selects the exact official uv artifact for the current architecture', () => {
  expect(selectUvArtifact(manifest, 'arm64').sha256)
    .toBe('546f7f8a6c70ff13a3a9d2bc958db3427298cebf3e0cb756f9177133b7068843')
  expect(selectUvArtifact(manifest, 'x64').sha256)
    .toBe('4c9f52262a14da336e4a42ed24992d12d0c956acde87619e4611d321dffa602b')
})

it('binds consent to destination and every command', () => {
  const a = buildInstallPlan(layout, manifests)
  const b = { ...a, destination: '/tmp/global-bin' }
  expect(installApprovalDigest(a)).not.toBe(installApprovalDigest(b))
})
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- --run packages/spec-workflow/test/runtime-manifest.test.ts packages/spec-workflow/test/install-plan.test.ts`

Expected: FAIL with missing manifest parser and plan builder.

- [ ] **Step 3: Add exact official uv artifacts**

`uv-0.12.3.json` contains only these two entries:

```json
{
  "version": "0.12.3",
  "license": "Apache-2.0 OR MIT",
  "source": "https://github.com/astral-sh/uv/releases/tag/0.12.3",
  "artifacts": {
    "darwin-arm64": {
      "url": "https://releases.astral.sh/github/uv/releases/download/0.12.3/uv-aarch64-apple-darwin.tar.gz",
      "bytes": 17686637,
      "sha256": "546f7f8a6c70ff13a3a9d2bc958db3427298cebf3e0cb756f9177133b7068843"
    },
    "darwin-x64": {
      "url": "https://releases.astral.sh/github/uv/releases/download/0.12.3/uv-x86_64-apple-darwin.tar.gz",
      "bytes": 19547702,
      "sha256": "4c9f52262a14da336e4a42ed24992d12d0c956acde87619e4611d321dffa602b"
    }
  }
}
```

`spec-kit-0.16.5.json` pins Python `3.13.15`, the official Spec Kit `0.16.5` wheel, its complete macOS/Python 3.13 runtime-wheel closure, CLI executable `specify`, and expected CLI version `0.16.5`. Each selected runtime artifact records component name/version/license, canonical source, HTTPS URL and redirect hosts, exact byte size, SHA-256, and a unique workspace-relative destination. The official PyPI wheel is used instead of an online Git install because Spec Kit documents PyPI as an official distribution route matching the GitHub release tag; the source remains the open-source `github/spec-kit` release.

- [ ] **Step 4: Implement the install-plan digest**

The user-facing plan and approval digest cover tool name, version, source, license, exact bytes, SHA-256, a unique workspace-relative destination for every artifact, exact executable/args/environment, every redirect host, and whether code will execute. Reject duplicate, absolute, symlinked, or escaping destinations before requesting approval. A command that can resolve or download an unlisted transitive artifact is not an exact runtime-install plan.

- [ ] **Step 5: Implement the concrete guarded install session**

Add a policy-engine-owned session service around `ApprovalTokenService`. Derive the token action from the canonical full plan digest; consume it once before the callback; expose structurally compatible artifact-fetch and command-execution capabilities only inside that callback; match every artifact field and every `CommandRequest` field exactly; authorize each actual redirect URL only when its HTTPS host is among the approved hosts and every other artifact field remains unchanged; retain the executable identity/content checks used by `NodeCommandRunner`; and revoke the session even when the callback throws or is aborted. Tests must prove altered URL/host/destination/bytes/hash/command/env/cwd/fingerprint are rejected with zero fetch/spawn calls, redirects are limited to the approved host set, a second use fails, and leaked capabilities fail after callback completion.

Only after these tests pass, export `ArtifactDownloader` and its manifest/capability types from `@dsh-backend-team/platform-macos`. Add a guarded install-session runner path to `NodeCommandRunner`; do not add a permissive default or a token-bypass option.

- [ ] **Step 6: Add the package to clean-build orchestration**

Add `@dsh-backend-team/spec-workflow` after `@dsh-backend-team/platform-macos` and before the Bundle to `scripts/build-workspaces.mjs`; extend the build-order regression test so a checkout without stale `dist` output proves the dependency order.

- [ ] **Step 7: Run tests and commit**

```bash
npm test -- --run packages/spec-workflow/test/runtime-manifest.test.ts packages/spec-workflow/test/install-plan.test.ts packages/policy-engine/test/install-session.test.ts packages/platform-macos/test/node-command-runner.test.ts tests/integration/build-workspace-order.test.ts
npm run typecheck
git add runtime-manifests packages/spec-workflow packages/policy-engine packages/platform-macos scripts/build-workspaces.mjs tests/integration/build-workspace-order.test.ts package.json package-lock.json
git commit -m "feat: define approved local runtime manifests"
```

---

### Task 2: Install workspace-local uv, Python, and official Spec Kit

**Files:**
- Create: `packages/spec-workflow/src/runtime-environment.ts`
- Create: `packages/spec-workflow/src/uv-installer.ts`
- Create: `packages/spec-workflow/src/spec-kit-installer.ts`
- Modify: `packages/spec-workflow/src/index.ts`
- Test: `packages/spec-workflow/test/runtime-environment.test.ts`
- Test: `packages/spec-workflow/test/uv-installer.test.ts`
- Test: `packages/spec-workflow/test/spec-kit-installer.test.ts`

**Interfaces:**
- Consumes: `InstallPlan`, `InstallSessionService`, the guarded public platform artifact adapter, `CommandRunner`, `WorkspaceLayout`, and one install approval token for that exact runtime-install plan. This task is blocked until Task 1's exact-scope, revocation, command-identity, and redirect tests pass.
- Produces: public `buildRuntimeEnvironment(layout): Readonly<Record<string,string>>` plus package-internal `UvInstaller.ensureInstalled()` and `SpecKitInstaller.ensureInstalled()` reached only through the strict production gate. Raw installers/options are not exported because a public constructor accepting caller-built manifests would bypass the official strict-pin parser.

- [ ] **Step 1: Write failing environment and command tests**

```ts
it('redirects every uv-controlled path into the workspace', () => {
  const env = buildRuntimeEnvironment(layout)
  expect(env.HOME).toBe(layout.teamDir)
  expect(env.TMPDIR).toBe(layout.cacheDir)
  expect(env.XDG_CACHE_HOME).toBe(layout.cacheDir)
  expect(env.XDG_CONFIG_HOME).toBe(layout.stateDir)
  expect(env.XDG_DATA_HOME).toBe(layout.runtimeDir)
  expect(env.XDG_STATE_HOME).toBe(layout.stateDir)
  expect(env.UV_CACHE_DIR).toBe(`${layout.cacheDir}/uv`)
  expect(env.UV_PYTHON_INSTALL_DIR).toBe(`${layout.runtimeDir}/python`)
  expect(env.UV_PYTHON_BIN_DIR).toBe(`${layout.runtimeDir}/bin`)
  expect(env.UV_PYTHON_INSTALL_BIN).toBe('0')
  expect(env.UV_TOOL_DIR).toBe(`${layout.runtimeDir}/uv-tools`)
  expect(env.UV_TOOL_BIN_DIR).toBe(`${layout.runtimeDir}/bin`)
  expect(env.UV_NO_SYSTEM_CONFIG).toBe('1')
  expect(env.UV_NO_CONFIG).toBe('1')
  expect(env.UV_OFFLINE).toBe('1')
  expect(env.UV_PYTHON_DOWNLOADS).toBe('manual')
  expect(env.UV_PYTHON_INSTALL_MIRROR).toBe(`file://${layout.cacheDir}/python-mirror`)
})

it('creates Spec Kit through the pinned venv interpreter', async () => {
  await installer.ensureInstalled(approvedPlan)
  expect(runner.requests.map(({ executable, args }) => [executable, args])).toEqual([
    [localUv, ['python', 'install', '3.13.15']],
    [localUv, ['venv', specVenv, '--python', '3.13.15']],
    [specPython, ['--version']],
    [localUv, ['pip', 'install', '--offline', '--no-index', '--no-deps', '--python', specPython, ...exactApprovedWheelPaths]],
    [localUv, ['pip', 'check', '--python', specPython]],
    [localSpecify, ['--version']],
  ])
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/spec-workflow/test/runtime-environment.test.ts packages/spec-workflow/test/uv-installer.test.ts packages/spec-workflow/test/spec-kit-installer.test.ts`

Expected: FAIL with missing installers.

- [ ] **Step 3: Implement the isolated environment**

Set `PATH` for child processes to `.backend-team/runtime/bin` plus the minimal inherited system paths `/usr/bin:/bin:/usr/sbin:/sbin`; do not prepend user package-manager paths. Also set:

```text
HOME=.backend-team
TMPDIR=.backend-team/cache
XDG_CACHE_HOME=.backend-team/cache
XDG_CONFIG_HOME=.backend-team/state
XDG_DATA_HOME=.backend-team/runtime
XDG_STATE_HOME=.backend-team/state
UV_PROJECT_ENVIRONMENT=.backend-team/runtime/spec-kit/.venv
UV_CACHE_DIR=.backend-team/cache/uv
UV_PYTHON_INSTALL_DIR=.backend-team/runtime/python
UV_PYTHON_BIN_DIR=.backend-team/runtime/bin
UV_PYTHON_INSTALL_BIN=0
UV_TOOL_DIR=.backend-team/runtime/uv-tools
UV_TOOL_BIN_DIR=.backend-team/runtime/bin
UV_NO_SYSTEM_CONFIG=1
UV_NO_CONFIG=1
UV_NO_MODIFY_PATH=1
UV_PYTHON_PREFERENCE=only-managed
UV_PYTHON_DOWNLOADS=manual
UV_PYTHON_INSTALL_MIRROR=file://<workspace>/.backend-team/cache/python-mirror
UV_OFFLINE=1
PIP_CONFIG_FILE=/dev/null
PYTHONNOUSERSITE=1
```

Convert every workspace-relative value above to an absolute path by joining it to the canonical target workspace; reject any result whose real path escapes that workspace.

- [ ] **Step 4: Implement uv extraction and identity verification**

Download the selected archive only after consuming the install approval. Parse the official tar layout in memory and accept exactly the architecture root directory (`uv-aarch64-apple-darwin/` or `uv-x86_64-apple-darwin/`) plus its `uv` and `uvx` regular files; reject every additional directory, file, link, or special entry. Publish `uv` and `uvx` to `.backend-team/runtime/bin`, set mode `0o700`, and run the absolute local executable with `--version`. Strictly parse the official v0.12.3 display form, including the matching `aarch64-apple-darwin` or `x86_64-apple-darwin` target and only the official optional commit-count/hash/date fields.

- [ ] **Step 5: Implement Python and Spec Kit installation**

Before the first Python command, require the production manifest parser to reject unknown keys at the composite, tool, artifact-container, and individual-artifact layers and to match the reviewed official tuple for every artifact—component, version, license, source, URL, exact bytes, SHA-256, ordered redirect hosts, and destination—then fetch every approved Python/Spec Kit artifact through the policy-owned downloader into its exact destination and re-verify file identity, exact size, and SHA-256. The callback-scoped artifact capability must cover cache verification and the complete request/body/hash/write/fsync/publish or cleanup lifetime; redirects require a fresh approved scope without ending the enclosing operation early. Place the pinned Python archive in the local `file://` mirror layout expected by uv. Use the exact commands asserted by the test: `uv python install` may read only that local mirror; the Spec Kit installation passes every exact wheel path explicitly with `--offline --no-index --no-deps`, then runs `uv pip check` to prove the pinned closure is complete. No uv command may access GitHub, PyPI, user configuration, or an unlisted cache during execution. Every runtime and `specify init` command carries a plan-bound deny-network policy and the macOS runner must enforce it with an OS process sandbox; absence or failure of that boundary blocks before spawning the approved executable.

After creating the venv, require the logical executable path to be exactly `.venv/bin/python`; allow its canonical target only inside that venv or the pinned `.backend-team/runtime/python` managed installation, because uv normally creates the venv interpreter as a symlink to its managed Python. Strictly validate uv 0.12.3's `pyvenv.cfg` semantics: `version_info = 3.13.15`, `implementation = CPython`, `uv = 0.12.3`, `include-system-site-packages = false`, and an absolute `home` resolving inside the workspace-managed Python tree. Run that exact workspace-owned interpreter with `--version`, and reject any output other than exact Python `3.13.15` version evidence. After install, require `.venv/bin/specify` to resolve inside the same venv, run the official root callback `specify --version`, and require the exact output `specify 0.16.5`; do not parse the human-oriented `specify version` Rich panel. Set `PYTHONDONTWRITEBYTECODE=1`, then record provenance schema 3 with the complete verified artifact inventory, parsed uv/interpreter/Spec Kit versions, Python and Specify executable hashes, canonical tree digests for the complete workspace-managed Python tree and venv (including `pyvenv.cfg`, bin links, `.pth`, and all site-packages), the exact commands that actually completed, an explicit offline-install marker, and completion time; never persist raw stdout/stderr. Reject symlink escape, special files, and hard-linked files in those execution trees. On reuse, validate provenance, both tree digests, and executable hashes before running any installed code. The recovery path derives uv identity from the exact approved archive and plan without execution; if the Spec Kit runtime is incomplete and installation must continue, it first performs the approved `uv --version` command and records that real completion, while a complete existing runtime validates provenance without any repeat process.

Run the download and every command inside one `InstallSessionService.execute()` callback. The callback receives the only artifact and command capabilities that may perform these side effects. No raw approval token is forwarded to the installers, and no capability may remain usable after the callback returns or throws.

- [ ] **Step 6: Prove no host fallback**

Add tests where `PATH` contains fake global `python`, `uv`, and `specify` executables that throw if invoked. Run:

```bash
npm test -- --run packages/spec-workflow/test
npm run typecheck
```

Expected: tests pass and fake global executables record zero calls.

Also prove that a removed/added/replaced wheel, altered destination, altered license/source/version, missing transitive dependency, project-local uv configuration, or any non-offline install command fails before Python or Spec Kit execution. The approval-only real gate must list the complete composite runtime plan and remain blocked until its new digest is explicitly approved.

- [ ] **Step 7: Commit**

```bash
git add packages/spec-workflow
git commit -m "feat: install spec kit in workspace-local uv environment"
```

---

### Task 3: Initialize the official generic integration and load official commands

**Files:**
- Create: `packages/spec-workflow/src/spec-kit-adapter.ts`
- Create: `packages/spec-workflow/src/spec-kit-command-loader.ts`
- Create: `packages/spec-workflow/src/spec-kit-project.ts`
- Modify: `packages/spec-workflow/src/index.ts`
- Test: `packages/spec-workflow/test/spec-kit-adapter.test.ts`
- Test: `packages/spec-workflow/test/spec-kit-command-loader.test.ts`
- Test: `tests/integration/spec-kit-real-cli.test.ts`

**Interfaces:**
- Consumes: opaque verified `InstalledSpecKit` evidence from Task 2, `CommandRunner`, `WorkspaceLayout`.
- Produces: `SpecKitAdapter.prepareInitialization()`, `SpecKitAdapter.initialize(prepared, approvalToken)`, `SpecKitAdapter.status()`, `SpecKitCommandLoader.load(command, args)`, and `LoadedSpecKitCommand`.

- [ ] **Step 1: Write failing adapter tests**

```ts
it('initializes the official generic integration into the Team runtime', async () => {
  const prepared = await adapter.prepareInitialization()
  await adapter.initialize({ prepared, approvalToken: token })
  expect(runner.lastRequest.args).toEqual([
    'init', '--here', '--force', '--non-interactive', '--script', 'sh', '--integration', 'generic',
    '--integration-options=--commands-dir .backend-team/runtime/spec-kit/commands',
    '--ignore-agent-tools',
  ])
})

it('substitutes only the documented argument marker', async () => {
  const loaded = await loader.load('speckit.specify', 'Build users API')
  expect(loaded.prompt).toContain('Build users API')
  expect(loaded.prompt).not.toContain('$ARGUMENTS')
  expect(loaded.sourceRealPath).toMatch(/\.backend-team\/runtime\/spec-kit\/commands/)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/spec-workflow/test/spec-kit-adapter.test.ts packages/spec-workflow/test/spec-kit-command-loader.test.ts`

Expected: FAIL with missing adapter.

- [ ] **Step 3: Implement guarded preparation and initialization**

Preparation must run before approval issuance. It consumes opaque verified Task 2 `InstalledSpecKit` evidence and produces one immutable prepared object whose canonical install plan/digest binds the verified `specify` content SHA-256, exact command, complete explicit managed roots, stable exact-byte/tree snapshots, and the two execution-closure digests for `.backend-team/runtime/python` plus `.backend-team/runtime/spec-kit/.venv`. For pinned official v0.16.5 with no preset or extensions, the source-derived managed roots are `.specify/` (integration manifest, shared infrastructure, workflow, init options, scripts, templates, and constitution) and `.backend-team/runtime/spec-kit/commands/` (generic integration output); a reviewed version change must update this list. The exact macOS agent-harness command also includes `--non-interactive --script sh` so PTY/default detection cannot change behavior.

Initialization accepts only that prepared object plus a new token for its exact `spec-kit-init` digest, separate from the runtime-install approval. Before token consumption and again immediately before spawn inside the fresh callback-scoped install session, revalidate the opaque installed evidence, `specify` content hash, both execution-closure tree digests, canonical workspace confinement, and a fresh managed-tree snapshot byte-for-byte/identity-for-identity against the prepared plan; reject any divergence. Extend the shared install-plan schema/policy validation just enough to snapshot and bind these managed preconditions, runtime closure, and the expected executable SHA-256. After the CLI exits, recheck the runtime closure, require `.specify/`, `.specify/integration.json`, and the generic commands directory. Parse `integration.json` with a strict small byte limit and the pinned official v0.16.5 schema: exact top-level fields `version`, `integration_state_schema`, `installed_integrations`, `integration_settings`, `integration`, and `default_integration`; require version `0.16.5`, schema `1`, only installed/default integration `generic`, and exact generic settings for script `sh`, the approved raw/parsed commands directory, and invoke separator `.`. Persist only bounded/redacted diagnostics on failure.

- [ ] **Step 4: Implement command loading without private Python imports**

Discover the generated command file by normalized command ID, resolve its real path below the configured generic commands directory, read UTF-8 with a 1 MiB limit, replace only the official `$ARGUMENTS` marker, and return source hash plus prompt. Do not execute Markdown, shell snippets, or Python from the loader.

- [ ] **Step 5: Run a real local CLI integration test**

Implement the complete conditionally enabled gate without performing the real operation yet. With a new exact runtime-install approval and a separate new exact initialization approval in an isolated temporary workspace, run the actual pinned local CLI initialization. Assert official files exist, the command loader can load `speckit.specify`, `speckit.clarify`, `speckit.plan`, `speckit.tasks`, `speckit.analyze`, and no files appear outside the fixture workspace. Stop and obtain those exact approvals before the test first downloads or executes external code; earlier design confirmation is not sufficient. Without those external approval materials, the dedicated gate invocation must emit a machine-readable `BLOCKED` result and exit non-zero; it may be visibly skipped in the ordinary offline unit suite, but cannot silently count as release evidence.

Run: `DSH_REQUIRE_REAL_SPEC_KIT_GATE=1 npm test -- --run tests/integration/spec-kit-real-cli.test.ts`

Expected: PASS; if network artifacts are unavailable, report `blocked` and retain the install plan, never substitute a mock as real evidence.

- [ ] **Step 6: Commit**

```bash
git add packages/spec-workflow tests/integration/spec-kit-real-cli.test.ts
git commit -m "feat: execute official spec kit generic integration"
```

---

### Task 4: Add Backend Team artifact extensions and validation

**Files:**
- Create: `templates/spec-kit/clarification.md`
- Create: `templates/spec-kit/architecture.md`
- Create: `templates/spec-kit/data-model.md`
- Create: `templates/spec-kit/test-plan.md`
- Create: `templates/spec-kit/decisions.md`
- Create: `templates/spec-kit/contracts/openapi.yaml`
- Create: `packages/spec-workflow/src/artifact-registry.ts`
- Create: `packages/spec-workflow/src/artifact-validator.ts`
- Modify: `packages/spec-workflow/src/index.ts`
- Test: `packages/spec-workflow/test/artifact-registry.test.ts`
- Test: `packages/spec-workflow/test/artifact-validator.test.ts`

**Interfaces:**
- Consumes: feature directory from `.specify/feature.json` or `SPECIFY_FEATURE_DIRECTORY`.
- Produces: `FeatureArtifacts`, `ArtifactRegistry.snapshot()`, `ArtifactValidator.validateForGate(gate)`.

- [ ] **Step 1: Write failing gate-validation tests**

```ts
it('requires behavioral acceptance criteria before requirements approval', async () => {
  await fixture.write('spec.md', '# Feature\n\n## User Scenarios\n')
  const result = await validator.validateForGate('requirements')
  expect(result.errors.map(error => error.code)).toContain('MISSING_ACCEPTANCE_CRITERIA')
})

it('requires table constraints and API contract before design approval', async () => {
  await fixture.writeValidRequirements()
  const result = await validator.validateForGate('design')
  expect(result.errors.map(error => error.code)).toEqual(expect.arrayContaining([
    'MISSING_ARCHITECTURE', 'MISSING_DATA_MODEL', 'MISSING_OPENAPI', 'MISSING_TEST_PLAN',
  ]))
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/spec-workflow/test/artifact-registry.test.ts packages/spec-workflow/test/artifact-validator.test.ts`

Expected: FAIL with missing registry.

- [ ] **Step 3: Write concrete extension templates**

Each template contains required headings and guidance, not empty markers. `architecture.md` requires context, module boundaries, request flow, API/auth, failure model, observability, alternatives, and risks. `data-model.md` validation requires table purpose, field type/null/default, keys, constraints, indexes, relationships, lifecycle, sensitive data, and migration notes. `test-plan.md` requires requirement ID, evidence type, command/scenario, expected result, and status.

- [ ] **Step 4: Implement feature resolution and snapshots**

Resolve the active feature from `SPECIFY_FEATURE_DIRECTORY` first, then `.specify/feature.json`; require the canonical directory to remain under the target workspace's `specs/` directory. Snapshot exact bytes and SHA-256 for all present official and extension artifacts using byte hashing, not canonical-JSON hashing, and report missing required artifacts explicitly.

- [ ] **Step 5: Implement gate-specific semantic checks**

Requirements gate requires `spec.md` plus `clarification.md`, actors, flows, rules, permissions, data/privacy, integrations, non-functional requirements, non-goals, and numbered acceptance criteria. Design gate additionally requires `plan.md`, `architecture.md`, `data-model.md`, valid OpenAPI 3.1 YAML, `test-plan.md`, and `decisions.md`. Errors include file and heading so the requirements/design expert can repair them.

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- --run packages/spec-workflow/test/artifact-registry.test.ts packages/spec-workflow/test/artifact-validator.test.ts
npm run typecheck
git add templates packages/spec-workflow
git commit -m "feat: validate backend specification artifacts"
```

---

### Task 5: Implement the two approval gates and downstream invalidation

**Files:**
- Create: `packages/core/src/approval-service.ts`
- Create: `packages/core/src/artifact-invalidation.ts`
- Modify: `packages/core/src/state-machine.ts`
- Test: `packages/core/test/approval-service.test.ts`
- Test: `packages/core/test/artifact-invalidation.test.ts`

**Interfaces:**
- Consumes: structural `ArtifactRegistryPort` and `ArtifactValidatorPort` interfaces implemented by spec-workflow, `StateStore`, and `BackendTeamOrchestrationPort.requestApproval()`; core does not import `@dsh-backend-team/spec-workflow`.
- Produces: `ApprovalService.requestRequirementsApproval()`, `requestDesignApproval()`, `verifyActiveApproval()`, `invalidateChangedArtifacts()`.

- [ ] **Step 1: Write failing approval and invalidation tests**

```ts
it('advances only when the approved hashes still match', async () => {
  await service.requestRequirementsApproval()
  await fixture.append('spec.md', '\nChanged after approval')
  await expect(service.verifyActiveApproval('requirements')).rejects.toThrow('approval is stale')
})

it('invalidates design, plan, build and verification after a requirements edit', async () => {
  const next = invalidateChangedArtifacts(approvedState, ['specs/001-x/spec.md'])
  expect(next.phase).toBe('SPECIFY')
  expect(next.approvals).toEqual([])
  expect(next.runs.filter(run => run.kind !== 'requirements')).toHaveLength(0)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/core/test/approval-service.test.ts packages/core/test/artifact-invalidation.test.ts`

Expected: FAIL with missing services.

- [ ] **Step 3: Implement approval summaries and records**

The application approval request includes a plain-language summary and exact artifact hash list; the surrounding coordinator view supplies artifact links, unresolved warnings, approval effect, and reject/edit/approve choices. Persist an approval only after the injected `BackendTeamOrchestrationPort` returns `approve`; create it and advance the phase in one state transaction. Stage 02 tests use `MockBackendTeamOrchestrationPort`; no real Harness approval API is claimed. Stage 07 Task 2 owns the production control-mediated approval implementation and its authenticated host/session provenance gate.

- [ ] **Step 4: Implement deterministic invalidation**

Map source files to the earliest affected phase. A requirements artifact edit returns to `SPECIFY` and removes requirements/design approvals plus later runs. A design artifact edit returns to `DESIGN` and removes design approval plus plan/build/verify runs. A `tasks.md` edit after design returns to `PLAN` but keeps design approval if no approved design file changed.

- [ ] **Step 5: Run focused/full tests and commit**

```bash
npm test -- --run packages/core/test
npm test
npm run typecheck
git add packages/core
git commit -m "feat: enforce hash-bound specification approvals"
```

---

### Task 6: Orchestrate requirements and design through official Spec Kit prompts

**Files:**
- Create: `packages/core/src/specification-coordinator.ts`
- Create: `packages/core/src/context-packet.ts`
- Create: `presets/experts/requirements.yaml`
- Create: `presets/experts/backend-architect.yaml`
- Create: `presets/experts/database-designer.yaml`
- Create: `presets/experts/oss-researcher.yaml`
- Test: `packages/core/test/specification-coordinator.test.ts`
- Test: `packages/core/test/context-packet.test.ts`
- Test: `tests/integration/specification-flow.test.ts`

**Interfaces:**
- Consumes: structural `SpecKitCommandLoaderPort` and `ArtifactValidatorPort` interfaces implemented by spec-workflow, `BackendTeamOrchestrationPort`, `ApprovalService`, `StateStore`; core does not import `@dsh-backend-team/spec-workflow`.
- Produces: `SpecificationCoordinator.start(request)`, `refine(answer)`, `approveRequirements()`, `design()`, `approveDesign()`.

- [ ] **Step 1: Write the failing full-flow test**

```ts
it('stops at both approval gates before planning', async () => {
  const flow = createSpecificationFixture()
  await flow.start('Build a tenant-aware order API')
  expect(flow.phase()).toBe('AWAIT_REQUIREMENTS_APPROVAL')
  expect(flow.businessCodeWrites()).toEqual([])
  await flow.approveRequirements()
  await flow.design()
  expect(flow.phase()).toBe('AWAIT_DESIGN_APPROVAL')
  expect(flow.businessCodeWrites()).toEqual([])
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/core/test/specification-coordinator.test.ts tests/integration/specification-flow.test.ts`

Expected: FAIL with missing coordinator.

- [ ] **Step 3: Define exact expert presets**

Each YAML preset declares role, read/write paths, tools, non-goals, required inputs, output files, evidence, and budget. Requirements writes only `spec.md`/`clarification.md`; architecture roles write only design artifacts; OSS research writes `research.md`/`decisions.md`. None receives a business-code write tool.

- [ ] **Step 4: Implement just-in-time context packets**

Each packet contains task objective, official Spec Kit prompt source/hash, relevant approved artifacts, required output schema, path ownership, tool policy summary, and budget. Exclude unrelated repository files, credentials, runtime logs, and previous raw Agent conversations.

- [ ] **Step 5: Implement the phase coordinator**

`start()` loads official `speckit.specify`; refinement uses official `speckit.clarify`; design loads official `speckit.plan` then dispatches architecture/database/OSS roles; task creation uses official `speckit.tasks` only after design approval. Every expected output is validated before requesting approval. Agent spawn remains scripted through `MockBackendTeamOrchestrationPort` in application stages; the coordinator depends only on `BackendTeamOrchestrationPort.spawnAgent()`, not on an asserted Harness host method. Stage 07 Task 2 owns the production Agent spawn/result/cancel/usage binding and blocks release until its exact public official API/provenance gate passes.

- [ ] **Step 6: Run full tests and commit**

```bash
npm test -- --run packages/core/test tests/integration/specification-flow.test.ts
npm run typecheck
npm run lint
git add packages/core presets tests/integration/specification-flow.test.ts
git commit -m "feat: orchestrate approved spec kit workflow"
```

---

### Task 7: Add interruption recovery and prove no global pollution

**Files:**
- Create: `packages/core/src/specification-recovery.ts`
- Test: `packages/core/test/specification-recovery.test.ts`
- Create: `tests/integration/spec-kit-isolation.test.ts`
- Create: `tests/integration/specification-recovery.test.ts`
- Create: `docs/operations/spec-kit-runtime.md`

**Interfaces:**
- Consumes: persisted state, runtime provenance, current artifact hashes, `.specify/feature.json`.
- Produces: `SpecificationRecovery.audit()`, `resumeFromLastVerified()`, Stage 02 evidence.

- [ ] **Step 1: Write failing parameterized recovery tests**

Interrupt after each of: CLI install, Spec Kit init, requirement generation, requirement approval, design generation, and design approval. On resume assert `running` becomes `interrupted`, the last verified phase is retained, stale approval hashes are rejected, and completed CLI installation is not repeated.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/core/test/specification-recovery.test.ts tests/integration/specification-recovery.test.ts`

Expected: FAIL with missing recovery audit.

- [ ] **Step 3: Implement recovery audit and cleanup**

Validate state schema/revision, runtime provenance, executable real paths, Spec Kit version, active feature path, artifact hashes, and managed lock/process identity. Remove only stale locks whose owner process is absent and whose nonce/path match the recorded Team state. Resume at the last verified state; never infer approval from an artifact's existence.

- [ ] **Step 4: Prove workspace-only behavior**

After obtaining the exact install/init approvals, the isolation test snapshots the fixture workspace parent, a fake home directory, and fake global bin directories before/after a real uv/Python/Spec Kit install and two-gate flow. It fails on any new or changed path outside the fixture workspace and asserts no system service or shell profile file was touched. Until those approvals exist, report this external evidence as `blocked`; never replace it with a mock pass.

- [ ] **Step 5: Document operator-visible recovery**

`spec-kit-runtime.md` records locations, permission prompts, expected download sizes, version inspection, stop/resume behavior, upgrade process, safe removal, and the rule that manual deletion of `.backend-team/state` loses approval history.

- [ ] **Step 6: Run the Stage 02 gate and commit**

```bash
npm test -- --run packages/spec-workflow/test packages/core/test tests/integration/spec-kit-real-cli.test.ts tests/integration/spec-kit-isolation.test.ts tests/integration/specification-flow.test.ts tests/integration/specification-recovery.test.ts
npm test
npm run typecheck
npm run lint
npm run build
git add packages/core tests/integration docs/operations/spec-kit-runtime.md
git commit -m "test: prove isolated recoverable spec workflow"
```

## Stage 02 completion gate

Proceed only when the real pinned official CLI initializes through the generic integration, both approval gates bind to exact hashes, every tested interruption resumes safely, fake global tools receive zero calls, and the filesystem isolation test observes no write outside the target workspace.
