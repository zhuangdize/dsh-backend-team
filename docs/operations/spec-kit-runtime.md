# Spec Kit runtime operations

Backend Team keeps the Spec Kit runtime inside the project being assisted. The runtime, Python environment, uv cache, provenance record, state, and locks are under:

```text
<project>/.backend-team/
  runtime/bin/uv                 # workspace-local uv and uvx
  runtime/python                 # managed Python 3.13.15
  runtime/spec-kit/.venv         # Spec Kit virtual environment
  runtime/spec-kit/provenance.json
  cache/                          # approved runtime artifacts and uv cache
  state/                          # phase, approvals, and recovery state
  locks/                          # Team-owned runtime locks
```

No host-global `python`, `pip`, `uv`, or `specify` is used. Runtime installation is a separate approval from requirements and design approval. The approval covers the exact artifact URL, redirect hosts, byte count, SHA-256, destination, and every offline command. A missing approval or a changed digest blocks before a process is started.

## Inspecting the runtime

The persisted provenance record is the audit source for the last completed installation. It records the pinned versions, verified executable paths and hashes, the complete artifact inventory, the offline marker, and the commands that completed. It does not persist command output or secrets.

Expected versions are:

```text
uv       0.12.3
Python   3.13.15
Spec Kit 0.16.5
```

The runtime is reused only after the provenance fingerprint, executable identity, managed runtime closure, active feature path, and required approval hashes pass validation. Reuse does not reinstall completed uv/Python/Spec Kit work.

## Stop and resume

On restart, recovery performs these checks before resuming:

1. Parse and validate the persisted state and workspace root.
2. Mark any `running` run as `interrupted`; an interruption is never treated as success.
3. Validate the active `.specify/feature.json` path remains below `specs/`.
4. Validate runtime provenance, executable paths, and the offline runtime closure.
5. Recompute current feature artifact hashes and compare every required approval.
6. Reclaim only dead, workspace-owned Team locks; active or unsafe locks block recovery.

Recovery resumes at the last persisted verified phase. It never infers an approval from an existing file or runtime directory and never skips a missing requirements or design approval. A stale approval must be requested again after the changed artifact has been repaired.

## Upgrade and removal

Runtime upgrades are manifest changes, not self-updates by Spec Kit. A new version requires a reviewed manifest, a new exact install approval, and a new provenance record. Do not run `uv tool upgrade`, `pip install -U`, or an online Spec Kit command in the Team environment.

To remove the managed runtime safely, stop the Team task, wait for recovery to report no active lock, and remove only the project-local `.backend-team/runtime` and `.backend-team/cache` directories. Keep `.backend-team/state` when audit history and approval decisions are needed. Manually deleting `.backend-team/state` discards phase and approval history; the next run must begin as an unapproved workflow.

## Expected download sizes

The exact sizes are pinned in `runtime-manifests/uv-0.12.3.json` and `runtime-manifests/spec-kit-0.16.5.json`. The downloader rejects a response whose byte count or SHA-256 differs from that manifest. The files are cached under `.backend-team/cache` and may be reused only after identity, permissions, size, and hash checks pass.
