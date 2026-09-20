# DbGate lifecycle regression evidence

Date: 2026-09-05. Continuation from `4771563`, in the Codex linked worktree.
Runtime: workspace-local Node.js `24.19.0`, copied with existing development
dependencies from the main checkout. The initial lifecycle regression did not
download third-party packages; the subsequent user-authorized installation and
real GUI run are recorded below.

## Verified application behavior

The launcher tests exercise the real `DbGateLauncher` with controlled process
adapters. They do not run DbGate or prove its GUI, authentication, or Node
compatibility.

- Listener inspection exceptions, unsafe listeners, readiness rejection, and
  readiness exceptions all attempt child cleanup without publishing a URL.
- A successful cleanup leaves no stale URL fingerprint and allows a fresh start.
- Failed cleanup retains the child in `interrupted` state. The original startup
  and cleanup errors are preserved in an `AggregateError`; restarting is rejected
  until a subsequent stop succeeds.
- A failed normal stop withdraws navigation and retains the same cleanup handle.
- Concurrent starts reuse one launch. A stop submitted while spawn is pending
  waits for startup settlement and stops the resulting child.

Before implementation, four rollback assertions failed (leaked process, stale
fingerprint, and lost cleanup failure), followed by two failing concurrency
assertions (duplicate start and missed stop). The final launcher file contains
10 passing tests, including its two existing tests.

## Installation and data-directory preflight continuation

The installer now rejects symlinks in each managed directory component before
creating descendants or invoking the npm runner. This includes aliases pointing
elsewhere inside the workspace. Three external redirection cases and one internal
alias case failed against the old installer, then passed after the fix. The tests
use real temporary directories and symlinks, with a controlled runner that does
not invoke npm or download packages.

The macOS adapter similarly rejects redirected `home`, `tmp`, and `user-data`
directories before supervisor start. It fixes `WORKSPACE_DIR` to the validated
runtime directory, just as it does `HOME` and `TMPDIR`. Three redirected-directory
assertions and the external user-data environment assertion failed before the
adapter fix. The focused installer/adapter/launcher suite passed all 21 tests.

Review then identified that direct adapter construction could still alias the
runtime root or its ancestors. Three additional tests reproduced that bypass;
the adapter now checks each original path component back to the workspace
boundary before creating data directories. A compatibility test also retains
support for an alias of the selected workspace itself. The installer rechecks
directories before the runner and after a successful runner result; failed runner
results are rejected and do not certify the remaining filesystem state.

These checks cover preexisting directory redirects. They are not an operating
system sandbox, an audit of every nested runtime file, or a guarantee against
another process replacing directories after validation. Actual DbGate filesystem
and security acceptance remains outstanding.

## Fresh checks

Run with the workspace Node `bin` directory first in `PATH`:

```sh
npm test -- --run \
  --exclude packages/development/test/new-project-template-isolation.test.ts \
  --exclude tests/integration/spec-kit-real-cli.test.ts
npm run lint
npm run typecheck
npm run build
node scripts/test-packed-bundle.mjs
git diff --check
```

After the directory-preflight continuation, the selected regression suite passed:
**141 files, 1,042 tests** after the protected-login, readiness, dependency-policy,
composition and release-scan corrections (the earlier GUI run passed 1,027). Lint, all
workspace typechecks, build, and the packed Bundle check passed. The Bundle check
verified its 11 expected archive files.

The template isolation test was excluded because it downloads a fresh Node
runtime and installs project packages. The real Spec Kit test was excluded
because it needs separate runtime-install and CLI initialization approval
materials. This is not a claim that the complete suite ran.

## Authorized real-runtime acceptance

DbGate Serve and PostgreSQL plugin 7.2.3 were installed in the workspace with
npm lifecycle scripts disabled. A timed-out install left an inconsistent lock;
the task-created installation was rebuilt cleanly. The current lock has 870
non-root entries and the installed inventory has 862 packages (819 distinct
name/version pairs). Installation and audit artifacts are under
`.backend-team/artifacts/dbgate-gui-acceptance/`.

Actual 7.2.3 source inspection exposed ignored `DBGATE_*` configuration names.
The application now supplies `LOGIN`, `PASSWORD`, `PORT`, `WORKSPACE_DIR`,
`TOKEN_LIFETIME` and `LANGUAGE`. Disabled boolean options are empty strings:
this runtime treats nonempty `"0"` as enabled. Single-connection settings require
a concrete connection identifier and database, so the generic builder does not
invent these values.

Codex Chrome, through the installed Chrome extension, exercised the actual
DbGate server on workspace Node 24.19.0 and native arm64 PostgreSQL 18.6:

- Wrong credentials were rejected; the ephemeral correct login opened a live
  PostgreSQL connection to disposable `p_gui_design`.
- Add New → Table created `public.gui_acceptance_items`, with serial integer
  `id`, text `label`, and primary key `PK_gui_acceptance_items`.
- GUI data entry inserted `gui`, then updated it to `gui2`. Both operations
  showed SQL previews before confirmation.
- GUI editors added `idx_gui_label` and the self-referencing `fk_gui_self`.
  Independent psql queries confirmed the row, index and foreign key.
- `p_gui_dev.baseline` retained `1|development unchanged`, with no acceptance
  table in that database. The main DbGate listener was `127.0.0.1:62609`.
- Managed shutdown completed with no errors. Subsequent OS listener checks found
  no listeners on the DbGate and PostgreSQL acceptance ports (62609 and 61991).

This was a direct-adapter acceptance harness using the real ProcessSupervisor,
an exact test capability and bounded readiness polling. It did not run the
production Bundle/coordinator. Later launcher and protected-login checks are
recorded below.
Initial text-fill attempts did not commit grid changes; native key events did.
The empty-database shortcut did not open the editor during this run; Add New
worked. Server logs also recorded downloading 14 cloud files: disabling private
cloud does not prove absence of outbound traffic.

The initial npm audit reported 30 findings (1 critical, 10 high, 17 moderate, 2 low);
OSV reports 9 affected package versions. These are release blockers, not silently
accepted exceptions. The `http@0.0.0` OSV malware advisory matched an installed
package containing only its package.json, with no executable or install script;
that observation does not dismiss the advisory. No automatic downgrade/fix was
applied in that initial run. Its audit files are preserved in `before-overrides/`.

## Blocking-item remediation continuation

The installer now applies reviewed, exact overrides while retaining DbGate 7.2.3:
`dbgate-api > tar@7.5.22`, `dbgate-api > jsonwebtoken@9.0.3`,
`flat-cache > flatted@3.4.4`, `external-editor > tmp@0.2.7`, and
`qs@6.16.0`.
Conflicting runtime package settings fail before npm; the manifest is updated
atomically without following file symlinks. Existing unrelated settings remain.
Fresh installation produced 870 dependency lock entries and 862 installed
packages. The official registry release metadata identifies `qs@6.16.0` as
published on 2026-08-29 with a verified integrity hash; a package-specific OSV
query for that exact version returned no vulnerabilities. A subsequent full npm
audit using workspace Node 24.19.0 and the official registry confirmed the
remaining graph is **3 high, 15 moderate** (18 total). Report:
`npm-audit-after-qs-node24.json`. No residual-risk exception was accepted.
`xlsx` and the unused `http` dependency remain blockers.

Real-runtime compatibility checks passed for tar extraction, flatted circular
serialization and tmp name generation under the same workspace TMPDIR as the
runtime. The qs validation also passed nested URL parsing/stringifying, form
parsing, DbGate readiness, invalid login rejection, valid form login and an
authenticated connections request under Node 24.19.0. Codex Chrome also passed
the protected login flow, connected to the isolated native PostgreSQL design
database and read the baseline row; the development database readback remained
`1|development unchanged`. The fixture stopped without cleanup errors. Evidence:
`qs-chrome-evidence.json`. The initial tmp probe used
the host TMPDIR and correctly rejected an external directory; correcting the
probe environment passed. Real login tests exercise the overridden jsonwebtoken
sign/verify path. Current reports are `npm-audit.json`, `osv.json`,
`qs-6.16.0-validation.json`, `override-api-compatibility.json` and
`protected-login-security.json`.

The real launcher now waits up to 30 seconds for its own requested loopback
listener and HTTP readiness. Empty listener sets no longer imply ready; a
different server's HTTP response cannot satisfy the child-ownership check.
Timeout, including a hung probe, triggers cleanup. Actual cold starts reached
readiness in approximately 494–504 ms on this machine.

Login handoff now uses a host-authorized, session-bound grant expiring after
60 seconds and consumed once. The dedicated same-origin POST route rejects
unauthenticated, wrong-workspace, read-only and cross-origin requests; no login
secret is included in ordinary state/events/navigation URLs. The actual React
overlay displays the login briefly, clears it on navigation/session change and
exposes the database-tool button that was previously missing from its rendering.

Codex Chrome verified the actual overlay → DatabaseExecutionPort → dedicated
login route → real DbGate login chain. This used an isolated local host with a
test session cookie, not the official Harness production profile. Independent
HTTP probes verified: unauthenticated connection access **401**, repeated login
handoff **409**, shell-script execution rejected, shell connections/scripting,
authentication bypass and private cloud all disabled in actual runtime config.
The host, DbGate and PostgreSQL stopped without errors; ports 57534, 54210 and
52352 had no remaining listeners.

Core now builds ApprovalService, SpecificationCoordinator and its workflow
against its internally created coordinator/state/orchestration; Bundle activation
accepts validated specification ports. Deterministic-agent integration tests
reach persisted `AWAIT_REQUIREMENTS_APPROVAL` through the real application action.
This is composition evidence, not a real-model or full production-host result.

## Design connection and approval settlement follow-up

The launcher now resolves the PostgreSQL credential reference through its
CredentialStore and builds a predefined connection itself. Only generated
`design_<16 hex characters>` database names are accepted. DatabaseExecutionPort
requires an owned design-session provider and creates the GUI database from the
project development database; missing configuration fails closed.

Codex Chrome exercised this path without test connection environment injection.
The actual overlay delivered the temporary login, DbGate automatically connected
to `design_a6a611ba03a8d528` on native PostgreSQL 18.6, and a grid edit plus SQL
confirmation changed baseline.note to `design`. Independent psql readback
returned `design` in the design database and `development unchanged` in
`p_gui_dev`. Evidence is in `design-session-gui-evidence.json` and
`design-session-service-evidence.json` under the local acceptance artifacts.
This remains an isolated cookie host, not an official Harness production profile.

Core approval decisions can now await the real approval transaction using
`decideAndWait`. Tests hold the transaction open to prove the response waits,
and cover rejection, changed artifacts and storage failure without advancing
state. The subsequent production control follow-up below adds live projection and an
explicit request/retry entry for the authenticated handler.

## Remaining acceptance boundaries

- Basic real GUI and dedicated login acceptance are verified above. Complete API restriction
  probes, descendant listener/filesystem confinement, and GUI-to-migration
  production workflow acceptance remain outstanding.
- The dedicated handoff is wired into the optional production database port,
  but official Harness session/profile acceptance is still required. The host must still assemble the production design-session and credential
  providers; automatic connection generation is now verified locally.
- The internal workflow is connected; development/pause/recovery/artifact control integration and official end-to-end
  scenario execution remain open.
- No DeepSeek key was present in the inherited environment, default Harness
  credential file, default Harness dotenv or this worktree's dotenv. Other
  profiles/custom paths were not certified; no real-model request was made.
- This change does not supply PostgreSQL x64 artifacts, release signatures/URLs,
  a real DeepSeek model request, or complete production coordinator acceptance.

See [release evidence](release-evidence.md) for the broader release gates and
[operations](../operations/postgresql-and-dbgate.md) for cleanup recovery.

Final lifecycle follow-up also exercised a fresh design session
`design_354b911f5e2c9ede` through Chrome after the cleanup changes. Both local
acceptance stacks stopped successfully; ports 60023/60272/58592 and
61268/52589/62995 had no remaining listeners. Concurrent GUI opens are serialized;
failed GUI termination retains the owned design database and PostgreSQL for
cleanup retry. Failed initial schema capture attempts to discard the new database.

Approval shutdown now closes admission and drains already-decided settlements
before production disposal returns. An explicit approval ID cannot be reused
while its transaction is settling. A controlled real ApprovalService transaction
test covers shutdown waiting; synchronous legacy disposal remains available.

## Production control and migration follow-up

The opt-in production host now accepts a post-activation command factory. Its
callbacks can read the actual composition state and await real approvals;
there is no need to capture a separate state store before activation. The
production GUI callback now returns the required navigation discriminator.
Codex Chrome exercised the actual production host, command adapter, control
route, login route, DatabaseExecutionPort and DbGate launcher together and
connected to `design_605572cca210588b` on native PostgreSQL 18.6. The fixture
retained an isolated cookie authenticator and did not use an official Harness
profile. The host/GUI/PostgreSQL stack stopped without errors.

Live approval requests are projected from the composition's in-memory approval
port. Same-sequence approval notifications are delivered without altering the
durable revision; the browser accepts this limited change while rejecting
contradictory durable fields. Inspection state now reaches the rendered confirm
button. The factory path exposes an explicit request/retry action for waiting
requirements and design gates. It starts the real workflow approval and returns
only after its request exists; a failed/rejected request can be replaced with a
new request ID. Shutdown closes admission and drains active control handlers
before removing their event subscriptions or stopping databases. Database stop
failures remain retryable through host disposal.

Codex Chrome exercised the actual overlay and production control route through
requirements approval, design generation, design approval and task generation.
The durable result was `BUILD`, revision 6, two approvals and zero pending
requests. Evidence: `.backend-team/artifacts/approval-control-chrome-evidence.json`.
This used deterministic agent results and prepopulated artifact documents shown
in the fixture page. It is not evidence of real-model artifact generation,
general artifact navigation, execution of development tasks, or official Profile
acceptance.

Migration verification now binds immutable SQL previews to returned evidence,
requires an actual prior baseline for upgrades, tests both empty/upgrade paths,
and cleans both uniquely named databases even when creation completion is
uncertain. Hash mismatch, missing capabilities, invalid evidence and cleanup
errors fail closed. High-risk verification cannot waive its approval/snapshot
requirements. A verification snapshot is only test evidence, not a production
backup. Approval-token authenticity/SQL binding and a pre-apply production backup
still require the production approval/application boundary.

A native PostgreSQL 18.6 fixture exercised GuiToMigration with MigrationVerifier,
empty database creation, prior-schema initialization, exact upgrade SQL,
integration tests, rollback schema checking, application to an isolated dev
fixture, and cleanup. Both verification databases were removed. Evidence:
`native-migration-evidence.json` in the local GUI acceptance artifact directory.
The schema comparison in this fixture covers the baseline table's columns,
types and nullability; it is not a general schema comparison implementation.

### 2026-09-15 — unused HTTP dependency remediation

The reviewed DbGate installer now enforces `http@0.0.1-security` for the unused
`http@0.0.0` declaration. The runtime profile now installs only
`dbgate-api@7.2.3`, `dbgate-web@7.2.3` and `dbgate-plugin-postgres@7.2.3`.
It generates a reviewed launcher and copies only the PostgreSQL plugin into an
allowlisted directory. `dbgate-serve`, `dbgate-plugin-excel` and `xlsx` are
excluded from the dependency lock and rejected by the native launcher if they
are present. This removes the high-severity `xlsx` path from the Agent Team's
DbGate runtime. A fresh registry-backed audit of the new lock reports 0
critical, 0 high and 8 moderate findings; the remaining formal gates are
PostgreSQL provenance, release signing and distribution metadata.
The installer also removes stale entries recursively before npm runs and fails
closed if a disabled package is reintroduced anywhere in `node_modules`.
