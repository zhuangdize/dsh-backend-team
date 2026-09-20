# Owned Agent I/O Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Track each step below; preserve the shared worktree's existing changes.

**Goal:** Close the verified gap between approved development tasks and actual Harness file I/O without allowing native tools to bypass ownership or patch evidence.

**Architecture:** A setup callback runs inside the official Agent creation lifecycle before publication and model execution. It registers task-bound tools and a deny-only guard. The host validates current phase and ownership, while descriptor-bound policy operations perform the single file write and PatchTracker records before/after evidence.

**Tech Stack:** TypeScript, Node 24.19.0, official DSH rc.6, Vitest, Codex Chrome.

**Spec:** Existing contracts in `packages/contracts/src/agent-task.ts`, policy handle contract in `packages/policy-engine/src/policy-engine.ts`, patch transaction in `packages/development/src/patch-tracker.ts`, and official Agent lifecycle inspected in the installed rc.6 runtime.

## Global Constraints

- No Python installation or environment changes.
- No global tools, synthetic production approval, model credential invention, or release-gate bypass.
- Bind tools to the actual Agent identity and immutable scheduled task, not model-provided task IDs.
- Unconfigured production remains read-only. Existing diagnostic exports remain stable.
- Default native write, shell, code execution, subagent, network, and workflow tools must be denied in these managed Agent contexts.
- File permissions and ownership are checked again at execution; plan-time authorization is insufficient.

## Task 1: Descriptor-bound approved create and write preflight

**Files:** `packages/policy-engine/src/policy-engine.ts`, `packages/policy-engine/test/write-capability.test.ts`.

**Interfaces:** Add `preflightOwnedWrite(action, context): Promise<PolicyDecision>` and `executeApprovedCreate(action, context, operation: (handle: FileHandle) => Promise<T>): Promise<T>`. Both use the existing host-owned `OwnedWriteGrantVerifier`; neither grants based solely on pathname. Existing `executeApprovedWrite` remains the only existing-file write path.

- [x] Add failing cases for denied/missing grants, phase changes, existing create target, symlink/hardlink parents, callback failure, and attempted path escape.
- [x] Implement fresh grant checks and exclusive new-file creation; close descriptors on every path and check the created inode before cleanup. This is not atomic protection against non-cooperating same-UID replacement after the final check.
- [x] Run write-capability and policy regression tests and package typecheck.

## Task 2: Single-write patch adapter

**Files:** `packages/development/src/patch-tracker.ts`, `packages/development/test/patch-tracker.test.ts`.

**Interfaces:** Add `captureAgentEditWithWriter(edit, writer)` on PatchSession; writer receives normalized relative path, bytes, before snapshot and optional mode. It must resolve only after the host-approved write finishes. Existing `captureAgentEdit` delegates to the same transaction using the current safe writer.

- [x] Add a callback-count regression proving exactly one delegated write, plus stale input, failure, new-file and evidence rollback cases.
- [x] Preserve before/after hash and inode checks, rollback refusal for concurrent edits, and durable evidence ordering.
- [x] Run patch-tracker regressions and development typecheck.

## Task 3: Official Agent setup propagation

**Files:** `packages/harness-adapter/src/harness-agent-runtime.ts`, `verified-agent-port.ts`, related tests; Bundle's verified Agent options.

**Interfaces:** Optional host-owned setup factory receives the trusted request and the official Agent setup context. Forward through `agents.create({ setup })`, never install after followup. No setup means legacy diagnostic/lifecycle behavior.

- [x] Prove setup runs before followup and setup failure creates no usable application Agent handle.
- [x] Preserve disposal, cancellation, schema prompt and host usage accounting behavior.
- [x] Check runtime structural compatibility against installed rc.6 types and existing official lifecycle probe.

## Task 4: Managed read/write tools and guard

**Files:** New focused Bundle tool module and tests; production composition uses explicit task-bound policy/ownership/patch contexts.

- [x] Register `backend_team_read` and `backend_team_write` only in managed Agent contexts.
- [x] Reject mismatched Agent identity, undeclared paths, stale ownership, unavailable phase, raw native tool calls and unsupported unbudgeted commands.
- [x] Read through approved descriptor; update/create through Task 1 inside Task 2 writer callback. Never invoke two writers for one edit.
- [x] Keep missing command/verification and specification-scope capabilities visibly blocked; do not claim full writable Profile merely because file tools exist.

## Verification and integration

- [x] Review the actual diff for privilege widening, setup lifecycle races and cleanup failures.
- [x] Build, typecheck, lint, relevant regressions and packed Bundle checks.
- [x] Codex Chrome verifies allowed scoped writes and denied out-of-scope/native-tool attempts against a host-owned isolated fixture.
- [ ] Real DeepSeek validation requires user-configured credentials. Official Spec Kit requires the separately authorized local Python environment; neither is substituted by a fixture.
