# Backend Agent Team Stage 06: PostgreSQL and DbGate Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a real, workspace-local PostgreSQL development/test runtime, reviewable migration workflow, safe snapshots/recovery, and an authenticated loopback-only DbGate experience that converts GUI schema designs into versioned migrations.

**Architecture:** PostgreSQL 18.6 portable artifacts are reproducibly built from official source for macOS arm64/x64 and installed on demand under `.backend-team/runtime`. A runtime manager owns cluster credentials, sockets, ports, process identity, databases, and snapshots. Schema changes pass through migration adapters; DbGate structural editing occurs in a disposable design database so GUI DDL never becomes the only source of truth.

**Tech Stack:** PostgreSQL 18.6, Drizzle ORM/Kit, pg 8.23.0, `pgsql-ast-parser` 12.0.2, DbGate Community 7.2.3 + PostgreSQL plugin 7.2.3, macOS dual-architecture CI, Codex Chrome for GUI E2E.

**Spec:** `docs/superpowers/specs/2026-08-25-backend-agent-team-design.md`

## Global Constraints

- Follow the master plan and Stages 01–05.
- No Docker, Homebrew service, system PostgreSQL, global npm install, default port 5432 assumption, production connection, or non-loopback listener.
- PostgreSQL binaries, data, socket, logs, PID, snapshots, and credentials references are workspace-local.
- PostgreSQL/DbGate download and installation require exact user approval.
- V1 supports the verified PostgreSQL 18.6 runtime. Existing projects requiring an incompatible major/extension are blocked with an explanation; they are never redirected to a production database.
- Every schema change is represented by project schema code plus a reviewable migration and real PostgreSQL evidence.
- DbGate custom shell connections and shell scripting remain disabled.
- DbGate must be authenticated, loopback-only, process-isolated, and at least the patched 7.1.9 line; V1 pins 7.2.3.
- Every Stage 06 Node/npm/npx command and the dedicated DbGate Node process must use the exact compatible Team runtime resolved below the target workspace `.backend-team/runtime/nvm`; host Node and PATH fallback are forbidden.

---

### Task 1: Reproducibly build and attest portable PostgreSQL 18.6 artifacts

**Files:**
- Create: `runtime-manifests/postgresql-source-18.6.json`
- Create: `scripts/build-postgresql-runtime.sh`
- Create: `scripts/verify-postgresql-runtime.mjs`
- Create: `.github/workflows/postgresql-runtime.yml`
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/src/postgresql-artifact.ts`
- Create: `packages/database/src/index.ts`
- Test: `packages/database/test/postgresql-artifact.test.ts`
- Create after CI build: `runtime-manifests/postgresql-18.6-darwin.json`
- Create: `docs/compatibility/postgresql-18.6-portable.md`

**Interfaces:**
- Consumes: a concrete policy-engine-owned guarded artifact adapter (Stage 01 does not publish `ArtifactDownloader`), platform architecture, and install approval; blocked until adapter security tests pass.
- Produces: `PostgresqlArtifactManifest`, verified `postgresql-18.6-darwin-arm64.tar.gz` and `postgresql-18.6-darwin-x64.tar.gz`.

- [ ] **Step 1: Write failing source and artifact-manifest tests**

```ts
it('pins the official PostgreSQL 18.6 source hash', () => {
  expect(sourceManifest.sha256).toBe('555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f')
})

it('rejects an artifact with a non-workspace-runnable dylib', async () => {
  const result = await verifier.inspect(fixtureWithHomebrewDylib)
  expect(result.errors).toContainEqual(expect.objectContaining({ code: 'EXTERNAL_DYLIB' }))
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/database/test/postgresql-artifact.test.ts`

Expected: FAIL with missing manifest/verifier.

- [ ] **Step 3: Pin official source provenance**

Use `https://ftp.postgresql.org/pub/source/v18.6/postgresql-18.6.tar.bz2`, SHA-256 `555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f`, PostgreSQL License, and release date 2026-08-13. The build rejects any source hash mismatch.

- [ ] **Step 4: Build minimal self-contained runtime on native CI hosts**

The shell script runs with `set -euo pipefail`, an explicit temporary prefix, `MACOSX_DEPLOYMENT_TARGET=13.0`, and this configure profile:

```bash
./configure \
  --prefix="$BUILD_PREFIX" \
  --without-readline --without-zlib --without-icu \
  --without-lz4 --without-zstd --without-ssl \
  --without-libxml --without-libxslt --without-ldap \
  --without-pam --without-bonjour --without-gssapi \
  --with-system-tzdata=/usr/share/zoneinfo
make -j2
make install
```

Build x64 on a native Intel macOS runner and arm64 on a native Apple Silicon runner; no cross-compilation or Rosetta result is accepted. Strip release binaries, include PostgreSQL license/source metadata, create deterministic tarballs with normalized ownership/timestamps, and generate SHA-256 plus GitHub artifact attestations.

- [ ] **Step 5: Verify runtime closure before publishing**

The verifier requires `postgres`, `initdb`, `pg_ctl`, `psql`, `createdb`, `dropdb`, `pg_dump`, `pg_restore`; runs each version command; checks architecture with `file`; checks every Mach-O dependency with `otool -L`; allows only `/usr/lib`, `/System/Library`, and paths inside the artifact; initializes/starts/stops a temporary cluster; and rejects writes outside its temporary root.

- [ ] **Step 6: Generate the concrete runtime manifest and evidence**

After both CI artifacts pass, create `postgresql-18.6-darwin.json` containing their final HTTPS release URLs, exact byte sizes, SHA-256 values, architecture, minimum macOS, artifact attestation IDs, and license files. This task remains incomplete until those concrete values are committed; a generated empty value is a test failure.

- [ ] **Step 7: Run tests and commit**

```bash
npm test -- --run packages/database/test/postgresql-artifact.test.ts
node scripts/verify-postgresql-runtime.mjs --manifest runtime-manifests/postgresql-18.6-darwin.json
git add runtime-manifests scripts .github/workflows/postgresql-runtime.yml packages/database docs/compatibility/postgresql-18.6-portable.md
git commit -m "build: attest portable postgresql runtimes"
```

---

### Task 2: Manage an authenticated workspace-local PostgreSQL cluster

**Files:**
- Create: `packages/database/src/credential-store.ts`
- Create: `packages/database/src/port-allocator.ts`
- Create: `packages/database/src/postgresql-installer.ts`
- Create: `packages/database/src/postgresql-cluster.ts`
- Create: `packages/database/src/postgresql-config.ts`
- Test: `packages/database/test/postgresql-installer.test.ts`
- Test: `packages/database/test/postgresql-cluster.test.ts`
- Test: `packages/database/test/postgresql-config.test.ts`

**Interfaces:**
- Consumes: artifact manifest, install approval, a concrete policy-engine-owned guarded process adapter (Stage 01 does not publish `ProcessSupervisor`), `PolicyEngine`, and an injected secure credential store backed by a verified macOS facility. Stage 01 proves no Harness credential API; any future host-backed credential implementation requires a fresh official API/provenance compatibility gate.
- Produces: `PostgresqlInstaller.ensureInstalled()`, `PostgresqlCluster.initialize()/start()/stop()/status()`, `LocalDatabaseEndpoint`.

- [ ] **Step 1: Write failing lifecycle/security tests**

```ts
it('configures only workspace socket and loopback TCP with SCRAM', async () => {
  const config = await buildPostgresqlConfig(layout, endpoint)
  expect(config.postgresqlConf).toContain("listen_addresses = '127.0.0.1'")
  expect(config.postgresqlConf).toContain(`unix_socket_directories = '${layout.runtimeDir}/postgresql/socket'`)
  expect(config.pgHbaConf).not.toContain(' trust')
  expect(config.pgHbaConf).toContain('scram-sha-256')
})

it('stops only a process matching the stored identity', async () => {
  await expect(cluster.stop(forgedProcessRecord)).rejects.toThrow('process identity mismatch')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/database/test/postgresql-installer.test.ts packages/database/test/postgresql-cluster.test.ts packages/database/test/postgresql-config.test.ts`

Expected: FAIL with missing cluster manager.

- [ ] **Step 3: Implement approved artifact installation**

Download, verify, and extract to `.backend-team/runtime/postgresql/18.6/darwin-arm64` or `.backend-team/runtime/postgresql/18.6/darwin-x64`, selected from the verified platform architecture, using traversal-safe extraction. Require executable real paths within that directory and re-run version/architecture/dylib checks after extraction. Never search `/Applications`, Homebrew, MacPorts, or system PATH for a fallback server.

- [ ] **Step 4: Implement credentials and initialization**

Generate a 256-bit password through `crypto.randomBytes`; store it via an injected secure credential store under a workspace-specific opaque key. Pass it to `initdb` through a temporary mode-`0o600` pwfile under the runtime, then delete the pwfile in `finally`. Use user `backend_team`, UTF-8, data checksums, SCRAM local/host auth, and data directory `.backend-team/runtime/postgresql/data-18`.

- [ ] **Step 5: Implement safe endpoint allocation and lifecycle**

Prefer the workspace Unix socket internally. Allocate a random high loopback TCP port under an exclusive workspace port lock for clients that require TCP, retry startup at most three times on address collision, and persist the chosen endpoint without password. Start via the exact local `pg_ctl`, wait for `pg_isready`, verify server version `18.6`, then publish readiness. Stop with `pg_ctl -m fast -w stop`; use supervisor signals only for verified failure recovery.

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- --run packages/database/test/postgresql-installer.test.ts packages/database/test/postgresql-cluster.test.ts packages/database/test/postgresql-config.test.ts
npm run typecheck
git add packages/database
git commit -m "feat: manage isolated local postgresql cluster"
```

---

### Task 3: Create local databases, snapshots, and recovery primitives

**Files:**
- Create: `packages/database/src/database-catalog.ts`
- Create: `packages/database/src/database-snapshot.ts`
- Create: `packages/database/src/schema-snapshot.ts`
- Create: `packages/database/src/database-recovery.ts`
- Test: `packages/database/test/database-catalog.test.ts`
- Test: `packages/database/test/database-snapshot.test.ts`
- Test: `packages/database/test/database-recovery.test.ts`

**Interfaces:**
- Consumes: running `LocalDatabaseEndpoint`, secure credential reference, local PG tools.
- Produces: `DatabaseCatalog.ensureProjectDatabases()`, `DatabaseSnapshot.create()/restore()`, `SchemaSnapshot.capture()`, `DatabaseRecovery.audit()`.

- [ ] **Step 1: Write failing database-boundary tests**

```ts
it('creates only names derived from the workspace identity', async () => {
  const names = await catalog.ensureProjectDatabases(projectId)
  expect(names).toEqual({ development: `${projectId}_dev`, test: `${projectId}_test` })
})

it('rejects snapshot restore into a non-local endpoint', async () => {
  await expect(snapshot.restore(file, productionLikeEndpoint)).rejects.toThrow('local workspace database required')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/database/test/database-catalog.test.ts packages/database/test/database-snapshot.test.ts packages/database/test/database-recovery.test.ts`

Expected: FAIL with missing services.

- [ ] **Step 3: Implement strict local connection construction**

Build connection parameters from the cluster record and credential store only. Reject user-supplied URLs for Team-managed operations. Database names contain lowercase alphanumeric/underscore, are max 50 characters, and derive from a stable workspace hash to avoid collisions.

- [ ] **Step 4: Implement data and schema snapshots**

Data snapshots use local `pg_dump --format=custom --no-owner --no-privileges`; schema snapshots use `pg_dump --schema-only --no-owner --no-privileges`. Store under `.backend-team/runtime/postgresql/snapshots/` using the deterministic name `<UTC basic timestamp>-<normalized database name>` (for example `20260825T143000Z-a1b2c3_dev`) with manifest, server/migration versions, SHA-256, and reason. Restore only into a new empty local database, verify dump hash, then swap logical use after validation.

- [ ] **Step 5: Implement recovery audit**

Validate process identity, data directory ownership, `postmaster.pid`, endpoint, server version, database catalog, migration journal, and latest verified snapshot. A stale process record becomes `interrupted`; do not delete a data directory. Surface recovery choices through the coordinator.

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- --run packages/database/test/database-catalog.test.ts packages/database/test/database-snapshot.test.ts packages/database/test/database-recovery.test.ts
git add packages/database
git commit -m "feat: snapshot and recover local databases"
```

---

### Task 4: Enforce schema and migration gates

**Files:**
- Create: `packages/database/src/migration-adapter.ts`
- Create: `packages/database/src/drizzle-migration-adapter.ts`
- Create: `packages/database/src/existing-migration-adapter.ts`
- Create: `packages/database/src/sql-risk-analyzer.ts`
- Create: `packages/database/src/migration-verifier.ts`
- Test: `packages/database/test/sql-risk-analyzer.test.ts`
- Test: `packages/database/test/migration-verifier.test.ts`
- Test: `tests/integration/drizzle-migration-real-pg.test.ts`

**Interfaces:**
- Consumes: approved data model, project profile, local database runtime, migration approval, `VerificationEngine`.
- Produces: `MigrationAdapter.preview()/apply()/status()`, `SqlRiskAnalyzer.analyze()`, `MigrationVerifier.verify()`.

- [ ] **Step 1: Install the exact parser and write failing risk tests**

Run: `npm install --save-exact pgsql-ast-parser@12.0.2`

```ts
it.each([
  ['DROP TABLE users', 'destructive'],
  ['ALTER TABLE users DROP COLUMN email', 'destructive'],
  ['ALTER TABLE users ALTER COLUMN age TYPE smallint', 'high'],
  ['ALTER TABLE users ADD COLUMN nickname text', 'standard'],
  ['CREATE INDEX users_email_idx ON users(email)', 'standard'],
])('classifies %s as %s', (sql, risk) => {
  expect(analyzer.analyze(sql).risk).toBe(risk)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/database/test/sql-risk-analyzer.test.ts packages/database/test/migration-verifier.test.ts`

Expected: FAIL with missing analyzer/verifier.

- [ ] **Step 3: Implement migration adapters**

The Drizzle adapter updates project schema through the database expert, invokes the exact detected/pinned Drizzle generate command, captures generated SQL, and never uses schema push as formal history. The existing adapter uses only project-profile migration commands after approval; it does not translate Prisma/TypeORM/Sequelize migrations into Drizzle.

- [ ] **Step 4: Implement parsing and conservative risk classification**

Parse every statement. Parse failure is `high`, never safe. Destructive includes DROP/TRUNCATE, column/table removal, constraint removal that weakens integrity, and irreversible data DELETE/UPDATE without bounded predicate. High includes type narrowing, NOT NULL on existing data, table rewrite, enum removal, raw procedural code, and migration without reverse/forward-repair plan.

- [ ] **Step 5: Implement real migration verification**

For each migration set: create empty DB and apply all; create prior-version DB and apply upgrade; compare resulting schema to expected; run application integration tests; execute declared rollback when safe or prove forward repair; and capture migration journal. High/destructive operations require snapshot plus migration approval bound to SQL hashes before local apply.

- [ ] **Step 6: Run the real PostgreSQL test and commit**

```bash
npm test -- --run packages/database/test tests/integration/drizzle-migration-real-pg.test.ts
npm run typecheck
git add packages/database tests/integration/drizzle-migration-real-pg.test.ts package.json package-lock.json
git commit -m "feat: verify reviewable database migrations"
```

---

### Task 5: Install and launch a hardened workspace-local DbGate

**Files:**
- Create: `runtime-manifests/dbgate-7.2.3.json`
- Create: `packages/database/src/dbgate-installer.ts`
- Create: `packages/database/src/dbgate-loopback-preload.cjs`
- Create: `packages/database/src/dbgate-launcher.ts`
- Create: `packages/database/src/dbgate-security.ts`
- Test: `packages/database/test/dbgate-installer.test.ts`
- Test: `packages/database/test/dbgate-launcher.test.ts`
- Test: `packages/database/test/dbgate-security.test.ts`

**Interfaces:**
- Consumes: install approval, local database endpoint/credential, process supervisor.
- Produces: `DbGateInstaller.ensureInstalled()`, `DbGateLauncher.start()/stop()/status()`, authenticated local URL.

- [ ] **Step 1: Write failing hardening tests**

```ts
it('uses patched community packages with scripts disabled on install', async () => {
  await installer.ensureInstalled(approvedPlan)
  expect(runner.requests[0].args).toEqual([
    'install', '--prefix', dbgateRuntime, '--ignore-scripts', '--save-exact',
    'dbgate-serve@7.2.3', 'dbgate-plugin-postgres@7.2.3',
  ])
})

it('refuses readiness if any DbGate socket listens beyond loopback', async () => {
  probe.setListeners(['*:3000'])
  await expect(launcher.start(config)).rejects.toThrow('non-loopback listener')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/database/test/dbgate-installer.test.ts packages/database/test/dbgate-launcher.test.ts packages/database/test/dbgate-security.test.ts`

Expected: FAIL with missing DbGate services.

- [ ] **Step 3: Pin package provenance and install locally**

Manifest pins both community packages `7.2.3`, GPL-3.0, official npm registry URLs, and these integrity values:

```text
dbgate-serve: sha512-+YZnokDCj05JTVec2X64M9u5kdciii7GlRVCS6dlqCQObEegqmfcSbNvrILGoU6TWkf5rPH2k/qLFHvaXW0DRQ==
dbgate-plugin-postgres: sha512-XUG67Xbe2hEOz+eGSKUnHNqUeVhl9/aPcdIOGs3ArJ7TmVfIOLASYlYAV7cf4gv0/4dKLcgZCNwVk/jYgUcPCg==
```

Install into `.backend-team/runtime/dbgate` with a local package lock and lifecycle scripts disabled, using `WorkspaceNodeRuntime` Node.js `24.19.0` and its local npm after install consent. Run license, lifecycle, npm audit, OSV, and DbGate/Node compatibility checks before marking installed; record executable realpaths and never use host Node/npm/npx.

- [ ] **Step 4: Force loopback and workspace storage before executing third-party code**

The preload module forces every TCP `net.Server.listen()` without an explicit loopback host to `127.0.0.1` and makes DbGate's user-data resolver return `.backend-team/runtime/dbgate/user-data`. It may affect only the dedicated DbGate process. After start, inspect all process listeners with macOS `lsof`; any `*`, `0.0.0.0`, `::`, or non-loopback address stops the process and blocks the feature. Snapshot filesystem writes and fail if DbGate creates a file outside its runtime directory.

- [ ] **Step 5: Launch with authentication and dangerous features disabled**

Generate a random local login/password in the secure credential store. Configure one predefined PostgreSQL connection, `SINGLE_CONNECTION`, `SINGLE_DATABASE`, `SHELL_CONNECTION=0`, `SHELL_SCRIPTING=0`, `SKIP_ALL_AUTH=0`, private cloud disabled, token lifetime two hours, simplified Chinese UI, and a random loopback port. Keep connection and login secrets only in the child process environment; redact logs.

- [ ] **Step 6: Verify patched security behavior**

Run a non-exploit regression request against the previously vulnerable runner route and require rejection of an invalid function name; verify unauthenticated requests cannot obtain a usable session; verify custom JavaScript/shell routes are disabled. Never execute an exploit payload.

- [ ] **Step 7: Run tests and commit**

```bash
npm test -- --run packages/database/test/dbgate-installer.test.ts packages/database/test/dbgate-launcher.test.ts packages/database/test/dbgate-security.test.ts
git add runtime-manifests/dbgate-7.2.3.json packages/database package.json package-lock.json
git commit -m "feat: launch hardened local dbgate"
```

---

### Task 6: Convert DbGate GUI schema designs into migrations

**Files:**
- Create: `packages/database/src/schema-design-session.ts`
- Create: `packages/database/src/schema-diff.ts`
- Create: `packages/database/src/gui-to-migration.ts`
- Test: `packages/database/test/schema-design-session.test.ts`
- Test: `packages/database/test/gui-to-migration.test.ts`
- Create: `tests/integration/gui-schema-to-drizzle-real-pg.test.ts`

**Interfaces:**
- Consumes: `DbGateLauncher`, schema snapshots, database expert, Drizzle adapter, migration verifier.
- Produces: `SchemaDesignSession.open()/capture()/discard()`, `GuiToMigration.convert()`.

- [ ] **Step 1: Write failing isolation and conversion tests**

```ts
it('opens structural editing against a disposable design database', async () => {
  const session = await design.open('app_dev')
  expect(session.database).toMatch(/^design_[a-f0-9]+$/)
  expect(session.database).not.toBe('app_dev')
})

it('does not apply captured DDL until a migration passes verification', async () => {
  await converter.convert(capturedSchemaDiff)
  expect(await schemaHash('app_dev')).toBe(beforeHash)
  expect(migrationVerifier.calls).toHaveLength(1)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/database/test/schema-design-session.test.ts packages/database/test/gui-to-migration.test.ts`

Expected: FAIL with missing session/converter.

- [ ] **Step 3: Implement disposable schema-design databases**

Create a new local database from a verified dump of the development schema/data fixture, open DbGate only against it, capture before/after normalized schema dumps, and drop it only after the user has chosen convert or discard. Ordinary data editing mode may target the development database, but structural editing mode always uses the design database.

- [ ] **Step 4: Convert rather than trust raw GUI DDL**

Send the normalized schema diff, approved data model, current Drizzle schema, and DbGate SQL preview to the database expert. The expert updates Drizzle schema and generates a migration. Require resulting schema equivalence to the design database, SQL risk analysis, empty/upgrade verification, and migration approval where required. Then apply only the migration to development.

- [ ] **Step 5: Run real PostgreSQL conversion test**

Create a table, fields, unique constraint, foreign key, and index in the disposable database using SQL equivalent to DbGate's preview; convert to Drizzle/migration through the deterministic fake database expert; apply to a clean DB; compare normalized schemas; assert the development DB was unchanged before the migration apply gate.

- [ ] **Step 6: Commit**

```bash
npm test -- --run packages/database/test tests/integration/gui-schema-to-drizzle-real-pg.test.ts
git add packages/database tests/integration/gui-schema-to-drizzle-real-pg.test.ts
git commit -m "feat: convert gui schema designs into migrations"
```

---

### Task 7: Prove dual-architecture runtime, migration, recovery, and DbGate GUI

**Files:**
- Create: `tests/e2e/postgresql-lifecycle.test.ts`
- Create: `tests/e2e/postgresql-migration-recovery.test.ts`
- Create: `tests/e2e/dbgate-gui.md`
- Create: `docs/operations/postgresql-and-dbgate.md`
- Create: `packages/database/src/database-application-composition.ts`
- Modify: `.github/workflows/postgresql-runtime.yml`

**Interfaces:**
- Consumes: Stage 02–06 application services, `MockBackendTeamOrchestrationPort`, real PostgreSQL artifact, real DbGate, Codex Chrome plugin.
- Produces: application-level database composition plus Stage 06 dual-architecture and direct DbGate GUI evidence; no production Harness registration.

- [ ] **Step 1: Write automated lifecycle and recovery expectations**

Tests cover install approval, initialize, start, create dev/test DBs, Drizzle empty/upgrade migration, high-risk snapshot gate, interruption during migration, restore into new DB, fast stop, stale PID recovery, restart, and uninstall-with-data-preserved. Capture listener addresses and filesystem before/after snapshots.

- [ ] **Step 2: Run the new E2E tests and verify application composition is absent**

Run:

```bash
npm test -- --run tests/e2e/postgresql-lifecycle.test.ts tests/e2e/postgresql-migration-recovery.test.ts
```

Expected: FAIL because the application composition does not yet route database lifecycle and migration requests through the coordinator.

- [ ] **Step 3: Compose database services at the application boundary**

Construct the installer, cluster, catalog, snapshot, migration, DbGate, and schema-design services only after workspace layout, policy, and state recovery succeed. Define database status/start/stop/open-GUI/design-conversion requests in the application catalog and route them through the coordinator under `MockBackendTeamOrchestrationPort`; do not expose raw connection, SQL execution, credential, or process tools. Do not modify the production Bundle or claim a Harness panel/action. Stage 07 Tasks 2 and 4 own production orchestration and host wiring after fresh official evidence. Teardown follows the verified process-identity rules and preserves data.

- [ ] **Step 4: Run the automated tests on each native architecture**

Run:

```bash
npm test -- --run tests/e2e/postgresql-lifecycle.test.ts tests/e2e/postgresql-migration-recovery.test.ts
```

Expected: PASS on Intel and Apple Silicon with PostgreSQL `18.6`; no path outside the fixture workspace changes.

- [ ] **Step 5: Run DbGate GUI E2E with Codex Chrome**

Using the Codex Chrome plugin, perform and record these visible actions:

1. Open the authenticated local DbGate URL.
2. View existing tables and rows.
3. Insert/update a test-data row.
4. Open a structural design session.
5. Create a table, field, primary key, foreign key, and index.
6. Inspect SQL preview.
7. Use the Stage 06 application test driver to request conversion through the coordinator.
8. Review generated Drizzle/SQL migration evidence.
9. Apply to local development DB.
10. Reopen DbGate and verify the resulting structure.

Record screenshots/trace references, exact versions, local URL with token redacted, migration hash, and final schema hash in `tests/e2e/dbgate-gui.md`.

- [ ] **Step 6: Prove security and workspace boundaries**

Assert DbGate authentication is required, custom scripting is disabled, all listener addresses are loopback, all DbGate data remains below its runtime directory, PostgreSQL has no trust auth/non-loopback listener, no global package/service was added, and stopping the application composition leaves no managed process.

- [ ] **Step 7: Document operation and commit**

```bash
git add tests/e2e docs/operations/postgresql-and-dbgate.md packages/database .github/workflows/postgresql-runtime.yml
git commit -m "test: prove local postgres and dbgate experience"
```

## Stage 06 completion gate

Proceed only when both native macOS architectures pass the real PostgreSQL lifecycle, empty/upgrade/rollback-or-forward-repair migration tests pass, interruption recovery preserves data, direct DbGate visible GUI operations are verified through Codex Chrome, GUI structural changes become versioned migrations through the application coordinator, and listener/filesystem audits prove no non-loopback or outside-workspace side effect. This is not production Harness Bundle/panel evidence; that remains blocked on Stage 07 Tasks 2 and 4.
