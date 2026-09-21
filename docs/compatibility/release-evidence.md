# Release evidence

This file records the current Stage 07 release boundary. A green local check is
not promoted to release evidence unless it runs against the required native
Profile, official Harness seam, browser, or credential-gated model.

| Gate | Current evidence | Status |
| --- | --- | --- |
| Workspace-local Node/runtime | `.backend-team/runtime` and workspace NVM checks | passed locally |
| Application orchestration | persisted events, revision-fenced state/event bridge, explicit approvals, verified Agent adapter/decoder, durable budget recovery | passed by package/integration tests |
| Harness Agent lifecycle | `npm run verify:agent-runtime` on rc.6 headless Profile with a local probe model and workspace `HarnessAgentRuntime` | passed for adapter/lifecycle smoke only |
| Managed development file tools | Mandatory production Agent setup installs scoped native presentation and identity-bound read/write tools; actual descriptor I/O, ownership leases and patch evidence verified through Codex Chrome | passed for isolated managed I/O; commands, specification agents and full default Profile assembly remain unavailable |
| Web client asset route | `npm run verify:web-client` and packed Bundle inspection | passed for diagnostic client route |
| Browser client module/overlay smoke | Codex Chrome loaded the isolated rc.6 Web Profile, materialized the Bundle client factory, and rendered the additive overlay without console errors | passed for client load; control route remains unavailable in diagnostic mode |
| Full production Bundle/coordinator composition | Core assembles the specification and approval workflow; Bundle supplies durable development controls and a real artifact-file plan loader. Chrome with deterministic agents completes approvals and two slices across pause/recovery. Default official Profile still exposes diagnostic mode; automatic production assembly and real-model acceptance remain missing | blocked |
| PostgreSQL distribution | native Darwin arm64/x64 artifacts, hashes, dependency closure, and external provenance | GitHub Actions Run `35565633720` rebuilt both architectures, completed lifecycle smoke and signed attestation, and published [v0.1.0-rc.1](https://github.com/zhuangdize/dsh-backend-team/releases/tag/v0.1.0-rc.1); public manifest is `status=verified`, while clean consumer Profile installation remains a separate T22/D01 check |
| DbGate lifecycle and GUI | [real Chrome GUI and lifecycle evidence](dbgate-7.2.3-lifecycle.md): table/PK/index/FK/data readback, bounded launcher readiness, protected one-time login, CredentialStore-backed automatic design connection, GUI write isolation and actual production control route; native fixture verifies migration baseline/upgrade/rollback and cleanup; selected runtime security probes pass; PostgreSQL-only profile excludes the Excel connector and `xlsx`; qs 6.16.0 and unused-http security overrides are enforced by the installer | local acceptance passed; fresh network-backed audit and incomplete official production/migration acceptance remain release gates |
| Browser acceptance | Codex Chrome opened the actual rc.6 Web UI at loopback port 3080 using a fresh workspace-local Profile and installed Bundle; official API-key setup and diagnostic overlay rendered | official UI startup passed; full production scenario not run |
| Real DeepSeek model | no key found in inherited environment/default Harness credential file/default or worktree dotenv; custom profiles are not certified | not run; credential unavailable in checked locations |
| Acceptance scenario wiring | `npm test -- --run tests/e2e/backend-team-harness.test.ts` asserts the typed blocker | production execution remains blocked (`UNWIRED_ACCEPTANCE_EXECUTOR`) |
| Full test suite | selected regression suite passes; the nodejs.org-backed template isolation case subsequently passed separately with real install/build/health checks | real Spec Kit gate still requires its prerequisites |

Release scripts fail closed while any required row is blocked or not run. The
diagnostic Bundle therefore exposes only its read-only status capability until
the missing official evidence is attached.

### 2026-09-14 — T21 release-material audit

The release builder now emits three sidecars next to each Bundle archive: a
SHA-256 checksum, a CycloneDX 1.5 SBOM generated from the checked-in
`package-lock.json`, and a materials record. The record binds the archive and
SBOM hashes to the Bundle package metadata, the third-party notice, the
PostgreSQL runtime manifest, the Agent fixture and the reviewed release
evidence. `verify-release.mjs` rechecks those digests and the license notice;
for a `release-candidate` it also requires a verified signature and a stable
HTTPS download URL.

The current local 0.1.0 Bundle material set was regenerated and independently
checked: 256 archive entries, archive SHA-256
`acb8fa1b7f12ab25c16eafb87d0b0a4bc19271dbaf387fc33c35670bd0d64a50`, and a
395-component SBOM with SHA-256
`e054ad2c2a64892187e5f2f845ebd96e1476622a7f7f6d9bd8968f5fc547b772`.
`packages/bundle/LICENSES/THIRD_PARTY_NOTICES.md` is present in the archive,
and the DbGate manifest records the PostgreSQL-only 7.2.3 packages with
GPL-3.0.

The read-only audit is saved at
`.backend-team/artifacts/release-materials-t21-20260915/audit.json`. It keeps
the formal release blocked because the PostgreSQL manifest is still
`pending-native-build` and the local material set is unsigned with no stable
download URL. Both local Darwin archives now exist and have execution
evidence; they are deliberately not promoted to verified release provenance
until an external publisher attaches HTTPS URLs and attestations. The current
PostgreSQL-only DbGate lock has 0 critical, 0 high and 8 moderate findings and
no `xlsx`/Excel connector path.
These are external release inputs; the audit does not synthesize or promote
them.

### 2026-09-14 — T22 arm64 Profile lifecycle smoke

`scripts/profile-lifecycle-smoke.mjs` exercised the official rc.6 DSH commands
against a temporary `DSH_HOME`, Profile, pnpm store and workspace using Node
24.19.0 on arm64. The sequence installed Bundle 0.1.0, loaded its diagnostic
configuration, replaced it with a repacked 0.1.1 archive while retaining one
`backend-team` row, removed and restored 0.1.0 as a rollback check, and removed
the Bundle again. The temporary workspace contained sentinel specification and
state files; both SHA-256 values were unchanged after uninstall.

The machine result is `.backend-team/artifacts/profile-lifecycle-t22-EBa4rL/result.json`.
It records `passed` for each step and explicitly limits “use” to the read-only
diagnostic dump. The upgrade archive keeps the same runtime code and only
changes the package version to test Profile replacement, so this is lifecycle
evidence rather than a production workflow or model acceptance. Browser
production flow, x64, signed release candidate and the ten complete scenarios
remain separate gates.

Current file-plan follow-up (2026-09-06): 151 files / 1107 tests passed with two
workers, excluding the real Spec Kit and network template cases. Build,
typecheck, lint and the 11-file packed Bundle check passed. Chrome exercised
actual six-file plan loading, pause after S1, and recovery of only S2: two patch
begins, four deterministic expert dispatches, two saved slices. Evidence:
`.backend-team/artifacts/file-plan-chrome-evidence.json`. The fixture was stopped.
These dispatches used deterministic adapters and do not certify DeepSeek calls.

The official Profile install failed when its package manager resolved a relative
archive path from the Profile directory. The installer now canonicalizes the
archive before invoking DSH and retains both error streams. A real retry with
the relative command-line path installed successfully; the fresh workspace
Profile started and Chrome reached the official API-key configuration page.
The existing user Profile was not modified. No credentials were found in the
checked locations or supplied during this acceptance run.

The previously network-blocked new-project isolation test subsequently passed
using workspace Node 24.19.0 (116.55 seconds), including fresh target-local runtime
download, dependency installation, typecheck, build and tests. Its temporary
workspace was removed and sentinel host files remained byte-identical. Log:
`.backend-team/artifacts/template-isolation-followup.log`. The real Spec Kit CLI
case remains separate and was not silently treated as passing.

Concurrent recovery follow-up: the production checkpoint store now holds a
workspace run lease across plan loading, checkpoint loading, execution and all
saves. Darwin uses a descriptor-held exclusive lock; owner process termination
releases it through the kernel. Regression covers competing controllers,
competing processes, SIGKILL recovery and release failure. Chrome confirmed a
second controller was rejected while the original completed two slices (two
patch begins, four deterministic dispatches). Evidence:
`.backend-team/artifacts/run-lock-chrome-evidence.json`. The fixture was stopped.
The Harness task prompt now includes the actual AgentResult JSON schema, binds
scheduled task IDs and states that usage accounting is host-owned. Previously it
referred to an unspecified agreed format while the decoder required strict JSON.
Unserializable input now fails before creating a Harness session. Adapter and
decoder regressions pass; real model compliance still needs configured credentials.

This protects cooperative users of the run controller. Managed Agent file-write
enforcement has since been implemented as described below; complete default
Profile assembly is still missing.

Managed I/O follow-up (2026-09-06): 153 test files / 1141 tests passed with two
workers, excluding the real Spec Kit and already separately verified network
template case. Build, workspace typecheck, lint and the packed Bundle check
passed. The official rc.6 local-model probe confirms setup before publication
and disposal afterward (`official-agent-setup-final.log`). Chrome performed
actual authorized update/create and rejected traversal, native shell, host-policy denial and revoked
approval (`managed-tools-chrome-evidence.json`). This fixture uses a host-owned
Agent identity, not a real DeepSeek completion. The final authorization is checked
after snapshot inspection; a transaction already authorized to write may finish,
while later transactions must obtain fresh approval, phase and ownership checks.

Review fixes include fresh patch attempt numbers after a failed write, explicit
cleanup refusal when a created inode cannot be safely removed, cleanup after an
initial descriptor-stat failure, mandatory managed setup for production Agent
creation and an abort check immediately before followup. Missing AgentTask or
unsupported phase fails closed before publication.

The official Profile upgrade also exposed pnpm reusing a same-name local archive:
the command reported success while installed bytes were stale. Profile install
now stages tarballs at content-addressed paths. A separate regression passes;
the actual upgrade then produced identical source and installed production.js
SHA-256 `44d8f3d0f7eab6dadf51859cc8bfab9e7d38384e112f8258b7b8a8f019d4b8aa`.
Chrome loaded the restarted official Web UI at port 3080, which still requests
the user's DeepSeek API key and retains the read-only diagnostic production gate.

Remaining code integration is explicit: default Profile production/session
assembly, task scheduling preflight connected to owned-write grants, bounded
specification-phase Agent contracts, command/verification tools and the full
acceptance executor. These are not certified by isolated managed file I/O.

Host policy is mandatory for managed tools and is re-evaluated for each read and
write, including before descriptor I/O; setup-time authorization does not survive
a later host-policy denial. Cleanup checks path/inode identity before deletion,
but Node's pathname unlink is not an atomic inode-conditional operation. A
non-cooperating process with the same OS user can replace a file between that
check and unlink; cooperative workspace ownership does not prevent that race.
This remains the documented OS boundary, not an atomic-cleanup guarantee.

The dated follow-ups below retain historical evidence; the table above describes
the current release boundary rather than the earlier missing implementations.

Latest local follow-up: 142 test files / 1057 tests passed with four workers;
workspace build, typecheck, lint and the 11-file packed Bundle check passed.
The real Spec Kit CLI and network-backed template isolation cases were excluded,
so this is not a full-suite release pass. An earlier unrestricted-parallel run
hit two 5-second startup timeouts; both passed in isolation and in the final run.

Production-control follow-up validation: 145 test files / 1087 tests passed
with four workers. Build, workspace typecheck, lint and the 11-file packed Bundle
check passed. The same two external-prerequisite cases remained excluded.
Actual Chrome exposed two browser-client regressions (same-revision live approval
rejection and inspection state not reaching the rendered button); both were
reproduced by tests, repaired and rechecked through two real UI confirmations.
The native PostgreSQL migration fixture created and removed both verification
DBs. All local acceptance servers were stopped and their ports had no listeners.

Development recovery follow-up: checkpoints now bind the complete plan hash,
re-read durable handoffs before skipping accepted slices, and require an accepted
developer plus final tester record whose task ID includes that plan hash. Plan
changes, replayed old evidence, empty evidence, duplicate slices and invalid
dependency ordering are rejected before writes. Returned checkpoints retain all
previously accepted slices, allowing repeated recovery without losing progress.
Legacy checkpoints without plan-bound evidence intentionally fail closed.

Codex Chrome exercised an isolated recovery page backed by the real
DevelopmentCoordinator and HandoffStore: first resume performed one remaining
slice, second resume performed zero writes, and stale-plan/empty-evidence cases
performed zero writes. This is recovery-boundary evidence, not completed
production pause/resume wiring. Evidence is recorded in
`.backend-team/artifacts/development-recovery-chrome-evidence.json`.

Recovery validation: 146 files / 1091 tests passed with two workers; build,
workspace typecheck, lint and the 11-file packed Bundle check passed. The same two
external-prerequisite tests remained excluded. The recovery fixture stopped and
its port had no listener. Production still needs to supply the workspace-owned
handoff store and connect these recovery operations to actual run controls;
this change does not implement pause/cancellation or certify current business
file contents against the historical verification records.

Development pause follow-up: the coordinator now admits one execute/resume at a
time. `pause()` requires a durable checkpoint sink, finishes the current slice,
awaits checkpoint persistence and prevents the next dispatch. Initial and
per-slice checkpoints are passed to the sink; persistence failures stop further
work. A pause arriving during an approval check is honored before dispatch.
Completion or failure of the final/current slice remains `passed`, `failed` or
`blocked` rather than being mislabeled as a successful pause. This is cooperative
boundary pausing; an expert that never returns is not forcibly cancelled.

Codex Chrome exercised the real coordinator and durable handoff store through an
isolated page with a fixture-owned fsync/rename checkpoint sink: pause remained
pending while S1 ran, became `paused` only with S1 saved, and recovery read the
checkpoint from disk and executed only S2. Visible results are recorded in
`.backend-team/artifacts/development-pause-chrome-evidence.json`. The fixture
server was stopped after verification. This does not yet provide the production
checkpoint store, run-state projection, default production control wiring, or
real model execution evidence.

Pause validation: 147 test files / 1096 tests passed with two workers; workspace
build, typecheck and lint passed. The same two external-prerequisite tests
remained excluded. The production release blockers above remain in force.

Production recovery dispatch follow-up: a persisted developer handoff followed by
a failed tester exposed a real coordinator incompatibility: replaying the slice
reused its task IDs, which are deliberately single-use capabilities. Dispatches
now use a full SHA-256 binding of the plan hash and slice ID plus a fresh UUID and
bounded retry index. This preserves plan/slice/role verification, avoids reusing
prior task IDs across recovery and keeps task and handoff IDs within the 128
character contract. Previously persisted plan-bound IDs remain readable.

The regression now covers a persisted tester failure through the actual
production composition, scheduler, TeamCoordinator and HandoffStore. Codex Chrome
also exercised that stack with deterministic expert results: S1 passed, S2 saved
both handoffs and blocked, recovery dispatched only S2 with fresh IDs, and a
second recovery dispatched nothing. Six dispatches had six unique IDs. Results:
`.backend-team/artifacts/production-retry-chrome-evidence.json`. This isolated page
is not production control UI wiring and does not constitute real model evidence.
Its server and production composition were disposed after acceptance.

Dispatch recovery validation: 148 files / 1098 tests passed with two workers;
build, typecheck and lint passed, with the same two external-prerequisite tests
excluded. Production checkpoint storage, run-state projection and default
pause/resume control wiring remain outstanding alongside the release blockers.

Production run-control follow-up: `DevelopmentRunController` now owns background
execution and live idle/running/pausing/paused/passed/failed/blocked state. The
file checkpoint store atomically persists passed slice evidence with fsync and
rename under `.backend-team/development/checkpoint.json`, validates its schema
and rejects symlink directories, unsafe files and oversized checkpoints. A new
controller can resume the stored checkpoint while the coordinator revalidates
its plan-bound durable handoffs. Pausing waits for the current slice, and host
disposal drains that run before disposing its agent dependencies.

The Bundle exposes `createProductionDevelopmentRun` and accepts a
`developmentRunFactory` after production activation. This fills the authenticated,
revision-fenced pause/resume commands and connects the actual run feed to the
rendered overlay. The overlay displays pausing, paused and completed states
without claiming that a pause request immediately stopped execution. Live run
updates may share a durable revision; durable phase changes remain fenced.
The public implementation is bundled, requiring no private workspace imports.
Focused package entry points avoid pulling an unrelated CommonJS YAML parser
into the ESM production entry (the initial packed import failed and was fixed).

Codex Chrome exercised the actual Bundle public helper, production host,
authenticated route, overlay, controller, file checkpoint store and production
coordinator: start -> request pause -> current slice completes -> saved/paused ->
resume -> passed. Two slices produced four expert dispatches and both were saved;
the accepted first slice was not repeated. The fixture and host were disposed.
Evidence: `.backend-team/artifacts/run-control-chrome-evidence.json`.

This closes the run-control transport/UI wiring gap, but the acceptance uses
deterministic expert results and fixture-owned plan/approval inputs. The host must
still supply real plan loading, fresh approval verification and patch tracking.
The production coordinator's current artifact hash initialization also needs
integration with the real evolving specification workflow; the GUI fixture used
an empty artifact map and does not certify that path. Multi-host concurrent run
ownership and verification of current business files against checkpoint evidence
are not certified by these checks. Real DeepSeek and release evidence blockers
above still apply; the default diagnostic entry is not made writable.

Run-control validation: 149 files / 1103 tests passed with two workers; build,
workspace typecheck, lint and the 11-file packed Bundle check passed. The same
two external-prerequisite tests remained excluded.

Live specification follow-up (2026-09-06): the production coordinator no longer
relies on its startup artifact map when a specification registry is configured.
It reloads the registry before expert/worker dispatch and before accepting a
result. During BUILD/VERIFY, ApprovalService returns the same artifact snapshot
it checked against both current requirements and design approvals. This avoids
using one snapshot for approval and a separately loaded snapshot for task input
verification. The legacy static-map path remains for compositions without a
specification registry. The public composition now exposes
`verifyDevelopmentApproval` for the bundled development-run factory callback.

Regression evidence covers an approved file changed after startup, an unapproved
change rejected before dispatch, and a change during execution rejected before
the result becomes an accepted durable handoff. Codex Chrome used an actual
file-backed spec.md, the real ApprovalService and the packaged production run
entry. S1 completed and paused; an unapproved file change caused recovery to fail
with no extra patch writes or expert dispatches; restoring the approved bytes
allowed only S2 to run. Final totals were two slice writes and four dispatches.
Evidence: `.backend-team/artifacts/live-artifacts-chrome-evidence.json`.

This closes the startup-artifact-hash integration issue documented above. The
GUI still used fixture-created approval records, a supplied plan and deterministic
expert responses; automatic real plan loading and real DeepSeek execution remain
uncertified, as do the external release evidence blockers. The acceptance server
was stopped after verification.

Live-artifact validation: 150 files / 1104 tests passed with two workers; build,
workspace typecheck, lint and the 11-file packed Bundle check passed. The same two
external-prerequisite tests remained excluded.

Codex model route (2026-09-06): the optional Bundle `codexAppServer` configuration
now registers a real DSH model adapter. The workspace web Profile is enabled with
Codex CLI 0.148.0 and existing ChatGPT login; no DeepSeek key or Python installation
was required. Configuration instructions: [Codex App Server](../codex-app-server.md).

Real acceptance passed: account/model discovery; a two-step model/host read-tool
roundtrip; and Codex Chrome model selection followed by real replies. After the
final isolation change and installed Bundle restart, Chrome received exactly
“配置已生效。” from GPT-5.6-Sol. The loopback registry probe, using explicit dummy
credentials, showed only the declared DSH tool and zero upstream requests.
Artifacts: `.backend-team/artifacts/codex-tool-registry-evidence.json`,
`codex-tool-roundtrip.json`, and `codex-model-chrome-evidence.json` in that directory.

Validation: 157 files / 1152 tests passed, excluding the same two external-prerequisite
tests. After final tool-isolation changes, all four affected test files / 11 tests,
build, workspace typecheck, lint, and packed Bundle validation (11 exact files)
passed. The final real host-tool roundtrip also passed again.

This closes the need for a DeepSeek key to use the DSH model conversation through
this alternative provider. It does not certify DeepSeek compatibility, the full
BackendTeam production workflow, real SpecKit/Python prerequisites, or the other
release blockers recorded above. Native Codex tool access remains disabled; DSH
owns execution and approvals. Responses are buffered and the output-token budget
cannot be enforced as an upstream hard limit by the current App Server protocol.

Direct Qwen API follow-up (2026-09-07): the workspace web Profile uses the
shipped rc.6 `llm-pi-ai` route `qwen-4399` / `qwen3.8-flash`, over the user-selected
4399 Responses endpoint. The optional Codex App Server route is disabled. The
user has stored the API credential through DSH; no credential value appears in
the acceptance artifacts.

Codex Chrome verified a real random file-marker read, image-tool result
understanding (red circle / blue square), creation of two source/test files,
actual Node test execution and model repair after the initial test failed, then
5 passing tests. An independent host test run passed too. Streaming text was
observed while generation was active; Stop ended the partial output and the
next request returned “恢复成功”. Evidence:
`.backend-team/artifacts/qwen-chrome-acceptance.json` and
`.backend-team/artifacts/qwen-generated-tests.log`.

This is real ordinary DSH Agent acceptance, not the full BackendTeam workflow.
The production specification boundary still lacks a structured AgentTask,
feature-prefixed artifact paths, and dedicated pre-approval artifact tools.
Development-only file guards must not be loosened to hide those gaps.

A discovered budget-accounting bug is fixed: HarnessAgentRuntime now sums
per-call usage across the task's assistant messages, including disjoint cache
input. Previously it counted only the final model response. A two-step
regression failed with 18 instead of 56 tokens before the fix; it now passes,
as does rejection of negative cache counts with Agent disposal. Prior events
are excluded and reasoning output is not counted twice. Targeted validation:
10 files / 97 tests, build, workspace typecheck, lint and the 11-file packed
Bundle check passed.
The focused budget change also passed an independent code review with no
blocking findings and the official rc.6 headless Agent lifecycle smoke. The
Bundle was repacked, installed into the workspace web Profile, and the service
restarted; Chrome confirmed the Qwen selection and conversation persisted.

Real production BUILD probe (2026-09-07): actual rc.6 Agents, real Qwen,
createProductionActivation, TeamCoordinator and mandatory managed write/read
completed an isolated task with accepted durable output. The output file hash
matched the handoff; no commands were executed or claimed. Evidence:
`.backend-team/artifacts/qwen-production-build-probe/evidence.json`.
Requirements/design approvals were seeded test inputs and the artifact
validation ports were probe fixtures. This closes the real-model managed BUILD
roundtrip check, not full specification, default Profile or command acceptance.

The earlier real run with a 4096-token total task budget was rejected after
72813 tokens across four tool calls, demonstrating the corrected budget
accounting. It also exposed a missing exact marker value in the probe prompt;
the prompt and explicit total task budget were corrected before rerunning.
Failure evidence is retained as
`.backend-team/artifacts/qwen-production-build-probe-failure-4096.json`.

### 2026-09-07 — specification document Agent integration

Structured specification AgentTask dispatch now uses supported roles, unique
per-instance task IDs, exact feature-relative file inputs/outputs, explicit
read/write-only capabilities and bounded host usage. A successful matching
AgentResult is required before phase advancement. Existing OpenAPI contracts
remain legitimate read-only inputs.

Production activation selects dedicated specification tools in SPECIFY,
DESIGN and PLAN. Document grants are separate from BUILD/VERIFY owned writes;
explicit host policy and current approval checks remain required. Agent-scoped
Cordis cleanup waits for file operations and releases durable leases. An
independent review found and verified fixes for a scope mismatch and duplicate
setup race. No remaining lifecycle, ownership, phase or I/O blocker was found
in this bounded review.

Real Qwen SPECIFY probe passed using actual rc.6 Agents, production activation,
SpecificationCoordinator.start, document writes/reads and final structured
result decoding. Both fixture documents were created, the phase became
AWAIT_REQUIREMENTS_APPROVAL, and no ownership lease remained after Agent
completion. Command prompt and artifact validator were explicit minimal test
fixtures; this does not establish complete Spec Kit requirements quality or
production Web workflow acceptance. Evidence:
`.backend-team/artifacts/specification-qwen-probe/evidence.json`.
The initial path-scope rejection is preserved in
`.backend-team/artifacts/specification-qwen-probe-failure-read-scope.json`.

Chrome clipboard image acceptance also passed: preview, submission and direct
Qwen recognition of a new green-circle/orange-square image, without tools.
Evidence: `.backend-team/artifacts/qwen-image-paste-acceptance.json`.
No independent upload button or drag-and-drop acceptance is claimed.

Validation: 39 related test files / 284 tests passed, workspace typecheck,
touched-file lint, build, and the 11-file packed Bundle check passed. Logs:
`.backend-team/artifacts/spec-{regression,typecheck,lint,build,packed}.log`.
The default Web entry remains diagnostic; production host/session/policy and
complete user workflow acceptance are still separate release requirements.

An expanded real-model probe exceeded the fixed cumulative token ceiling and
was rejected before phase advancement. The guard remains intact. Hosts may now
set explicit positive integer maxTokens/maxWallMs in specification.budget;
defaults remain unchanged. Invalid ceilings fail before workspace activation,
and budget errors include actual usage and configured maximum. The expanded
probe failure is preserved at
`.backend-team/artifacts/specification-design-plan-qwen-probe/evidence.json`.

The complete policy-engine suite also passed after the final build under the
workspace Node 24 runtime: 6 files / 214 tests (`spec-policy-regression.log`).
A seeded design probe passed architecture and database roles but correctly
remained in DESIGN when the research result combined a passed status with
non-passing verification records. The probe's requirements were only marker
lines; the model identified the missing requirements rather than inventing
supported technology decisions. That failure is retained separately at
`.backend-team/artifacts/specification-design-plan-seeded-qwen-probe-blocker-detail.json`.
No decoder relaxation or automatic approval was introduced to conceal it.

A subsequent substantive fixture made requirements explicit and removed any
need for external dependency selection. Architecture and database roles passed;
research produced the intended documents, but its final JSON contained an
extra `verificationNote` key and was rejected by the strict result schema.
Evidence is preserved in
`.backend-team/artifacts/specification-design-plan-substantive-qwen-probe-blocker-detail.json`.
The result boundary now supports at most one budgeted, tool-disabled format
correction. It keeps strict result validation and does not accept or strip the
invalid result. Specification tasks allow one retry shared with provider
retries; tokens from both responses remain counted. Semantic verification
failures are not eligible for this correction.

Final real DESIGN/PLAN probe passed with substantive in-memory health-API
requirements, explicit 262144 cumulative tokens per task, and maxAgents=1.
Three design roles and the planner each published a passed run; phases were
DESIGN → AWAIT_DESIGN_APPROVAL → PLAN → BUILD. Requirements and both approval
records were explicit test fixtures. Seven documents were generated by the
four real Agents; the other two documents were seeded inputs. The planner's
marker-only tasks artifact tests dispatch/write/read/result integration, not
the quality or execution of a complete development task list. No commands,
external dependency research, production deployment or real user approval
was claimed. This successful run needed zero result-format corrections; the
correction branch is covered by deterministic tests, not this real-model run.

Evidence:
`.backend-team/artifacts/specification-design-plan-format-retry-qwen-probe/evidence.json`.
Independent checks matched all nine file hashes, confirmed four passed run
events, observed the phase sequence, and found zero ownership leases:
`.backend-team/artifacts/spec-independent-artifact-check.json`.
The probe's incorrect initial expectation of five runs is retained in
`specification-design-plan-format-retry-qwen-probe/probe-assertion-failure.json`;
seeded SPECIFY correctly yields four real runs. SPECIFY was exercised separately
in the earlier real probe, not as one continuous real requirements-to-BUILD run.

Final code validation: 60 related files / 602 tests passed, workspace typecheck,
touched-file lint, build and packed Bundle checks passed. Evidence:
`spec-final-regression.log`, `spec-typecheck.log`, `spec-lint.log`,
`spec-build.log`, `spec-packed.log` under `.backend-team/artifacts`.
The reviewed cancellation/disposal race was reproduced before the fix and
verified with a barrier-based test afterward. All callers now await the same
underlying Agent disposal. Independent review found no remaining blockers in
these bounded changes.

### 2026-09-07 — Required OpenAPI ownership and production entry audit

The actual `ArtifactValidator` requires `contracts/openapi.yaml` for DESIGN, but
previous specification tasks granted no writer. The architecture role now owns
that exact active-feature path alongside plan.md and architecture.md. The separate
specification policy permits that one nested path only during DESIGN. Other roles,
phases, filenames, symlink/hardlink targets and development-only grants remain
rejected. The host must create a safe contracts parent directory before dispatch.

Validation: 9 focused test files / 250 tests passed, workspace typecheck, build,
and touched-file ESLint passed. Evidence: `.backend-team/artifacts/spec-openapi-green.log`,
`spec-openapi-typecheck.log`, `spec-openapi-build.log`, `spec-openapi-lint.log`.
This extends the earlier 602-test stage; it is not a new real-model OpenAPI run.
The running Web profile has not been replaced with this source build.

Chrome extension inspection of the existing DSH acceptance tab confirmed both the
successful pasted-image answer and the diagnostic-only BackendTeam overlay. The
root Bundle entry currently registers diagnostics/model integration, not the
production control route. Verified rc.6 adapters exist, but a separate explicit
host composition still needs workspace/session authentication, protected recovery
state, policy and complete coordinator callbacks. Neither callback stubs nor a
cosmetic removal of the diagnostic label constitutes production readiness.

Official generic Spec Kit command assets are absent in this workspace. The exact
pinned installation plan was prepared read-only in
`.backend-team/artifacts/spec-kit-install-review.json`: arm64, uv 0.12.3,
Python 3.13.15, specify-cli 0.16.5, 17 artifacts / 46,033,875 download bytes,
7 commands. Python usage is confined to `.backend-team/runtime/spec-kit/.venv`
with its managed interpreter under `.backend-team/runtime/python`. No download,
installation or approval issuance occurred. User AGENTS instructions explicitly
require confirmation before installing any Python environment.

Remaining production work also includes aligning generated documents with the
real validator's required headings and planner output with `TaskPlanParser` task
metadata, then validating a useful plan before claiming a usable BUILD workflow.
The previous marker-document model probes do not establish those properties.

### 2026-09-07 — User-approved real Spec Kit installation

The user explicitly approved the reviewed project-local runtime installation.
The execution script compared the fresh plan digest with the reviewed digest
before issuing the scoped install capability. The real downloader checked the
pinned sizes and SHA-256 values; all seven runtime commands completed successfully.
Installed versions: uv 0.12.3, managed Python 3.13.15, specify-cli 0.16.5. Dependencies
were installed offline into `.backend-team/runtime/spec-kit/.venv`; no system
Python installation was performed.

The follow-on official generic initialization used the real adapter. Both managed
targets (`.specify` and `.backend-team/runtime/spec-kit/commands`) were absent before
execution, so it did not overwrite an existing Spec Kit project. Five official
commands (specify, clarify, plan, tasks, analyze) loaded successfully and their
source hashes were recorded. An independent check confirmed the official generic
integration metadata, all five command hashes, and the venv interpreter resolving
inside this project's managed runtime tree.

Evidence under `.backend-team/artifacts/`: `spec-kit-install-result.json`,
`spec-kit-install.log`, `spec-kit-init-review.json`, `spec-kit-init-result.json`,
`spec-kit-init.log`, and `spec-kit-independent-check.json`. The initialization
created untracked `.specify/` files; no commit or publication was performed.

This removes the missing-runtime/official-command-assets blocker. It does not
claim completion of the separate production Web host composition, document-format
alignment, or executable task-plan validation described above. No full real-CLI
isolation-gate test is claimed: these records describe the approved installation
in the actual project workspace and its independent runtime verification.

### 2026-09-07 — PLAN admission and document instructions

Added a host task-plan loader port propagated through the production composition.
It is optional for earlier stages but mandatory when generating implementation
tasks. A missing loader stops before Agent dispatch; invalid actual task files
stop PLAN from entering BUILD. The coordinator checks active feature identity and
rechecks design approval after parsing. A real-file integration test uses
FileDevelopmentPlanLoader/TaskPlanParser: an empty generated plan is rejected,
then a repaired task document permits a retry to BUILD. Approval and model output
are fixture inputs in this test; it is not a real-model or browser workflow claim.

Added separate application output instructions for each specification role,
including real validator headings, AC IDs, OpenAPI and task metadata. Official
Spec Kit prompt content and source hashes remain unchanged. This teaches the
required formats but does not prove a model will always produce a valid document.

Chrome extension inspection confirms the running DSH page is still diagnostic;
this change has not been installed into the running Web profile. Full production
host wiring and a continuous real model/browser acceptance remain outstanding.

Validation for this stage: 44 files / 271 tests passed in
`task-plan-regression-bounded.log`, including the actual new-project install/build/
health fixture (166 seconds). Workspace build and typecheck, touched-file ESLint,
and packed Bundle validation (11 exact files) passed. Evidence logs:
`task-plan-build.log`, `task-plan-typecheck.log`, `task-plan-lint.log`,
`task-plan-packed.log`. The initial broad run was stopped while waiting for the
long-running template fixture; the completed bounded-worker rerun is authoritative.
Red/green regressions are retained in `task-plan-gate-red.log` and
`task-document-guidance-red.log` / `task-document-guidance-green.log`.
### 2026-09-07 — Configured document workflow and real Chrome approval acceptance

Added the explicitly enabled `@dsh-backend-team/bundle/production` Cordis entry.
It verifies real DSH Agent/session services and initialized official Spec Kit
commands, prepares one configured feature directory, creates a private recovery
key, and binds the existing control UI to the real coordinator, artifact
validator, approval service and task-plan parser. The Web profile preserves the
direct Qwen model provider and disabled Codex App Server. The active acceptance
feature is `specs/gui-workflow-acceptance` in this checkout.

Chrome extension acceptance exercised a real requirement submission, generated
documents passing the actual validator, hash-bound text preview, approval buttons
disabled before preview, rejection, follow-up clarification, repeated review,
and confirmation advancing durable state to DESIGN. Rejection did not advance
the phase or create an approval. A process restart retained the current phase
and offered a fresh confirmation for the current document hashes. These browser
approval clicks concern the isolated test specification, not business release
authorization.

The first model attempt exceeded its budget and was not admitted to approval.
The browser exposed three issues that were fixed: missing owned output reads
looked like permission failures; background refresh erased action failures;
normal rejection appeared as HTTP 500. Managed model generation now cancels at
the wall-time limit, with a real design attempt observed to stop at 300 seconds.
That attempt left partial architecture documents and is not counted as a passed
design. Added authenticated, idle-only DESIGN/PLAN recovery, and verified the
Chrome “继续设计” button starts a new real coordinator run.

Two design timeouts were traced to a real approval-scope defect, not merely slow
model output: `phaseForArtifactPath` matched `/contracts/openapi.yaml` only with
a leading directory. ArtifactRegistry returns `contracts/openapi.yaml`, so
creating that design output temporarily made requirements approval appear stale
and the guarded write rolled back. The relative-path case is now classified as
DESIGN. Regressions cover relative and prefixed contract paths while preserving
rejection for changed requirement hashes and unknown artifacts. The retained
`workflow-contract-stale-browser-run.json` contains only scoped tool names,
paths and errors from the failed run; `workflow-contract-scope-red.log` and
`workflow-contract-scope-green.log` record the reproduced failure and fix.

After the scope fix, the contract wrote successfully. A further timeout exposed
self-referential edit histories in generated documents: the model kept rewriting
them to update its own activity claims. Output instructions now keep run evidence
in AgentResult, retain correct existing outputs, avoid repeated reads, and bound
normal Markdown length in Unicode characters. The acceptance profile's per-role
wall limit was explicitly changed to 600000 ms (token limit remains 262144).
The next real architecture role passed in 126192 ms with 76022 tokens and seven
tool calls, preserving the existing contract and updating only the two Markdown
documents. This result is recorded as run `cb5c1041-223b-401c-aec4-de16bb1c281f`.

The configured host currently enables document generation and approvals only.
Business code execution and database actions remain explicitly unavailable;
BUILD means a validated plan is ready, not that implementation or production
release has completed. The real DESIGN/PLAN flow subsequently completed: all
three design roles returned passing results, actual design validation passed,
Chrome rendered all nine approval documents, and the browser confirmation
persisted design approval before starting the planner. Actual task parsing then
advanced state to BUILD at revision 14. An independent FileDevelopmentPlanLoader
read found 11 tasks, nine slices and AC-001–AC-005; the model summary's claimed
12 tasks was incorrect. `workflow-final-acceptance.json` records the real counts,
both validation results, approval kinds and artifact hashes.

This is document/control-flow acceptance, not semantic certification of the
generated implementation plan. Review found examples requiring correction before
execution: T-106 describes depending on T-003 but omits that metadata dependency;
T-105's all-imports-must-be-node check conflicts with the planned local module
import; T-106's empty existing dependency lists go beyond the approved no-new-
dependencies requirement. No code was executed from this plan. The execution
entry and a review gate for such semantic problems remain production work.

Evidence is retained under `.backend-team/artifacts/`: `workflow-final-regression.log`
(58 files / 387 tests), `workflow-final-typecheck.log`,
`workflow-final-packed.log`, `workflow-final-lint.log`,
`workflow-missing-document-red.log` / `workflow-missing-document-green.log`,
`workflow-wall-time-red.log` / `workflow-wall-time-green.log`,
`workflow-rejection-red.log` / `workflow-rejection-green.log`,
`workflow-message-persistence.log` and `workflow-recovery-tests.log`.
Durable phase/approval/run records are in `.backend-team/events/events.jsonl`.
No credentials were printed, and no commit or publication was performed.

### 2026-09-07 — Development handoff context review

- Reproduced a real execution gap: SliceExecutor dispatched only a generic slice objective and omitted planned task instructions. Developer, tester, fixer and retest requests now carry the current slice's concrete task objectives.
- Added read access declarations for transitive prerequisite slice outputs and the six actual documents verified by FileDevelopmentPlanLoader. Document read paths are workspace-relative; artifact hash keys remain feature-relative for approval freshness comparisons. Write ownership remains restricted to the current slice. Unrelated slice files are excluded.
- Regression test failed before each fix; 6 focused suites / 21 tests passed afterward, including recovery, pause and run control. Build, typecheck, touched ESLint, packed Bundle verification (11 exact files), and diff whitespace checks passed.
- Corrected the GUI fixture task plan: T-106 depends on T-003; final verification depends on contract and smoke checks; existing dependencies must be preserved; relative local imports are allowed; task-level Node listen arguments are now port then host. Actual loader still returns 11 tasks / 9 slices. Evidence: `.backend-team/artifacts/execution-context-review.json`.
- Added planner guidance to prevent these dependency/scope mistakes and require reporting contradictions in approved design.
- Chrome extension inspection confirms the actual page still states that execution is unavailable. This UI inspection does not establish real development execution success. The updated bundle was installed to the web profile.
- Still unresolved: approved `architecture.md` and `plan.md` retain the reversed listen(host, port) example and require a correction/reapproval path; the configured host has no development run or command executor. No business code was executed and no production release is claimed.

### 2026-09-07 — Managed development execution and recovery

- Supersedes the previous execution-unavailable snapshot: the configured web host now supports opt-in `development.enabled` with explicit source/test write roots. Developer/tester execution uses the existing backend team coordinator and the configured Qwen model API; it does not replace the team with Codex App Server.
- Startup reconciles persisted approval hashes before admitting work. Corrected the approved listen argument order, renewed design through Chrome, and retained requirements approval. Design role inputs are limited to their required documents; stale task documents no longer inflate each design role's context.
- Reviewed the fixture's 11 tasks as one independently testable S-health slice. Actual development now starts from the Chrome panel. Fixed cloning of live delegation callbacks without serializing them into the model prompt, and made controller failures visible in the panel.
- Added a bounded macOS/Node 24 test executor with explicit file reads, loopback networking, denied writes and subprocesses, sanitized environment, deadlines and captured exit codes. A host-side ledger requires a real successful test after the last managed write before accepting a passing development result. This supports the declared built-in Node test workload, not arbitrary shell/npm or deployment execution.
- Corrected sandbox ancestor-directory access after an actual home-directory workspace run failed with `EPERM uv_cwd`. Regression fixtures now exercise both temporary and home-directory workspaces.
- Actual generated health implementation was reviewed and its CONNECT handling corrected after a failing HTTP regression. The final available Node test file passed 18 tests via both the managed Agent tool and a separate `node --test test/health.test.mjs` invocation. These test passes alone do not establish an accepted developer/tester handoff.
- Actual fixed-port entry smoke covered GET/query success, POST/HEAD/OPTIONS rejection, unknown-path 404, loopback-only listening, EADDRINUSE nonzero exit, graceful shutdown and port reuse. Chrome navigation to port 3001 was blocked by the browser (`ERR_BLOCKED_BY_CLIENT`); that browser endpoint check is not recorded as passed. Workflow interactions on port 3080 were exercised through the Chrome extension.
- Two development runs reached their 600-second deadline, including one after 18 passing tests. Neither produced an accepted checkpoint. Recovery guidance now prioritizes testing existing artifacts and fixing demonstrated defects, with explicit reporting of host-only outstanding checks. The empty failed-run checkpoint was archived before restarting against the revised task plan; no completed slice was discarded.
- Regression evidence: `managed-execution-final-tests.log` (60 files / 400 tests), `managed-execution-final-typecheck.log`, `managed-execution-final-lint.log`, build/pack/install logs, `health-final-node-test.log`, `health-managed-node-test.json`, `health-production-smoke.json`, and `health-connect-red.log`, all under `.backend-team/artifacts/`.
- Full developer/tester acceptance remains pending at this checkpoint. Database host controls and remaining production release gates are not certified by this health fixture. No publication or commit was performed.

The recovery run 67169a1b-92e1-49bd-ba3e-1a0efa1f30c1 returned a result before its deadline, but the contract correctly rejected it: status passed was combined with a not-run health-loopback-smoke verification record. No developer or tester handoff was accepted. Added a specific safe diagnostic for this contradiction and explicit prompt guidance to report blocked/not-run for unexecuted required checks; semantic validation is unchanged and is not auto-repaired. The diagnostic regression failed first, then 31 focused tests passed. Typecheck, touched ESLint, build and packed verification passed, and the refreshed bundle was installed. The final independent Node invocation now passes 19 tests, including real parsing with the already-installed yaml module; no package was installed for that check. Final source hashes and the rejected-run status are in managed-execution-final-status.json. Full team and production acceptance remain incomplete.

### 2026-09-08 — Verification instruction identity

The model-facing result schema previously accepted arbitrary instructionId strings, while the host verifier rejected any ID absent from the dispatched task. The rejected September 7 result included acceptance/evidence labels as additional instruction IDs. The emitted schema now enumerates the task's actual verification IDs, and prompt guidance distinguishes those IDs from evidence names. Host verification and rejection rules are unchanged. Regression failed before the fix; 35 focused tests then passed, along with typecheck, touched lint, build and exact packed-bundle verification. Updated bundle installed to the existing web profile. Chrome started real run 3afca621-f305-43e3-bb94-414208d644e3; its test tool returned 19/19 and exit 0. Independent Node execution also passed 19 tests. Result acceptance remains pending at this snapshot; no production completion is claimed. Logs: verification-id-{red,green,typecheck,build,pack,install,runtime,health-tests}.log under .backend-team/artifacts/.

The first new run produced valid JSON but exceeded its 262144-token task budget (312902 observed), so no handoff was accepted. The GUI fixture profile task ceiling was adjusted to 524288 based on measured cumulative usage; time and capability limits were retained. Subsequent developer d27cd946-f62f-4655-a81a-0344f546d3ee (466031 tokens) and independent tester bd48bc17-6cc3-467b-9125-aafe6d6949df (87147 tokens) both produced host-accepted durable handoffs. Chrome showed development completed and waiting for subsequent verification. The accepted slice checkpoint, handoffs and final hashes are recorded in verification-id-accepted.json. This establishes real developer-to-tester execution; database controls and full production release gates remain outstanding.
Final artifact validation also passed: 19 Node tests, seven fixed-port HTTP cases, occupied-port startup exit 1, normal shutdown exit 0, and successful port reuse. Evidence: verification-id-final-health-tests.log and verification-id-final-smoke.json. These checks used the final source hashes in verification-id-accepted.json.

### 2026-09-08 — Provider-independent model API release gate

Replaced the obsolete DeepSeek-only release gate with real-model-api, requiring provider/model identity and an OpenAI Responses or Chat Completions protocol. Updated scenario gate names and release guidance; deterministic fixtures remain not-run. Legacy vendor-only declarations and Codex App Server evidence are rejected as substitutes. No actual production gate was promoted to passed. Regression reproduced the missing support, then 22 release/scenario tests passed. Evidence: release-model-gate-red.log and release-model-gate-green.log under .backend-team/artifacts/. The configured workflow host still supplies unavailable database operations; database control integration and complete production acceptance remain outstanding.

### 2026-09-08 — Database lifecycle prerequisites for UI controls

PostgresqlCluster now serializes initialize/start/stop calls, prevents duplicate starts, releases port leases when process startup fails, and cleans up owned processes if listener inspection/readiness fails. Failed cleanup retains the owned process and lease, reports interrupted, and rejects further starts until an explicit stop succeeds. It no longer returns an unverified process as running. Four regressions failed before the change; the complete database suite passes 79 tests including cleanup retry. Typecheck, touched lint, build and packed-bundle verification passed. The real native darwin-arm64 PostgreSQL execution-port smoke passed database creation, CREATE TABLE/INSERT/SELECT, and shutdown. Evidence: database-lifecycle-{red,green,typecheck,build,native,pack}.log under .backend-team/artifacts/.

This is lifecycle implementation, not GUI integration completion. The configured workflow host still has unavailable database callbacks. Before enabling persistent database controls, implement durable credential storage and existing-data-directory recovery: the current cluster initialization generates a new password and invokes initdb on each newly constructed cluster, and the only included credential implementation is memory-backed. Those paths must not be exposed as restart-safe production behavior. No existing user database was migrated, reset or deleted; native validation used its owned temporary smoke workspace.

### 2026-09-08 — Persistent database credentials and data recovery

Added FileCredentialStore with owner-only file permissions and bounded, no-follow reads; it is explicitly not encrypted storage. Cluster initialization now writes workspace-bound recovery metadata containing a credential reference, not a password. Fresh cluster objects reuse the existing PostgreSQL 18 data and credential rather than invoking initdb again. Missing metadata/credential, a different workspace/version, unsafe files, or an existing postmaster.pid reject recovery without overwriting database configuration or data. Initialization uses an exclusive lock; stale locks require investigation rather than automatic deletion.

Three initial regressions failed before implementation. All 86 database tests then passed, covering independent credential-store instances, deletion, traversal/symlink/permission rejection, preserved data, missing credentials and four blocked recovery conditions. The native darwin-arm64 execution-port probe now creates a fresh FileCredentialStore and PostgresqlCluster after stopping the first cluster, authenticates again and reads the previously inserted row; credential identity remains unchanged. Logs: database-recovery-{red,green,typecheck,build,native}.log under .backend-team/artifacts/. This proves stopped-cluster data/credential reuse through the backend components, not recovery of an unowned live process or full configured GUI integration. The native probe uses only its disposable owned workspace and removes no existing user database.

### 2026-09-08 — Configured DSH database migration acceptance

The configured native host now exposes migration generation, exact SQL preview and authenticated approval through the DSH page. It uses pinned Drizzle Kit 0.31.10 to pull/generate, verifies a disposable clone against the design, preserves custom primary-key names that Drizzle introspection drops, rejects stale schema/revisions, retains a pre-application backup and applies the reviewed SQL in a transaction. The control projection now includes migration approvals during BUILD; confirmation remains disabled before preview inspection.

Actual Codex Chrome acceptance completed DbGate Table creation, save, DSH generation, SQL inspection, approval and the applied status. Independent PostgreSQL queries observed 0 matching tables before approval and 1 after, with PK_dsh_migration_acceptance preserved. Reviewed/applied SHA-256: 76cd27c879947558cff434f253ae7bd2785cb0b9c196f5c16b65917111fa03f2. Only the empty acceptance table was removed afterward; generated artifacts and the backup remain. No /health business source or requirement was changed.

Separate real PostgreSQL tests covered baseline data retention, indexes/foreign keys, named serial primary keys and rejection after source-schema drift. Related package tests: 264 passed, 2 opt-in native tests skipped in that batch. Typecheck, build, touched lint and the 12-file packed Bundle check passed. Local evidence: .backend-team/artifacts/dsh-migration-browser-evidence.json, native-migration-review.log, drizzle-real-upgrade.log, migration-all-tests.log and migration-controls-*.log. This is local integration evidence; it does not certify every PostgreSQL object, external production migration, automatic ORM source integration, restart recovery of pending reviews, backup restore UI, dependency-audit clearance or dual-architecture native release provenance.

## 2026-09-08：原生构建流程补齐（云端待执行）

- PostgreSQL CI 改为明确的 macOS 15 arm64 / Intel 原生任务，核对运行架构后执行工作区构建、原生构建及真实数据库生命周期检查。
- 成功任务保存精确的安装包、源 manifest、运行证据、SHA256SUMS 和 GitHub 签名证明，不上传整个 `.backend-team`。SQL 检查现在启用 ON_ERROR_STOP 并检查子进程退出码，SQL 错误不能仅靠输出文本被忽略。
- 本机 arm64 真实检查通过：启动、建表、写入、查询、停止，以及新实例重启后保留原记录和凭据身份。证据：`.backend-team/artifacts/postgresql-native-ci-smoke.json`，安装包 SHA-256 `2c91690995dab19f4193b60297a4070f9c28df96bcf2711a49dcc48d6bae4ec0`。
- 工作流 YAML 解析、shell / JavaScript 语法检查、修改脚本 ESLint 均通过；发布门槛回归测试 5 项通过，记录 `.backend-team/artifacts/postgresql-ci-release-tests.log`。
- 本次重新查询 npm 官方审计得到 18 项 findings（0 critical、3 high、15 moderate），原始材料 `.backend-team/artifacts/dbgate-audit-current.json`。本次没有修改 DbGate 依赖，数量变化不能归因为本次修复；安全发布阻塞仍保留。
- 当前 `git remote -v` 为空，无法触发远程 Actions。本机成功不等于云端双架构、签名或发布验收通过；x64 原生运行、云端证明及稳定下载地址仍待实际提供。runtime manifest 继续保持 `pending-native-build`。

### 2026-09-08 — Final declared Node workload verification

The configured development host now follows accepted slice execution with one host-run final invocation of all declared Node test files. It reuses the existing managed executor, holds the workspace run lease, verifies current approval before/after execution, and compares snapshots of declared outputs and approved document inputs. Missing files/tests, nonzero exits, approval revocation and input drift cannot produce a passing final check. Reports are private `.backend-team/final-verification-*/report.json` files containing plan/file hashes and actual invocation/output. No model call is needed when an accepted checkpoint can be resumed.

Codex Chrome opened the configured project session and invoked 开始或恢复开发 against its accepted checkpoint. The page displayed 最终项目测试通过（1 个测试文件） and the report path `.backend-team/final-verification-t1Egn6/report.json`; actual captured TAP: 19 tests, 19 passed, 0 failed/skipped/todo, exit 0. Nine source/test/document snapshots are bound to this report. Evidence: `.backend-team/artifacts/final-verification-browser-evidence.json`. No business source or accepted task plan was modified.

Regression: 43 files, 237 passed and 2 opt-in tests skipped; the network template isolation suite was excluded. Includes actual passing/failing managed Node executions, missing outputs/tests, approval revocation, file drift and controller waiting/lease behavior. Workspace typecheck, touched ESLint, build and diff checks passed; packed bundle contains 12 files and was installed into the local web Profile. Logs: `final-verification-{regression,typecheck,lint,build,pack,install}.log`.

This is a final rerun of the declared Node workload, not full requirement/build/deployment acceptance. The page states that boundary and no longer labels an empty aggregate as 0/0 passed. Phase remains BUILD; automatic VERIFY/DELIVER advancement, complete requirement evidence aggregation and in-page report inspection remain unfinished. Reports persist on disk; after a backend restart the live summary is regenerated by resuming the accepted checkpoint.

### 2026-09-08 — Requirement evidence completeness and delivery review

Fixed a false-positive path in requirement aggregation: one successful matching capture no longer passes a requirement that expects additional missing evidence. Each requirement now reports missingEvidenceIds. A focused regression covers partial versus complete evidence.

The final Node report now carries a typed delivery review through the development controller, control view and Chrome page. It lists requirement statuses, expected/missing evidence and unique unresolved items from the completed slice handoffs. Controller snapshots are cloned to prevent observers mutating nested review data. Delivery-ready declarations reject incomplete requirement evidence, nonpassing tests or unresolved items. The page also retains sanitized connection error messages alongside its diagnostic fallback instead of hiding the actual error.

Actual Codex Chrome acceptance: the configured project resumed its accepted checkpoint, ran 19 Node tests (19 passed, exit 0), and rendered 5 pending requirements plus 9 retained Agent items. Report `.backend-team/final-verification-J9wMK7/report.json`; sanitized browser evidence `.backend-team/artifacts/delivery-review-browser-evidence.json`. The page correctly says 0/5 requirements have complete evidence; this means the aggregate command is not yet bound to each required evidence ID, not that the 19 executed tests failed. Existing host-only checks recorded in older artifacts were not silently used to resolve the Agents' outstanding items.

No business code, task plan or approval was changed. A separate ordinary model connection probe replied 连接正常 without tools; that probe is not requirement evidence. Initial browser connections displayed diagnostic mode, and the installed/restarted Profile subsequently loaded the operational panel; no claim of a certified root cause for that initial connection behavior is made.

Remaining: verified evidence-to-check binding, audited resolution of outstanding items, and automatic final phase advancement. This delivery review does not fabricate missing captures or mark the project DELIVER. The backend retains report files; resuming regenerates live review state after restart.

Validation for this follow-up: 48 regression files / 253 tests passed, 2 opt-in tests skipped, network template isolation excluded. Workspace typecheck, touched ESLint, build, 12-file pack/install and diff checks passed. Logs: `.backend-team/artifacts/delivery-review-{tests,typecheck,lint,build,pack,install}.log`.

### 2026-09-08 — Reviewed delivery evidence and outstanding-item resolution

The host now binds explicit evidence IDs to a canonical plan hash and executed test-file hashes. Final tests use the actual Node test CLI with process isolation disabled inside the existing macOS sandbox; a regression confirms undeclared file access remains denied. Generic command purposes no longer satisfy evidence IDs. Skipped/todo tests and stale bindings cannot establish acceptance. Digest-pinned, explicitly host-reviewed reports supplement the test run, and exact-text outstanding-item resolutions retain the original item, evidence IDs and review reason in the final report.

For the configured health example, the host parsed OpenAPI YAML and checked the approved contract structure, started the actual entry point at 127.0.0.1:3001, verified the sole loopback listener and exact health response, stopped the owned process and checked port reuse. Dependencies matched committed baseline ff1d9750e623e8d2fecec8ed3f0da8ecabb8dcfd (2026-09-05); all recorded input/output hashes remained unchanged. This is YAML parsing plus targeted contract assertions, not generic OpenAPI 3.1 metaschema certification. Evidence: .backend-team/artifacts/host-delivery-check.{mjs,json,log}.

Actual Codex Chrome acceptance resumed the accepted checkpoint without another model call. The page displayed “需求验收已通过” and 5/5 complete requirements. .backend-team/final-verification-31lUMx/report.json records passed tests, delivery ready, no unresolved items and nine audited resolutions. Browser evidence: .backend-team/artifacts/evidence-bindings-browser-evidence.json. The overlay also now retries initial connection failures and cancels retries on session change/unmount; the real page loaded successfully after installing this change. The underlying reason for initial session unavailability is not claimed to be established.

Validation: 48 regression files, 259 tests passed and two opt-in tests skipped; network template isolation excluded. Workspace typecheck, touched ESLint, build and Profile package installation passed. Logs: .backend-team/artifacts/evidence-bindings-{regression,typecheck,lint,build,pack,install}.log. No business source, approved requirement, dependency or Agent handoff was rewritten. Current acceptance covers this configured health workload; automatic persistent VERIFY/DELIVER phase advancement, general builds/deployment, external services and broader production release gates remain outside this result.

### 2026-09-08 — Persistent delivery lifecycle and restart acceptance

Added the host-only delivery lifecycle: BUILD → VERIFY before final checks, then DELIVER only for complete reviewed acceptance. Incomplete results remain in VERIFY with a retry control. The durable project state stores the delivery review and exact report SHA-256; state transactions emit normal phase events. Startup recovery checks report contents, current plan, protected evidence bindings, all planned files, supplementary host-report inputs and active artifact approvals. Missing or changed evidence clears the saved review and returns DELIVER to VERIFY; it does not silently reuse stale acceptance. This check runs on startup/finalization, not continuously while the host is running.

Actual Codex Chrome acceptance clicked “开始或恢复开发” and observed “交付结果” plus 5/5 requirements passed. After stopping and restarting the configured backend, a fresh Chrome page recovered the same .backend-team/final-verification-exyxbS/report.json without clicking resume or sending a model message. Durable state is DELIVER revision 22. The verification summary now also reads “5/5 项需求验收通过”, replacing the contradictory empty aggregate summary. Initial temporary session-authentication failure recovered automatically in this run. Evidence: .backend-team/artifacts/delivery-lifecycle-browser-evidence.json.

Validation: 69 regression files, 420 tests passed, two opt-in native tests skipped; network template isolation excluded. New regressions cover independent-store restart, incomplete evidence, approval revocation, report/output/configuration drift, supplemental host input drift and VERIFY/DELIVER UI actions. Workspace typecheck, touched ESLint, package builds, Profile pack/install and diff checks passed. Logs: .backend-team/artifacts/delivery-lifecycle-{tests,typecheck,bundle-build,lint,panel-lint,pack,install}.log. No business-source or dependency changes. This closes automatic final-phase advancement for the configured workload; generic deployment, broader production release gates and the previously deferred Intel acceptance are not certified by this result.

### 2026-09-08 — Conversation tools use the production service

The configured Profile disables the base compatibility-only status registration. Production now registers backend_team_status and backend_team_workflow on the official tool service. Both validate the live calling Agent and use the same host-issued session identity as the control surface; directly constructed identities are rejected by the existing authenticator. The first real-model probe reproduced UNAUTHENTICATED, which exposed this identity mismatch. Reusing the host's issuing port corrected it without weakening workspace authentication.

A subsequent actual Qwen/Chrome conversation called status successfully (supported, DELIVER, revision 22, ready, 5/5, zero unresolved) and then workflow continue with that revision (completed). No Shell call or development restart was needed. The retained delivery report is .backend-team/final-verification-exyxbS/report.json. Local evidence: .backend-team/artifacts/conversation-tools-browser-evidence.json.

The workflow tool routes requirements, continuation, pause, preview and database controls through the existing authenticated dispatcher. Approval/rejection first requires the current artifact preview, then an official DSH approval.request allowed-once outcome attached to the caller/tool call; refusal/unavailability/cancellation does not apply a decision. Regression tests cover live identity, workspace mismatch, stale revisions, phase routing, exact preview identity, explicit approval refusal/grant and preservation of delivered work. Approval UI interaction with a new pending workflow was not exercised in this real-model probe; it is not claimed as end-to-end accepted here. New project/task configuration remains outside the chat entry.

Validation: 32 regression files, 188 tests passed, two opt-in native tests skipped; workspace typecheck, touched lint, Bundle build, pack/install and diff check passed. Logs: conversation-tools-{regression,typecheck,lint,pack,install}.log and production-status-build.log under .backend-team/artifacts/. No approved task, business source or dependency was changed.

### 2026-09-08 — Conversation-first team workspace

UX inspection reproduced the fixed overlay covering the left session navigation and exposing unbounded historic Agent prose alongside routine database controls. Replaced the shell.overlay registration with the official additive conversation.view slot, labelled “团队进度”. The built-in conversation, trajectory, sidebar and tool-details seats remain owned by DSH. The new workspace presents a phase header, three status summaries, review requests and scoped delivery evidence; manual controls, report paths and execution history are collapsed. Bottom spacing allows content to scroll above the persistent composer. Unconfigured sessions show a clear project-connection message.

Actual Codex Chrome checks: the new tab opens the current 5/5 delivery result; returning to Chat removes the team panel and keeps the composer; manual controls/history expand and collapse; navigation and panel bounds do not overlap (navigation right 278, panel left 280 at the inspected desktop viewport), and no horizontal document overflow was observed. Switching to the unconfigured backagent session displayed the connection explanation, and switching back restored travel. Final package was installed and backend restarted. Screenshots were inspected inline during this turn. Evidence: .backend-team/artifacts/team-ui-browser-evidence.json. No mobile viewport or full accessibility certification is claimed.

Agent workflow guidance now assigns routine environment preparation to the Agent. prepare-migration automatically starts a configured stopped database, rechecks readiness/revision and only then generates the pending migration. A regression verifies ordering and that startup failure prevents migration generation. Actual database migration was not repeated in this UI acceptance; prior native migration evidence remains separate. No approval rule was relaxed.

Validation: 32 files, 189 regression tests passed, two opt-in native tests skipped. Workspace typecheck, touched ESLint, Bundle build, pack/install and diff checks passed; logs team-ui-{regression,typecheck,lint,build,pack,install}.log. This improves the configured workflow; new-project creation and a general historical-artifact browser are not added by this change.

### 2026-09-14 — T13 DbGate schema edit and ORM persistence follow-up

The isolated DbGate 7.2.3 runtime was opened from the Codex Chrome extension against a temporary PostgreSQL 18.6 arm64 design database. The operator created `gui_migration_accounts`, added `email text`, reviewed the generated `CREATE TABLE` statement, and confirmed it. An independent query read back the table and both columns while the service remained bound to `127.0.0.1`; the redacted record is `.backend-team/artifacts/dbgate-gui-acceptance/gui-migration-evidence-20260914.json`.

The native migration review regression now also passes an ORM target. It proves the target file remains unchanged before approval, is atomically replaced after approval with the generated schema, and is protected by the same migration hash while data retention and schema-drift rejection remain covered. The real PostgreSQL test passed with Node 24 and the workspace arm64 runtime. These are separate GUI and migration proofs; the same official production-host session still needs to connect the DbGate edit directly to the migration approval, so T13 remains open.

The follow-up chain kept the development baseline in the temporary design database, then generated the single Drizzle migration `0001_serious_raza` from the GUI result. The isolated approval runner created a backup, atomically persisted `.backend-team/runtime/gui-migration-acceptance/schema.ts`, applied the SQL, and read back `baseline` plus `gui_migration_accounts` and their columns. The redacted chain record is `.backend-team/artifacts/dbgate-gui-acceptance/gui-migration-generated-20260914.json`. The first run without the baseline was rejected by Drizzle as an unresolved change; the acceptance helper now records the baseline prerequisite instead of treating that case as success. This remains an isolated proof and does not replace the official production-host approval card.

### 2026-09-14 — T14 migration review recovery regression follow-up

Node 24 reran the migration review, configured workflow host, and conversation task recovery suites: 3 files and 14 tests passed. The run covers exact SQL preview, authenticated approval, stale revision rejection, apply failure propagation, hash-bound pending review restore, stale/tampered record cleanup, host initialization/disposal, and task queue fencing. The redacted machine-readable record is `.backend-team/artifacts/migration-review-t14-regression-20260914.json`.

The result confirms the backend recovery invariants. It does not claim a production browser restart with a pending migration card; that opt-in isolated UI fixture remains the next T14 acceptance gap.

### 2026-09-15 — T16 PostgreSQL release-material audit

The arm64 PostgreSQL 18.6 archive was rechecked on macOS arm64 with Node 24.19.0. The real execution-port smoke passed through binary inspection, loopback SCRAM, SQL create/read, stop, and recovery with a fresh cluster and credential store; the archive remains 5,709,156 bytes with SHA-256 `2c91690995dab19f4193b60297a4070f9c28df96bcf2711a49dcc48d6bae4ec0`. The result is `.backend-team/artifacts/postgresql-execution-t16-20260915.json`.

At the time of this audit the release manifest was still `pending-native-build`; `verify-postgresql-runtime.mjs` rejected it with exit code 1, and no darwin-x64 archive was present yet. The subsequent local dual-architecture build and execution evidence is recorded in `.backend-team/artifacts/postgresql-native-build-t21-20260915.json`. Stable HTTPS download, checksum sidecar and signature/attestation are still absent, so no local result was promoted to release evidence. The original audit is `.backend-team/artifacts/postgresql-release-t16-20260915.json`; T16 remains blocked on external publication materials.

### 2026-09-15 — T20 production Bundle wiring refresh

Using workspace-local Node 24.19.0, 14 production-wiring test files passed 107/107. Bundle typecheck, full workspace build, packed Bundle validation (14 required files plus the allowed tooling and license prefixes), Agent runtime setup/result/usage/disposal probe, and loopback-authenticated Host/Session/Agent provenance probe all passed.

A stopped temporary T18 workspace had retained a hard link to the managed Node executable, making its link count 2; the packed-Bundle security gate correctly rejected that state. After closing the temporary host/browser and removing that owned temporary workspace, the managed Node link count returned to 1 and the packed-Bundle check passed. No product code changed for this cleanup.

This remains local wiring evidence. Official production Harness provenance, a protected real-model coordinator run, a same-production-composition Chrome full flow, and signed dual-architecture PostgreSQL release artifacts are still absent, so T20 remains partial and is not release approval. Evidence: .backend-team/artifacts/production-wiring-t20-20260915.json.

### 2026-09-15 — T21 release materials refresh

The current Bundle was rebuilt and packaged as 256 archive entries. Its SHA-256 is `acb8fa1b7f12ab25c16eafb87d0b0a4bc19271dbaf387fc33c35670bd0d64a50`; the CycloneDX 1.5 SBOM contains 395 components and has SHA-256 `e054ad2c2a64892187e5f2f845ebd96e1476622a7f7f6d9bd8968f5fc547b772`. Checksum, SBOM, Bundle version, third-party license notice, and DbGate 7.2.3/GPL-3.0 records verified. Release artifact, release content policy, and dependency governance tests passed 31/31; DbGate installer/security regressions passed 13/13.

The read-only release audit remains blocked by the pending-native-build PostgreSQL manifest, missing signature/attestation, and missing stable HTTPS download URL. The installer now pins the unused `http` declaration to the npm security holding package `0.0.1-security` and removes the Excel/`xlsx` path entirely. A fresh registry-backed audit of the PostgreSQL-only lock reports 0 critical, 0 high and 8 moderate findings; no `xlsx` or `dbgate-serve` package is present. The generated local-development materials are valid, but they are not release approval. Evidence: `.backend-team/artifacts/release-materials-t21-20260915/audit.json`.

The release-material builder now accepts a signed distribution record through
`--distribution`; it requires the external signature evidence to carry the exact
Bundle SHA-256 before writing `verified` metadata. Omitted distribution input keeps
the existing fail-closed `not-attested` output.

### 2026-09-21 — T16/T21 external PostgreSQL runtime publication

GitHub Actions Run `35565633720` rebuilt the PostgreSQL 18.6 runtime on native
macOS arm64 and x64 runners from commit `800d27b06aab8131c43ada77c332e90a3e03822e`.
Both jobs passed workspace build, architecture checks, PostgreSQL lifecycle smoke,
evidence packaging and `actions/attest`. The resulting public Release is
[v0.1.0-rc.1](https://github.com/zhuangdize/dsh-backend-team/releases/tag/v0.1.0-rc.1)
and contains both archives, `SHA256SUMS`, smoke evidence, signed attestation
bundles, the source manifest and the generated verified runtime manifest.

The published archive hashes are arm64
`43023496c1e4e256a84525723cc484dd1f4490d9c084affd056e38b95d814190` and x64
`bfaed6046c1fe65931307ad2bea22d2df076c8af38e61fab5c17f4e8a0f7c40c`. The
public attestation pages [arm64](https://github.com/zhuangdize/dsh-backend-team/attestations/48847944)
and [x64](https://github.com/zhuangdize/dsh-backend-team/attestations/48848539)
show matching archive subject digests and the same workflow commit. The checked-in
manifest now records stable HTTPS release URLs and `status=verified`; the Bundle
release-candidate remains blocked until real production release evidence and its
signed distribution are supplied.

### 2026-09-21 — T21 Bundle release workflow hardening

The Bundle release workflow now performs the release-candidate supply-chain steps
against one immutable archive: clean checkout and full checks, unsigned pack,
GitHub Actions artifact attestation, digest-bound distribution metadata, release
verification, material audit, and publication of the archive plus checksum, SBOM,
materials, attestation, and audit report. `build-release.mjs` also supports
finalizing an existing tarball after attestation and creates `dist/` in a clean
checkout. The workflow now requires an explicit reviewed `verified` Agent fixture
path instead of silently using the repository's partial fixture. This removes the
workflow plumbing gap; it does not promote a release until the four required
production evidence gates and the verified fixture are supplied and independently
reviewed.

### 2026-09-15 — T21 local dual-architecture PostgreSQL build

The official PostgreSQL 18.6 source manifest was downloaded and its SHA-256
verified. Local build output now includes the Darwin arm64 archive (5,706,128
bytes, SHA-256 `2af1b662319bada7f49be44fb2b2ac8a58e66ca3d701f79b40f615f3992c5b4c`)
and Darwin x64 archive (6,211,348 bytes, SHA-256
`62ceee8db1e4fea2f9d310cd7d050218c7085609574a50951b6c061bc8b6b9ce`). `file`
confirmed the embedded `postgres` binaries are arm64 and x86_64 respectively.
The arm64 execution-port smoke passed loopback SQL, stop and fresh-cluster
recovery under Node 24.19.0; the x64 archive passed initdb, Rosetta loopback
start, SQL write/read and stop. Evidence is
`.backend-team/artifacts/postgresql-native-build-t21-20260915.json`.

These are local build and execution checks only. The runtime manifest remains
`pending-native-build` until a release system publishes both archives at stable
HTTPS URLs with signed checksums/attestations, so the release audit remains
fail closed.

### 2026-09-15 — DbGate Excel dependency removed from the runtime profile

The installer no longer requests `dbgate-serve@7.2.3`, whose hard dependency
tree pulls in every connector. It installs the 7.2.3 API, Web and PostgreSQL
packages, generates a launcher with a PostgreSQL-only plugin directory, and
rejects any runtime that still contains `dbgate-serve`,
`dbgate-plugin-excel` or `xlsx`. The local runtime lock now contains no such
package and the launcher served the real DbGate 7.2.3 web page on loopback.
Legacy entries are removed recursively before installation, and a reintroduced
disabled package causes the installer/native launcher to fail closed. A clean
official-registry install contains 503 audited packages and no disabled entry.
Excel import/export is intentionally outside this Agent Team database profile;
the PostgreSQL GUI and migration path remain available. Formal release still
requires dual-architecture PostgreSQL provenance,
signature/attestation and a stable HTTPS download address.
