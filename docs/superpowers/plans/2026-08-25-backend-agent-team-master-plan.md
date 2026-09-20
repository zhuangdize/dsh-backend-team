# DeepSeek Harness Backend Agent Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a macOS-first DeepSeek Harness Bundle that guides non-backend users from clarified requirements through approved architecture and PostgreSQL design to safe, verified Node.js implementation.

**Architecture:** A prebuilt Bundle mounts thin DeepSeek Harness plugins over an internal TypeScript core. The core owns a durable state machine, policy enforcement, workspace-local runtimes, official Spec Kit integration, bounded expert delegation, project analysis, development verification, PostgreSQL/DbGate lifecycle, and a non-technical control panel. Harness, platform, process, and database APIs are behind adapters so the core remains testable and future platform support does not leak into prompts.

**Tech Stack:** current development uses existing NVM `0.40.3` loader read-only with worktree-local `NVM_DIR` and Node.js `24.19.0`/npm `11.17.0`; product runtime management is implemented in Stage 05 Task 2, plus strict TypeScript 6.0.3, npm workspaces, ESM, Vitest, Zod, DeepSeek Harness Bundle/Plugin APIs, official Spec Kit `v0.16.5`, workspace-local uv `0.12.3`, PostgreSQL, Drizzle ORM, DbGate Community `7.2.3`, macOS Intel/Apple Silicon.

**Spec:** `docs/superpowers/specs/2026-08-25-backend-agent-team-design.md`

## Global Constraints

- V1 supports macOS Apple Silicon and Intel only.
- The distributable is a prebuilt DeepSeek Harness Bundle; do not fork or patch DeepSeek Harness core.
- DeepSeek Harness is a developer preview; every supported release requires an exact externally verified compatibility-matrix entry. The rc.6 plugin Context has no trusted runtime-version field, so production does not promote itself from that matrix and remains read-only until a separately proven host binding supplies trustworthy provenance.
- New projects default to exact Node.js `24.19.0`, strict TypeScript, NestJS + Fastify, REST/OpenAPI, PostgreSQL, Drizzle ORM, and reviewable SQL migrations. Changing that Node default requires a reviewed compatibility-matrix update.
- Existing Node.js projects retain their framework, ORM, package manager, database, and a compatible trusted version from `.nvmrc`, `.node-version`, `package.json#engines`/`devEngines`, or equivalent evidence; they are not forced to Node.js `24.19.0`. Conflicting or absent trustworthy version evidence is resolved during design approval before any project command runs.
- Each approved exact Node selection must resolve to a reviewed version × macOS architecture manifest before download. Stage 05 initially covers new-project `24.19.0` and existing-project fixture `20.20.0` on arm64/x64; Node 20 is marked EOL/existing-project-only and requires an explicit risk display, while an unlisted selection fails closed before network or command execution.
- Requirements approval and design approval are mandatory before business-code writes.
- All Team-managed Python environments use workspace-local uv; never use or install global Python.
- Installing uv, Python, Spec Kit, or running Spec Kit initialization requires an `install` approval bound to the full canonical plan: versions, sources, licenses, exact byte sizes, SHA-256 values, per-artifact workspace-relative destinations, allowed redirect hosts, exact commands/environments, and code-execution effects. One user decision becomes one callback-scoped policy session; the token is consumed once, every side effect is re-authorized against that plan, and all capabilities are revoked when the callback exits. Runtime installation and `specify init --force` are separate plans and approvals. External bytes are prefetched only through the guarded downloader; subsequent uv/Python/Spec Kit commands run under a macOS deny-network process boundary and may consume only the verified workspace-local artifacts.
- Team-managed NVM loader, Node binaries, npm/npx, uv, Python, Spec Kit, PostgreSQL, DbGate, state, caches, logs, locks, and data live under `<target-workspace>/.backend-team/`. The current Stage 01 repository-development exception may source the existing user NVM loader read-only; product project commands never source a host/user-global NVM loader.
- Every Team-initiated `node`, `npm`, or `npx` project command uses an exact selected Node installation below `NVM_DIR=<target-workspace>/.backend-team/runtime/nvm`. Host/system/Homebrew/MacPorts Node binaries and PATH fallback are forbidden. pnpm/yarn must resolve to a reviewed project-local absolute executable or a project-local JavaScript entry invoked by that selected absolute Node.
- Before the first product project command, Stage 05 Task 2 reuses Stage 02's policy-engine-owned install session and the guarded public platform artifact adapter (the raw Stage 01 downloader is not exposed without that session) to download pinned NVM source, verifies manifest source/SHA-256/size/license, installs it below the target workspace, and sources only that local `nvm.sh`. NVM or any exact Node version/architecture download requires install approval; never modify an external NVM loader, shell profile, or global NVM alias/default.
- No Docker, production deployment, production database access, system service, shell profile mutation, global NVM/Node/package installation, destructive Git operation, or worktree-outside write.
- Experts may create work subagents; work subagents may not delegate. Maximum depth is two, maximum concurrent experts is three, maximum subagents per expert is three, and maximum concurrent writers is two.
- Tool visibility and a Harness guard are not security boundaries; every write/process/network/database adapter re-authorizes the exact action with the Policy Engine immediately before its side effect.
- Dependencies are pinned by `package-lock.json`, lifecycle scripts are reviewed before enabling, SBOM is generated, and new dependencies are checked through npm audit plus OSV.
- DbGate remains a separately launched local process; GPL-3.0 distribution review gates bundling.
- Full DeepSeek Harness Web UI end-to-end testing uses the Codex Chrome plugin.
- Tests are written first for every behavioral change; each task ends with a focused verification and commit.

Command blocks are plan shorthand, not proof that a wrapper already exists. Stage 01 repository commands use the explicitly documented current NVM selection pattern. From Stage 05 Task 2 onward, product bootstrap sources only `<target-workspace>/.backend-team/runtime/nvm/nvm.sh`, and product code passes absolute selected Node/npm/npx paths to the guarded runner; pnpm/yarn follow the reviewed project-local executable/JavaScript-entry rule above. No bare spelling grants PATH lookup.

---

## 1. Why the work is split

The approved design contains seven subsystems with different failure modes. A single giant execution list would let Harness compatibility, Python isolation, Agent permissions, database distribution, and UI release risks hide behind one another. The plans below are therefore separate reviewer gates. Each stage produces testable software and may be rejected without invalidating an unrelated later design decision.

## 2. Execution order

| Order | Plan | Independently testable output | Hard gate before next stage |
|---|---|---|---|
| 1 | `2026-08-25-backend-agent-team-01-harness-foundation.md` | Loadable diagnostic-only Bundle with contracts, state store, policy engine, macOS adapter, and compatibility check | Fresh-profile Bundle load and real boot smoke pass on the pinned Harness release |
| 2 | `2026-08-25-backend-agent-team-02-spec-kit-workflow.md` | Workspace-local uv/Python/official Spec Kit flow with requirements/design approvals | No global writes; approval hash invalidation and resume tests pass |
| 3 | `2026-08-25-backend-agent-team-03-project-analysis.md` | Evidence-based new/existing project classifier and baseline report | Fixture matrix classifies stacks without executing project code |
| 4 | `2026-08-25-backend-agent-team-04-agent-orchestration.md` | Mock-driven coordinator, experts, bounded subagents, scheduler, ownership, budgets, and handoffs | Application depth, concurrency, privilege monotonicity, and shared-write tests pass; no production host claim |
| 5 | `2026-08-25-backend-agent-team-05-development-verification.md` | Product Node runtime gate plus application-level approved-plan loop, action catalog, verification, security, dependency governance, and recovery | `WorkspaceNodeRuntime`/bootstrap/manifests pass before any project command; mock-driven project simulations then complete without scope escape |
| 6 | `2026-08-25-backend-agent-team-06-database-experience.md` | Application-composed real PostgreSQL, migration gates, snapshot/recovery, and direct DbGate evidence | Real PG upgrade/rollback and direct GUI-to-migration evidence pass on both macOS architectures; no Harness panel claim |
| 7 | `2026-08-25-backend-agent-team-07-productization.md` | Production orchestration gate, non-technical control panel, packaged Bundle, upgrade/uninstall, SBOM/licenses, and full E2E | Every production approval/Agent/event/host/client/session seam passes before the `.tgz` and ten scenarios may release |

## 3. Locked repository map

```text
package.json                         # npm workspaces and repository scripts
package-lock.json                    # exact JavaScript dependency graph
tsconfig.base.json                   # strict shared TypeScript settings
vitest.config.ts                     # unit/integration test projects
eslint.config.js                     # static analysis
.gitignore                           # build output and local Team runtime exclusions
packages/
  contracts/                         # stable schemas and shared discriminated unions
  core/                              # state machine, approvals, coordinator, recovery
  harness-adapter/                   # structural DSH types, compatibility, real/mock adapters
  bundle/                            # published package, dsh.bundle manifest, plugin entries
  policy-engine/                     # path/command/network/database/approval enforcement
  platform-macos/                    # filesystem, process, downloader, architecture adapter
  spec-workflow/                     # workspace uv/Python and official Spec Kit adapter
  project-analyzer/                  # evidence collectors and project profile synthesis
  agent-team/                        # roles, scheduler, delegation, ownership and handoff
  development/                       # vertical slices, patch tracking and implementation loop
  verification/                      # baseline-aware tests and requirement evidence
  dependency-governance/             # license, lifecycle, npm audit, OSV and SBOM policy
  database/                          # PostgreSQL, Drizzle migration and DbGate lifecycle
  web/                               # control-panel service contract and client UI
presets/                             # expert definitions and new-project defaults
templates/                           # Backend Team extensions to official Spec Kit artifacts
runtime-manifests/                   # pinned NVM/Node/uv/PostgreSQL/DbGate artifacts and checksums
scripts/                             # packaging and isolated compatibility/E2E runners
tests/
  fixtures/                          # project and state fixtures only; no real secrets
  integration/                       # cross-package tests with mock adapters
  e2e/                               # fresh DSH_HOME, real Bundle and real browser scenarios
docs/
  compatibility/                    # DSH and runtime compatibility evidence
  licenses/                          # third-party notices and distribution decisions
  operations/                        # install, upgrade, recovery and uninstall guides
```

No source file should combine Harness-specific registration, policy decisions, process launching, and orchestration. Cross-package access uses exported interfaces from `@dsh-backend-team/contracts`; importing another package's private `src/` path is forbidden.

## 4. Stable cross-plan interfaces

The first plan owns these names. Later plans consume them without renaming:

```ts
export type BackendTeamPhase =
  | 'DISCOVER'
  | 'SPECIFY'
  | 'AWAIT_REQUIREMENTS_APPROVAL'
  | 'DESIGN'
  | 'AWAIT_DESIGN_APPROVAL'
  | 'PLAN'
  | 'BUILD'
  | 'VERIFY'
  | 'DELIVER'

export type RunStatus = 'running' | 'passed' | 'failed' | 'blocked' | 'interrupted'

export interface WorkspaceLayout {
  readonly root: string
  readonly teamDir: string
  readonly stateDir: string
  readonly runtimeDir: string
  readonly cacheDir: string
  readonly logsDir: string
  readonly locksDir: string
  readonly handoffDir: string
}

export interface CommandRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly purpose: string
  readonly risk: 'read' | 'write' | 'install' | 'migration' | 'destructive'
  readonly executionFingerprint: string
  readonly approvalToken?: string
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly outputLimitExceeded?: boolean
}

export interface CommandRunner {
  run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult>
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** Application-layer tool shape; not a DeepSeek Harness ToolDefinition. */
export interface BackendTeamApplicationTool {
  readonly name: string
  readonly description: string
  execute(input: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface ApprovalRequest {
  readonly kind: 'requirements' | 'design' | 'install' | 'migration' | 'shared-config'
  readonly summary: string
  readonly artifactHashes: Readonly<Record<string, string>>
}

export interface ApprovalDecision {
  readonly effect: 'approve' | 'reject' | 'edit'
  readonly reason: string
}

export interface AgentSpawnRequest {
  readonly task: string
  readonly role: string
  readonly context: JsonObject
}

export interface AgentHandle {
  readonly id: string
  result(signal?: AbortSignal): Promise<unknown>
  cancel(): Promise<void>
}

/** Application orchestration port; deliberately not the Harness host API. */
export interface BackendTeamOrchestrationPort {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
  spawnAgent(request: AgentSpawnRequest): Promise<AgentHandle>
  emit(event: BackendTeamEvent): Promise<void>
}

export interface PolicyEngine {
  authorize(action: PolicyAction, context: PolicyContext): Promise<PolicyDecision>
}

export interface StateStore {
  load(): Promise<BackendTeamState | null>
  create(initial: BackendTeamState): Promise<void>
  transact(expectedRevision: number, change: StateMutation): Promise<BackendTeamState>
}

export type StateMutation = (state: BackendTeamState) => BackendTeamState
```

Stage 02 adds one reusable security interface without changing the contracts above: a policy-engine-owned install session receives a canonical install execution scope, consumes the matching single-use approval token, and lends exact artifact-fetch and command-execution capabilities only for the duration of one callback. Platform adapters remain responsible for I/O and process execution; the policy engine never downloads or spawns directly. Later NVM/Node/PostgreSQL/DbGate installers must reuse this session boundary rather than exposing the Stage 01 internal downloader or inventing another token bypass.

The exact Zod schemas, events, errors, and secondary interfaces are defined with tests in Plan 01. If implementation discovers a required interface change, update this master plan and every consuming plan in the same reviewed change before writing dependent code.

## 5. Repository and commit strategy

Historical baseline (completed): the repository was initialized and the approved design/plans were committed before current implementation. This is provenance, not an executable instruction; do not rerun `git init`, recreate the root commit, invent a remote, or rewrite that baseline.

Each task commits only its owned files. Commit messages use these prefixes:

```text
build: repository or packaging mechanics
feat: user-visible or runtime capability
fix: verified defect
test: test-only change
docs: documentation or evidence
chore: generated lock/SBOM/license metadata
```

## 6. Release blockers carried across every plan

1. A DeepSeek Harness RC may load the Bundle but fail real tool calls. Compatibility requires pack → add to a pinned disposable Profile → dump config → real Cordis boot → official `ctx.tools.execute`; this external evidence does not become a production runtime-version signal.
2. The Bundle must not ship a second physical copy of Harness runtime packages. Use structural types or peer dependencies and verify runtime identity.
3. The control plane is local-only. Any non-loopback host configuration blocks write-capable activation.
4. PostgreSQL portable artifacts require a reproducible dual-architecture build, checksums, provenance, and runtime dependency closure.
5. DbGate must be at least `7.1.9`; V1 pins `7.2.3` and tests loopback-only binding because earlier versions include a critical authenticated RCE advisory.
6. `specify-cli` `0.16.5` is installed through workspace-local uv from the official PyPI wheel whose release tracks the open-source GitHub tag `v0.16.5`; the complete Python 3.13/macOS runtime wheel closure is pinned and installed offline after guarded download verification. An online Git install is forbidden because it introduces unbound Git/build/dependency downloads. Backend Team disables Spec Kit self-upgrade and upgrades only through a reviewed manifest change.
7. The official Spec Kit `generic` integration writes command files into `.backend-team/runtime/spec-kit/commands`; Backend Team executes those official prompt assets through Harness rather than pretending DeepSeek Harness is a built-in Spec Kit integration.
8. Every real Stage 02 download/installation test requires a newly issued exact install approval. Design/plan confirmation is not install authorization, mocks do not satisfy the real CLI gate, and a blocked approval remains visible instead of causing host-global fallback or unapproved network execution.
9. Stage 01 currently proves only an existing NVM `0.40.3` loader sourced read-only with worktree-local `NVM_DIR` and Node.js `24.19.0`/npm `11.17.0`. Stage 05 Task 2 must implement and test product-local `WorkspaceNodeRuntime`, pinned NVM bootstrap, and exact Node-version × macOS-architecture manifest catalog/resolution before any project command. Missing or unmatched manifest resolution blocks download, Stage 05 execution, and Stage 07 release.
10. Stage 07 Task 2 owns the sole production `BackendTeamOrchestrationPort`: durable application events, authenticated control-mediated approval, and a real Agent spawn/result/cancel/usage binding. Any Harness/model/Agent binding requires exact public official API/provenance fixtures; mocks never qualify. A missing seam hard-blocks Bundle action registration, browser E2E, and release.

## 7. Approved-design traceability

| Design sections | Implementation ownership | Required evidence |
|---|---|---|
| 2–3 Product boundary and Harness integration | 01 Tasks 5–7; 07 Tasks 2–4 | Exact-version tools matrix, production orchestration fixture/gate, single Bundle row, real tool/client activation |
| 4 User workflow and two confirmations | 02 Tasks 4–7; 04 Task 7; 05 Tasks 1, 5, 8; 07 Tasks 1–4, 7 | Mock-driven application approval hashes plus production control-mediated approval and browser journey |
| 5 New and existing project strategy | 03 Tasks 1–6; 05 Tasks 2–3, 8 | Project fixture matrix, dirty-worktree and MySQL-preservation evidence |
| 6 Official Spec Kit integration | 02 Tasks 1–7 | Official tagged CLI, generic integration assets, no private Python imports or global runtime |
| 7 Agent Team roles and delegation | 04 Tasks 1–7; 07 Tasks 2, 4, 7 | Application privilege/depth/concurrency evidence plus verified production Agent spawn/cancel/usage binding and durable handoffs |
| 8 State, approvals, and recovery | 01 Tasks 1–3; 02 Tasks 5, 7; 04 Tasks 5–7; 05 Tasks 3, 5, 8; 06 Tasks 2–4, 7; 07 Tasks 1–2, 7 | Atomic revisions, durable production events, stale approval rejection, parameterized interruption recovery |
| 9 Workspace runtimes | 01 Task 1 current-environment record; 02 Tasks 1–3, 7; 03 Tasks 3, 6; 05 Task 2 product Node runtime; 06 Tasks 1–5, 7; 07 Tasks 6–7 | Current host-loader/local-NVM_DIR split plus future checked NVM/Node/uv/PostgreSQL/DbGate artifacts, workspace-only filesystem audit, exact runtime selection, verified process identity |
| 10 New-project baseline | 05 Task 2; 06 Task 4 | Compiling NestJS/Fastify/Drizzle template and real PostgreSQL migration |
| 11 Database design and migrations | 06 Tasks 3–7; 07 Tasks 2, 4, 7 | Direct DbGate/application GUI diff → migration evidence, then gated production Bundle/panel equivalence |
| 12 Security and privacy | 01 Tasks 3–7; 03 Tasks 2, 5; 04 Tasks 2–6; 05 Tasks 3–7; 06 Tasks 2–7; 07 Tasks 1–7 | Adversarial zero-side-effect tests, secret redaction, loopback/listener audits |
| 13 Open-source governance | 05 Task 4; 06 Tasks 1, 5; 07 Task 6 | Pinned lock/manifests, audit/OSV, SBOM, licenses and distribution boundary |
| 14–16 Verification, rollback, and budgets | 01–07 stage gates; especially 04 Task 4 and 05 Tasks 5–8 | Focused/full tests, retry bounds, budget exhaustion, rollback/recovery evidence |
| 17 Web panel | 07 Tasks 1–4, 7 | Component accessibility plus real Harness Web UI Codex Chrome acceptance |
| 18–20 macOS scope, V1, and stages | All plans in the locked order | Native arm64/x64 jobs and no unsupported-platform activation |
| 21 Acceptance scenarios | Master section 8; 07 Task 7 | Ten executable scenarios with linked machine/browser evidence |
| 22 Release, upgrade, uninstall | 07 Tasks 4–7 | Pack/install/upgrade/rollback/uninstall in fresh Profiles with data preserved |
| 23 Technical validation blockers | 01 Tasks 5–7; 02 Tasks 2–3; 06 Tasks 1, 5, 7; 07 Tasks 2, 4, 7 | Real tools/runtime/orchestration/host/client/browser gates must pass before dependent release claims |
| 24 Design completion definition | Every stage completion gate | No skipped or mocked-only release blocker may be marked complete |

## 8. Final acceptance mapping

| Spec acceptance scenario | Primary plan | Final evidence |
|---|---|---|
| Natural-language new backend | 02, 03, 04, 05, 06, 07 | Stage 07 gated production orchestration, browser E2E, and generated project verification report |
| Existing PostgreSQL project | 03, 05, 06 | Dirty-worktree fixture diff and real PG tests |
| Existing non-PostgreSQL project | 03, 05 | No database/ORM replacement diff assertion |
| Cross-phase recovery | 01, 02, 04, 05, 06 | Parameterized interruption suite |
| Expert/subagent bounds | 04, 07 | Application scheduler tests plus verified production Agent spawn/cancel/usage E2E |
| Production/outside-workspace blocking | 01, 05, 06 | Policy audit events and zero-side-effect assertions |
| DbGate to migration | 06, 07 | Direct Stage 06 evidence followed by Stage 07 production panel/control E2E |
| No Docker/global pollution | 01, 02, 06, 07 | Filesystem snapshot plus executable-realpath audit before/after dual-arch E2E; no global NVM/Node/npm or shell-profile/alias mutation |
| Missing/untrusted Harness provenance fail-safe | 01, 07 | Read-only diagnostic E2E without runtime-version self-detection claims |
| Intel and Apple Silicon | 01, 06, 07 | CI artifacts from both macOS architectures |

## 9. Completion rule

A stage is complete only when its focused tests, full repository tests, package build, and documented gate pass. “Not run” is not a pass. A blocked external prerequisite remains visible in the plan and prevents the dependent release stage; it does not justify weakening workspace isolation, production safety, official Spec Kit usage, or open-source governance.
