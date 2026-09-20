# Agent Team limits and authority

Stage 04 implements an application-local, mock-driven coordinator boundary. It
does not claim that DeepSeek Harness production Agent/event APIs are wired;
that seam remains a Stage 07 responsibility.

## Topology

The only supported topology is:

```text
coordinator (depth 0)
└── expert (depth 1)
    └── worker (depth 2)
```

The coordinator creates and accepts expert tasks. An expert can request a
worker only through the bounded coordinator callback. A worker cannot create
another agent, change phase, approve artifacts, contact the user, or announce
completion. The coordinator is the only component that writes canonical team
state and exposes user-facing actions.

## Concurrency and budgets

- At most 3 depth-one experts run concurrently.
- At most 2 tasks with declared write paths run concurrently.
- Each expert has at most 3 children, subject to its remaining budget.
- Task budgets are monotonic: consumed capacity is never returned.
- Pending spawns receive an abort signal; cancellation retains leases until the
  spawn/result promise settles.
- A depth-one expert receives only `delegateWorker`; the callback re-runs the
  coordinator's phase, policy, capability, budget, artifact, and ownership
  checks and is revoked when the expert run settles. Workers are never given
  that callback, and diagnostic snapshots contain no callable delegation
  handles.
- A callback-created worker may overlap its direct parent's lease only for
  paths already covered by that parent lease. The overlap is recorded as a
  delegated lease and remains fail-closed during recovery; unrelated tasks
  still conflict on any read/write overlap.

## Files, context, and results

Every task has explicit read/write paths and a serialized bounded context. The
context carries only the objective, non-goals, approved artifact hashes and
excerpts, project facts, capabilities, budget, done criteria, and return
schema. Credential-like values, raw-conversation markers, binary/oversized
excerpts, cycles, and unsafe metadata are rejected or redacted.

Results are accepted only after schema, current input hashes, declared path
ownership, evidence paths, command exit codes, verification records, budget,
and durable child handoffs pass validation. Handoffs are written atomically
under `.backend-team/handoff/`, bound to their parent task, and retained until
that parent acknowledgement is durable. Parent acknowledgements are
immutable.

## User-facing actions

The application action catalog intentionally exposes status only in this stage.
Internal spawn/delegation is not registered as a general user tool. Any future
Harness adapter must re-authorize each side effect through the policy engine
and pass the production seam and provenance gates before enabling write
actions.
