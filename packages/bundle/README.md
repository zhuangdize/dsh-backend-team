# `@dsh-backend-team/bundle`

This Bundle supports an opt-in production workflow for DeepSeek Harness through
its official bundle manifest. Without a configured production host it remains a
diagnostic installation; with `productionHost` enabled, the root plugin wires
verified local sessions, chat tools and the actual Backend Agent Team.

The browser entry `./client` adds a `conversation.view` tab named 团队进度.
Ordinary chat is the task entry: requirements and design are previewed in chat,
explicitly confirmed, then followed by managed planning, development and testing.
The secondary tab shows progress, artifacts and approval controls without covering
the conversation list. Controls use the authenticated same-origin host route and
never store credentials or reusable approval tokens in the browser.

Conversation tasks have independent specification, state, event and development
records. New tasks retain historical delivery records. Only one unfinished task
may write within a shared workspace. See [usage](../../docs/operations/automatic-development.md).

The manifest deliberately exports `./package.json` as well. The rc.6
`clientModules` host resolves each `dsh.client` declaration through the package
manifest before it serves the browser bundle; omitting this export causes a
valid client entry to be skipped without adding it to `window.__DSH_BOOT__`.

The current official rc.6 context does not expose a trusted Harness host version,
so the Bundle reports `version: "unknown"`, `mode: "read-only"`, and
`evidenceStatus: "unknown"`. The checked-in external compatibility matrix marks
exact `0.1.0-rc.6` as `verified` after a pinned disposable Profile pack/add/dump,
real Cordis boot, and official `ctx.tools.execute` invocation. That evidence
proves the external Profile/tool path only; it is not a trusted runtime-version
signal and does not promote the production Bundle into a writable mode. This diagnostic behavior applies when no production host is configured.

The package also exposes an explicit `./production` entry with a
`createProductionActivation()` helper for verified host binding. It
requires the host's official `ctx.agents`
service, an existing workspace directory, a recovery token, and an application
policy engine. If any input is absent or invalid it returns a frozen
`mode: "read-only"` result and does not create managed workspace state. With all
inputs present it creates the workspace-local production composition and
returns its idempotent disposer. The `apply()` entry activates the conversation task host only when explicitly configured; production release evidence remains a separate gate. Hosts that have separately verified the Web
Server and authenticated session seams may use
`createBackendTeamProductionHost()` to compose the production activation,
persisted-event control surface, coordinator handler table, and loopback route
with one reverse-order disposer. The helper does not invent coordinator or
database implementations: those handlers remain explicit host inputs, and a
missing activation capability still produces a route-free read-only result.
For an actual rc.6 Cordis context, `createDshProductionHost()` is the preferred
convenience entry. It checks `ctx.webServer.host === '127.0.0.1'`, adapts the
official `ctx.webServer.register()` method, and creates a per-request Session
extractor backed by the exact `ctx.sessions.get()` and `ctx.agents.get()` stores.
The lower-level `createVerifiedDshHostPort()`,
`createVerifiedDshSessionPort()`, and `createVerifiedDshAgentPort()` exports are
available when a host wants to compose the three ports itself. These helpers do
not change the diagnostic default or treat a browser-supplied session object as
authentication.
Hosts that already own a `ContextManager`/LangGraph execution session may pass
an explicit `executionSessionFactory` to the activation or Agent-port options.
The runtime records the real prompt, optional projected prompt, assistant
messages and model usage through that binding; it never creates an implicit
no-op checkpoint or changes DSH's Agent authorization.
The `./production` entry exports `createLongTaskExecutionSessionFactory()` to
adapt the existing `LongTaskExecutionSession`; the host must supply its
cross-process run lease and `OwnershipManager` assertion, and may provide a
prompt renderer for the prepared projection. The helper is opt-in and does not
enable LangGraph in the production Bundle. The configured document workflow
host uses this binding for development tasks when development execution is
explicitly enabled, sharing the development run lease with nested Agent
sessions. Specification-only Agents continue through the normal Harness
lifecycle because they do not hold source ownership leases.
The companion `createCoordinatorCommandHandlers()` helper builds that complete
handler table from explicit workflow/database/artifact callbacks. It checks the
authoritative state revision before and after every callback and accepts a GUI
navigation only when it is loopback-only; it does not perform any side effect
itself. `createBackendTeamProductionHost()` accepts either this helper's
`coordinatorImplementations` input or a prebuilt `coordinatorHandlers` table;
both cannot be supplied together.

The database package exports `createDatabaseExecutionPort()` as the reviewed
workspace-local PostgreSQL execution boundary. It delegates only to constructed
`PostgresqlCluster`, `DatabaseCatalog`, and optional `DbGateLauncher` instances,
keeps PostgreSQL and DbGate on loopback, returns expiring GUI URLs, and disposes
DbGate before PostgreSQL. When the port exposes `prepare()`, the production
`start-database` command also creates the workspace development/test databases.
Pass its `verifiedProvenance` port as `databasePort`
to `createBackendTeamProductionHost()` to fill the three revision-fenced
database commands; raw executables, credentials, and arbitrary SQL are not
accepted by this boundary.

The core package also exposes `createApplicationWorkflowAdapter()` for hosts
that have verified the Spec Kit/coordinator ports. It maps the two user approval
gates to the existing phase graph: requirements approval runs the architecture,
database, and OSS design experts; design approval runs task planning. It does
not provide a default Spec Kit, Agent, database, or recovery implementation.
For the rc.6 host session shape, `createDshLocalSessionInput()` is provided as
an opt-in adapter. It accepts the current session id from the route query and
checks both live DSH stores plus the session cwd against the canonical
workspace before the control service sees the request.

The web package's `createBackendTeamControlClient()` is the corresponding
browser-side bridge. It receives a host-owned transport, validates state and
responses, blocks stale commands, and requires an approval artifact to be
inspected before confirmation. Pushed snapshots are monotonic, so delayed
responses cannot roll the panel back. It does not store credentials or replace
the server's authorization checks.

This stage deliberately registers no global guard and no development, install,
database, or Agent tools. It does not modify a user project. Later write/process/
network/database capabilities must be re-authorized at their side-effect adapters;
tool visibility or a Harness guard is not the authoritative safety boundary.

When explicit `specification` ports are supplied to `createProductionActivation`,
SPECIFY, DESIGN and PLAN Agents receive separate document-only read/write tools.
The active feature directory must already exist at `workspace/specs/<feature>`.
Requirements, architecture, database design, research and planning roles each
own only their named artifacts. During DESIGN, the architecture role also owns
`contracts/openapi.yaml`, which the real design validator requires. The host must
prepare the real `contracts` directory; other roles can only read a declared
contract input. Other nested paths and contract writes in other phases are denied.
Tasks carry exact file scopes and bounded usage; failed, mismatched or over-budget
Agent results do not advance the workflow. Agent-scoped Cordis effects release
write leases after outstanding file operations finish.

The host policy must explicitly authorize each allowed document read/write.
Passing an unconfigured `DefaultPolicyEngine` alone does not authorize writes:
its `deny-unknown` result remains a denial at the host boundary. The separate
specification write verifier also checks the active feature, role, phase,
current approval and ownership before using guarded file handles. These tools
do not grant shell commands, business-code writes, deployment or approval.

`specification.budget` accepts required `maxAgents` and `maxSteps`, plus optional
positive integer `maxTokens` and `maxWallMs`. The latter limits apply to each
expert task; defaults remain 131072 cumulative tokens and 180000 milliseconds.
Cumulative tokens include repeated prompt/cache input across model calls, so
this limit is distinct from the provider's single-response output limit.
Invalid limits fail before activation creates workspace state. Explicitly
raising a host limit does not disable result usage validation.

Specification tasks reserve one retry shared by provider retries and an optional
single result-format correction. Only JSON syntax errors or otherwise valid
results with extra top-level fields qualify. During correction all Agent tools
are disabled, both model calls count toward token/time limits, and cancellation
still waits for ownership cleanup. Missing fields, wrong task identity, invalid
host usage and failed verification remain errors. The decoder never silently
strips extra fields or turns failed verification into success.

Before PLAN can enter BUILD, the host must provide
`specification.taskPlanLoader` with the real `FileDevelopmentPlanLoader` bound to
the same workspace and artifact registry. The option can be omitted for earlier
specification stages, but `generateTasks()` then fails before dispatch. After the
planner returns, the coordinator checks feature identity, loads/parses the actual
plan, and rechecks design approval before advancing. A rejected or missing plan
keeps PLAN available for repair and retry. A successful AgentResult alone is not
proof of an executable development plan.

Specification Agent context includes separate application `outputInstructions`:
required document sections, acceptance IDs, OpenAPI and task metadata syntax.
The official command text and its recorded source hash are preserved. Instructions
do not authorize shell scripts or extension hooks from the source prompt.

The `@dsh-backend-team/bundle/production` export is also an optional Cordis plugin
with `webServer`, `sessions` and `agents` injection. Its configuration requires
`enabled: true`, a canonical `workspaceRoot`, and one safe `feature` name; optional
`provider`, `model`, `workspaceName`, `maxTokens` and `maxWallMs` select the route and
budget. It requires an already initialized official generic Spec Kit project and
does not install runtimes. The root plugin remains diagnostic/model integration.

This entry enables the document workflow only: requirements, user approval,
design, user approval, and validated planning. It prepares the feature/contracts
directories and retains a private recovery key in workspace state. The host policy
allows only known specification documents and delegates role/phase/ownership
checks to the guarded tools. Development execution and database controls are
optional and require the configuration described below. Custom hosts can also
compose reviewed execution ports through `createDshProductionHost`.

DSH production hosts now default to an authenticator paired with the verified
session extractor. It rejects copied identity objects and rechecks the actual live
session/Agent stores on every authentication. Restored durable phase/revision seed
the control projection so an older event history cannot make every action stale.
The document host exposes phase-checked recovery for DESIGN and PLAN. Recovery
is refused while the scheduler has active or queued work or an approval is
pending. It reruns the coordinator with the current approved documents; it does
not bypass validation or approve documents automatically. Managed model runs
are cancelled when their wall-time budget expires.

The optional `@dsh-backend-team/bundle/production` host accepts
`development: { enabled: true, writeRoots: ['src', 'test'] }` to connect the
existing development controller. The default remains document-only. The
current executor requires macOS and Node 24+, runs declared JavaScript Node
test files, denies writes/child processes/external network, and permits
loopback HTTP checks. It does not run arbitrary shell commands, installations,
migrations or deployment. Task slices must own their implementation and
runnable tests together; approved documents are read inputs, not write targets.
The host supplies command exit evidence and refuses a passing result without
successful tests after the last Agent edit. A service restart compares persisted
requirements/design approvals with current documents and returns stale approvals
to the relevant review stage without approving the replacement documents.

After every slice has an accepted handoff, the configured host reruns all declared
Node test files together under the same managed executor, without a model call.
It checks approval and file snapshots before/after execution and saves a private
`.backend-team/final-verification-*/report.json` with the plan hash, input/output
file hashes, test invocation and captured result. Failure or changed inputs cannot
produce a passing final check. The page shows the outcome, scope and report path;
resuming an accepted checkpoint runs this check again. Reports remain on disk
after restart. Completed delivery reviews are recovered only after checking the
report, approved artifacts, current plan, host bindings and recorded file hashes. This check covers
the declared Node workload only; generic builds, deployments and external
services are outside this verification scope.

The same report and page now include a delivery review with each requirement's
expected and missing evidence IDs and the slice handoffs' unresolved items.
Without reviewed mappings, aggregate Node success leaves requirements `not-run`;
neither file names, broad command purposes nor Agent summaries identify evidence.
Requirement aggregation requires every expected evidence item before passing.

The protected workflow-host configuration accepts `finalEvidenceBindings`:
`planHash` pins the canonical development plan; `tests` entries contain a planned
`file`, its `sha256` and explicitly reviewed `evidenceIds`. The host runs the
actual Node test CLI; skipped/todo cases cannot establish passing evidence.
Optional `reviewedReports` entries pin a host report by `file`, `sha256` and
`evidenceIds`. Each report records its real argv, timestamps, duration, passing
status and file hashes, including every planned output. This is an explicit host
review of existing evidence, not an automatic trust decision about Agent reports.
Plan, test or report drift blocks acceptance until the mapping is reviewed again.

Optional `resolutions` contain the SHA-256 of an exact outstanding item
(`itemSha256`), supporting `evidenceIds` and a review `reason`. Only passing
bound evidence resolves an item; the original text and resolution remain in the
final report. Delivery readiness rejects missing requirements, nonpassing tests
or remaining items. The host enters VERIFY before final checks and stores the
review and report digest durably. Complete acceptance advances to DELIVER;
incomplete acceptance retains VERIFY and offers a retry. On startup, matching
results restore the same review without new model calls or test execution.
Missing or changed evidence clears the live review and returns a delivered
project to VERIFY. Reports remain historical records on disk. This verification
is performed on restart and finalization, not continuous monitoring of edits.
Initial connection failures retry at the existing refresh interval, stop after
connection, and cancel when the current session changes or the panel unmounts.

On macOS, `database: { enabled: true, executableRoot: '/absolute/workspace/.backend-team/runtime/postgresql-18.6-arm64' }`
enables PostgreSQL start/stop buttons and live status. The executable directory
must already exist, be canonical, remain inside this workspace's runtime directory,
and pass version/binary dependency inspection. This option does not download it.
The host stores the cluster and owner-only credential files in
`.backend-team/runtime/workflow-postgresql`, reuses them after a clean shutdown,
and stops its owned database on orderly host shutdown. Do not delete this directory
to repair a failed startup. The database listens only on loopback with SCRAM
authentication; Unix sockets are disabled when their path exceeds macOS limits.
To enable the installed PostgreSQL-only DbGate 7.2.3 runtime, add
`database.dbgate: { enabled: true, runtimeRoot: '/absolute/workspace/.backend-team/runtime/dbgate', port: 3081 }`.
The installer places `dbgate-api`, `dbgate-web` and `dbgate-plugin-postgres` in this
runtime, then generates a launcher and an allowlisted PostgreSQL plugin directory.
The Excel connector and `xlsx` dependency are deliberately excluded. The Node
executable, runtime and bundled loopback preload must reside inside this workspace.
Port 3081 is an example; select a free high port. The host authenticates
the initiating session before delivering a one-time login grant. DbGate connects
to a disposable clone of the development database. Stopping the database stops
DbGate first and discards that clone. This option does not install packages or waive release gates.

Set `database.migrationToolingRoot` to an absolute workspace runtime directory
containing Drizzle Kit 0.31.10, Drizzle ORM 0.45.2 and pg 8.23.0 to enable
“生成数据库迁移”. Save the design in DbGate, generate and inspect the SQL in DSH,
then approve or reject through the existing authenticated control surface.
Generation verifies a disposable clone; approval checks schema freshness, saves
a complete development-database backup and applies the exact reviewed SQL in a
transaction. Generated schema/SQL and review/application records remain in that
tooling directory under `generation-*`. To include a project Drizzle source in the
same review, set `database.ormSchemaPath` to its workspace-relative path; the source
is previewed beside the SQL and written atomically only after approval, with a
hash check and rollback when migration execution fails. Backups are retained.
Pending approvals and the owned design-session record are restored after a host
restart when the same local PostgreSQL cluster and design database are available;
changed revisions, target identities or regenerated SQL block the restore.
Restart the DSH backend after changing the plugin or this configuration.

### Conversation entry for the configured project

The production plugin registers `backend_team_status` and
`backend_team_workflow` through the official tools service. Set
`diagnosticStatusTool: false` on the base Bundle entry when enabling production
to avoid registering the legacy compatibility-only status tool under the same
name. Standalone diagnostic installations keep their existing default.

The chat status uses the same host-issued session identity and control projection
as the page. The calling Agent must be live and belong to the configured workspace.
It reports the actual phase, revision and scoped delivery result, not an inferred
Harness version. The workflow tool requires the observed revision and supports
requirements submission, phase continuation, development pause, artifact preview,
approval/rejection and database start/stop/migration preparation.

Approval requires a preview of the exact current artifact in this chat, then a
one-time grant from the official DSH approval service attached to that tool call.
Rejection, unavailable approval, cancellation, changed revisions and changed
artifacts cannot approve a plan. Display the returned artifact before asking the
user to confirm. The model cannot supply an approval flag as a substitute.

Examples in the configured project's chat: “查看后端团队进度”, “继续后端团队任务”,
“展示待确认的设计方案”, “确认这份设计并继续”. A completed task remains preserved:
creating or rebinding a new project/task is not yet a chat capability.

### Team progress workspace

The client contributes an additive “团队进度” conversation view beside Chat and
Trajectory; it no longer registers a frame-wide overlay or replaces navigation
or tool details. The workspace prioritizes phase, review requests and delivery
evidence. Execution history and “人工接管” controls are collapsed by default.
Use chat for normal delegation; use the workspace to inspect outputs or review
an approval, and expand manual controls only when intervening.

The conversation tool reports database readiness and tells the Agent to prepare
environments only when the task needs them. Migration preparation starts the
configured database when necessary, rechecks readiness and revision, and stops
on failure. SQL application still requires the existing exact-artifact approval.
This does not mean every arbitrary project can run unattended or that a
no-database task should start PostgreSQL. Unconfigured sessions now show a
project-connection explanation instead of a generic missing-runtime diagnosis.
