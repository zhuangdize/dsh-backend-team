# DSH Backend Agent Team

[English](README.md) | [简体中文](README.zh-CN.md)

Backend Agent Team is a DSH Bundle for running a chat-first backend delivery workflow. It turns a user request into reviewed requirements, design, implementation, testing, and delivery evidence while keeping authentication, permissions, approvals, and model access in the DSH host.

> **Project status:** the repository contains the source implementation and local verification tooling. Formal release is still gated on externally attested PostgreSQL artifacts, signed distribution materials, and a stable HTTPS download location. See [release blockers](docs/operations/release-blockers.md).

## What it provides

- **Chat-first delivery:** requirements and design are shown in the conversation and require explicit user approval before the next phase.
- **Task center and recovery:** unfinished tasks, queued work, checkpoints, budgets, conflicts, and recovery state remain inspectable across restarts.
- **Agent Team orchestration:** specification, planning, development, testing, and verification roles use bounded ownership and file scopes.
- **Reviewable resources:** the task progress view keeps documents, approvals, questions, test evidence, and delivery results beside the conversation.
- **Database workflow:** optional loopback PostgreSQL and DbGate 7.2.3 integration supports schema review, exact SQL preview, backups, and approval-gated migrations.
- **Model integration:** the DSH host supplies the configured model API and credentials. The Bundle does not store API keys or replace DSH authorization.

## How it works

```text
User chat
   │
   ▼
DSH host (session, auth, model, approvals)
   │
   ▼
Backend Team Bundle
   ├─ requirements → design → plan
   ├─ bounded Agent tasks and checkpoints
   ├─ tests, evidence, and delivery review
   └─ optional loopback database workflow
```

The default Bundle is diagnostic and read-only when the host has not supplied the verified production capabilities. Production activation is explicit and requires host-owned session, Agent, workspace, recovery, and policy inputs. The Bundle does not silently install dependencies, run arbitrary shell commands, deploy applications, or approve documents.

## Requirements

- Node.js **24.x** (`>=24 <25`), as declared by the workspace.
- DSH **0.1.0-rc.6** client/runtime peers for the Bundle package.
- A DSH Web Profile for browser use.
- macOS for the optional native PostgreSQL and DbGate runtime path.
- Model credentials configured in DSH. Keep them in the DSH credential store; never put them in this repository or in chat messages.

## Quick start from source

```bash
git clone https://github.com/zhuangdize/dsh-backend-team.git
cd dsh-backend-team

# Use Node.js 24.x before installing dependencies.
npm ci
npm run typecheck
npm test -- --run
npm run build
```

The root workspace is a private build workspace. `npm run build` produces the local Bundle build; it does not publish a package or deploy a DSH Profile. To build and install a local Bundle into a Profile, follow [macOS installation](docs/operations/install-macos.md) and the detailed [Bundle guide](packages/bundle/README.md).

## Using it in DSH

After the Bundle is installed in a configured DSH Web Profile, use ordinary chat as the entry point. Examples include:

- `Show the Backend Team progress.`
- `Continue the Backend Team task.`
- `Show the design waiting for approval.`
- `Confirm this design and continue.`

Use the **Team progress** view to inspect artifacts, questions, approvals, and evidence. It is a companion to the conversation and does not replace DSH's session list or authorization flow.

The current model API setup is documented in [Model API integration](docs/model-api.md). The legacy Codex App Server adapter is documented separately for reference in [Codex App Server](docs/codex-app-server.md); it is not the default route.

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/bundle` | DSH Bundle manifest, production activation, browser entry, and package README |
| `packages/core` | Workflow state, approvals, requirements/design coordination, and delivery lifecycle |
| `packages/agent-team` | Task scheduling, ownership, budgets, checkpoints, and result verification |
| `packages/development` | Bounded development runs and final verification |
| `packages/database` | PostgreSQL, DbGate, snapshots, schema design, and migration boundaries |
| `packages/web` | Task center, progress view, resources, review cards, and DSH client bridge |
| `packages/harness-adapter` | DSH session/Agent/model adapters |
| `docs/` | Installation, operations, compatibility, design, and release documentation |
| `tests/` | Integration and end-to-end contracts |

## Verification commands

Run the checks that match the change:

```bash
npm run typecheck
npm test -- --run
npm run lint
npm run build

# Optional host and release checks
npm run verify:web-client
npm run verify:agent-runtime
npm run audit:release-materials
```

The checks above validate source behavior and local packaging. They do not by themselves prove a formal public release, a real provider quota, or a production deployment. The remaining release gates are tracked in [TODO.md](TODO.md) and [release blockers](docs/operations/release-blockers.md).

## Security and local state

The `.backend-team/` directory contains local task state, checkpoints, logs, runtime files, and credentials. It is ignored and must never be committed. Generated archives and sidecars are also ignored for source-only publication. Before sharing a fork or patch, scan for API keys, private keys, credential-bearing URLs, local paths, and provider configuration.

The repository has not yet declared a top-level project license. Third-party notices for the Bundle are in [`packages/bundle/LICENSES`](packages/bundle/LICENSES). Do not assume redistribution rights for the project until a project license is added.

## Documentation

- [Automatic development](docs/operations/automatic-development.md)
- [Task conflicts and recovery](docs/operations/task-conflicts.md)
- [macOS installation](docs/operations/install-macos.md)
- [Database and DbGate](docs/operations/postgresql-and-dbgate.md)
- [Upgrade and rollback](docs/operations/upgrade.md)
- [Release evidence](docs/compatibility/release-evidence.md)
- [Bundle API and production activation](packages/bundle/README.md)
