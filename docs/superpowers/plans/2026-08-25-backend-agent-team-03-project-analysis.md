# Backend Agent Team Stage 03: Project Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably classify new and existing projects, identify the exact Node.js service boundary and technical baseline, and select an in-place development strategy without executing untrusted project code.

**Architecture:** Independent evidence collectors read manifests, lockfiles, imports, migrations, configuration, and Git metadata. A synthesizer produces a Zod-validated `ProjectProfile` with per-claim evidence and confidence; a strategy selector applies new-project defaults only when the workspace is genuinely new.

**Tech Stack:** TypeScript, Zod, fast-glob 3.3.3, ignore 7.0.6, Vitest, read-only Git commands.

**Spec:** `docs/superpowers/specs/2026-08-25-backend-agent-team-design.md`

## Global Constraints

- Follow the master plan and completed Stage 01–02 interfaces.
- Analysis may read files and run explicitly classified read-only Git commands; it may not run package scripts, import the target project, load `.env`, connect to a database, or write business files.
- New-project defaults never override evidence from an existing project.
- Existing-project Node selection is evidence-based: prefer compatible trusted `.nvmrc`, `.node-version`, `package.json#engines`/`devEngines`, or equivalent declarations; never force Node.js `24.19.0` onto an existing project. Missing or conflicting declarations require design clarification before any Node/package-manager command.
- Every conclusion includes source path, evidence kind, confidence, and conflicts.
- Low-confidence or conflicting conclusions block automatic writes and require expert/user resolution.
- User uncommitted changes are part of the protected baseline, never noise to clean up.

---

### Task 1: Define the project profile and evidence model

**Files:**
- Create: `packages/project-analyzer/package.json`
- Create: `packages/project-analyzer/tsconfig.json`
- Create: `packages/project-analyzer/src/project-profile.ts`
- Create: `packages/project-analyzer/src/evidence.ts`
- Create: `packages/project-analyzer/src/index.ts`
- Create: `tests/fixtures/projects/empty/.gitkeep`
- Create: `tests/fixtures/projects/nest-drizzle-postgres/package.json`
- Create: `tests/fixtures/projects/nest-drizzle-postgres/.nvmrc`
- Create: `tests/fixtures/projects/express-prisma-mysql/package.json`
- Create: `tests/fixtures/projects/express-prisma-mysql/.nvmrc`
- Create: `tests/fixtures/projects/non-node/go.mod`
- Create: `tests/fixtures/projects/monorepo/package.json`
- Test: `packages/project-analyzer/test/project-profile.test.ts`

**Interfaces:**
- Consumes: `WorkspaceLayout`.
- Produces: `ProjectProfileSchema`, `ProjectEvidence`, `Confidence`, `ProjectKind`, `ServiceBoundary`, `DetectedNodeRuntime`, `BaselineIssue`.

- [ ] **Step 1: Write failing schema tests**

```ts
it('requires evidence for every detected technology', () => {
  expect(() => ProjectProfileSchema.parse({
    kind: 'existing-node',
    root: '/work/app',
    frameworks: [{ name: 'nestjs', confidence: 'high', evidence: [] }],
  })).toThrow()
})

it('cannot recommend PostgreSQL migration for an existing MySQL project', () => {
  expect(() => ProjectProfileSchema.parse(existingMysqlWithMigrationRecommendation)).toThrow()
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/project-analyzer/test/project-profile.test.ts`

Expected: FAIL with missing schema.

- [ ] **Step 3: Install exact analysis dependencies and build the schemas**

Run:

```bash
npm install --save-exact fast-glob@3.3.3 ignore@7.0.6
```

Each technology claim uses:

```ts
interface DetectedValue<T extends string> {
  value: T
  confidence: 'high' | 'medium' | 'low'
  evidence: readonly ProjectEvidence[]
  conflicts: readonly ProjectEvidence[]
}

interface ProjectEvidence {
  kind: 'manifest' | 'lockfile' | 'import' | 'config' | 'migration' | 'script' | 'git' | 'filesystem'
  path: string
  fact: string
  excerptHash: string
}

interface DetectedNodeRuntime {
  declarations: readonly { source: string; range: string; evidence: ProjectEvidence }[]
  exactVersion?: string
  selectionSource?: string
  conflicts: readonly ProjectEvidence[]
  status: 'selected' | 'needs-clarification' | 'unsupported'
}
```

Paths are workspace-relative and excerpts are represented by hashes plus short redacted facts, not raw `.env` contents.

- [ ] **Step 4: Create representative fixture manifests**

The Nest fixture declares Nest/Fastify/Drizzle/pg, npm lock metadata, and `.nvmrc` `24.19.0`. The Express fixture declares Express/Prisma/MySQL, `.nvmrc` `20.20.0`, and a compatible package engine plus `prisma/schema.prisma`. The monorepo fixture uses npm workspaces with `services/api` and `apps/web`; add a conflicting nested Node declaration case to prove the analyzer requests clarification. The non-Node fixture has no `package.json`. Fixtures contain no installable lockfile URLs or secrets.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- --run packages/project-analyzer/test/project-profile.test.ts
npm run typecheck
git add packages/project-analyzer tests/fixtures/projects package.json package-lock.json
git commit -m "feat: define evidence-based project profiles"
```

---

### Task 2: Implement safe filesystem and manifest collection

**Files:**
- Create: `packages/project-analyzer/src/file-index.ts`
- Create: `packages/project-analyzer/src/manifest-reader.ts`
- Create: `packages/project-analyzer/src/secret-filter.ts`
- Test: `packages/project-analyzer/test/file-index.test.ts`
- Test: `packages/project-analyzer/test/manifest-reader.test.ts`
- Test: `packages/project-analyzer/test/secret-filter.test.ts`

**Interfaces:**
- Consumes: canonical workspace root and `PolicyEngine`.
- Produces: `FileIndex.build()`, `ManifestReader.readPackage()`, `SecretFilter.isSensitivePath()`.

- [ ] **Step 1: Write failing traversal and secret tests**

```ts
it('does not follow a symlink outside the workspace', async () => {
  await fixture.symlink('/tmp/external-secret', 'linked')
  expect((await FileIndex.build(fixture.root)).paths).not.toContain('linked/secret.txt')
})

it.each(['.env', '.env.local', 'id_rsa', 'credentials.json', '.npmrc'])('marks %s sensitive', path => {
  expect(filter.isSensitivePath(path)).toBe(true)
})

it('parses package.json as data without importing it', async () => {
  const pkg = await reader.readPackage('package.json')
  expect(pkg.name).toBe('fixture-app')
  expect(executedSentinel()).toBe(false)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/project-analyzer/test/file-index.test.ts packages/project-analyzer/test/manifest-reader.test.ts packages/project-analyzer/test/secret-filter.test.ts`

Expected: FAIL with missing collectors.

- [ ] **Step 3: Implement bounded indexing**

Respect `.gitignore` plus hard exclusions for `.git`, `node_modules`, `.backend-team/runtime`, caches, build output, binary files, files above 2 MiB, and sensitive paths. Do not follow symlinks. Cap the index at 100,000 paths and return a truncation warning rather than silently dropping evidence.

- [ ] **Step 4: Implement data-only manifest readers**

Read JSON/JSONC/YAML/TOML text with size limits and parsers; never `import()`, `require()`, or execute configuration. `package.json` validation keeps only name, workspaces, engines, packageManager, dependencies, devDependencies, scripts names/values, and exports. Script values are evidence but are never executed in analysis.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/project-analyzer/test/file-index.test.ts packages/project-analyzer/test/manifest-reader.test.ts packages/project-analyzer/test/secret-filter.test.ts
git add packages/project-analyzer
git commit -m "feat: collect project evidence without execution"
```

---

### Task 3: Detect Node stack, package manager, database, ORM, tests, and commands

**Files:**
- Create: `packages/project-analyzer/src/detectors/node-detector.ts`
- Create: `packages/project-analyzer/src/detectors/node-version-detector.ts`
- Create: `packages/project-analyzer/src/detectors/package-manager-detector.ts`
- Create: `packages/project-analyzer/src/detectors/framework-detector.ts`
- Create: `packages/project-analyzer/src/detectors/database-detector.ts`
- Create: `packages/project-analyzer/src/detectors/test-detector.ts`
- Create: `packages/project-analyzer/src/detectors/command-detector.ts`
- Test: `packages/project-analyzer/test/detectors.test.ts`

**Interfaces:**
- Consumes: `FileIndex`, sanitized manifests.
- Produces: `Detector<T>.collect(context): Promise<DetectedValue<T>[]>`, `DetectedCommands`, and `DetectedNodeRuntime` with declaration source/range/exact selection/conflicts.

- [ ] **Step 1: Write a failing fixture matrix test**

```ts
it.each([
  ['nest-drizzle-postgres', 'nestjs', 'drizzle', 'postgresql', 'npm'],
  ['express-prisma-mysql', 'express', 'prisma', 'mysql', 'npm'],
])('detects %s without replacing its stack', async (fixtureName, framework, orm, database, packageManager) => {
  const profile = await analyzeFixture(fixtureName)
  expect(profile.primaryFramework?.value).toBe(framework)
  expect(profile.orm?.value).toBe(orm)
  expect(profile.database?.value).toBe(database)
  expect(profile.packageManager.value).toBe(packageManager)
  expect(profile.nodeRuntime.selectionSource).toMatch(/\.nvmrc|\.node-version|package\.json/)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/project-analyzer/test/detectors.test.ts`

Expected: FAIL with no detector results.

- [ ] **Step 3: Implement evidence precedence**

Use this precedence for stack facts: lockfile/package-manager declaration > installed dependency declaration > source import/config > filename convention. For Node runtime selection, collect `.nvmrc`, `.node-version`, `package.json#engines.node`, `package.json#devEngines.runtime`, package-manager/Volta/asdf-equivalent declarations, and lockfile/tool compatibility without executing them. Select an exact version only when trusted declarations have a non-empty compatible intersection; preserve every source/range/conflict. No declaration or a material conflict produces `needs-clarification`, not an implicit Node.js 24 fallback. Also detect TypeScript strictness, npm/pnpm/yarn/bun lockfiles, Nest/Express/Fastify/Koa/Hapi, Drizzle/Prisma/TypeORM/Sequelize/Knex, PostgreSQL/MySQL/MariaDB/SQLite, and Vitest/Jest/Node test runner.

- [ ] **Step 4: Detect commands without running them**

Map existing script names to candidate purposes: typecheck, lint, build, unit test, integration test, migration generate/apply/rollback, start, and health. Candidate commands remain `unverified` until Stage 05 runs them through policy and baseline capture. Never invent a fallback command for an existing project.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/project-analyzer/test/detectors.test.ts
npm run typecheck
git add packages/project-analyzer
git commit -m "feat: detect existing node backend stacks"
```

---

### Task 4: Detect service boundaries and monorepos

**Files:**
- Create: `packages/project-analyzer/src/service-boundary.ts`
- Create: `packages/project-analyzer/src/monorepo-analyzer.ts`
- Create: `tests/fixtures/projects/monorepo/services/api/package.json`
- Create: `tests/fixtures/projects/monorepo/apps/web/package.json`
- Test: `packages/project-analyzer/test/service-boundary.test.ts`

**Interfaces:**
- Consumes: root package workspaces, manifest index, framework/database evidence.
- Produces: `ServiceBoundaryResolver.resolve(requestedPath?)` and `ServiceBoundaryDecision`.

- [ ] **Step 1: Write failing boundary tests**

```ts
it('selects the only backend service in a mixed monorepo', async () => {
  const decision = await resolver.resolve()
  expect(decision.status).toBe('selected')
  expect(decision.boundary.relativeRoot).toBe('services/api')
})

it('blocks when two backend services are equally plausible', async () => {
  const decision = await resolverFor('two-apis').resolve()
  expect(decision.status).toBe('needs-user-selection')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/project-analyzer/test/service-boundary.test.ts`

Expected: FAIL with missing resolver.

- [ ] **Step 3: Implement boundary scoring**

Score explicit user path highest, then workspace package with backend framework + server script + database/ORM evidence. A frontend-only package is never selected as backend. When the top two candidates differ by less than 20 points, return `needs-user-selection` with both evidence summaries; do not pick arbitrarily.

- [ ] **Step 4: Enforce boundary-aware paths**

All later business-code ownership is relative to `ServiceBoundary.absoluteRoot`. Root shared files remain a separate shared resource requiring explicit ownership and approval. Persist the decision and evidence in `project-profile.json`.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/project-analyzer/test/service-boundary.test.ts
git add packages/project-analyzer tests/fixtures/projects/monorepo
git commit -m "feat: resolve backend service boundaries"
```

---

### Task 5: Capture Git and verification baselines without altering the worktree

**Files:**
- Create: `packages/project-analyzer/src/git-baseline.ts`
- Create: `packages/project-analyzer/src/verification-baseline.ts`
- Test: `packages/project-analyzer/test/git-baseline.test.ts`
- Test: `packages/project-analyzer/test/verification-baseline.test.ts`

**Interfaces:**
- Consumes: guarded `CommandRunner`, detected candidate commands.
- Produces: `GitBaseline.capture()`, `VerificationBaseline.plan()`, and later `VerificationBaseline.record()`.

- [ ] **Step 1: Write failing dirty-worktree tests**

```ts
it('preserves tracked, untracked, staged and conflicted entries', async () => {
  const baseline = await gitBaseline.capture()
  expect(baseline.entries.map(entry => entry.kind)).toEqual(expect.arrayContaining([
    'tracked-modified', 'untracked', 'staged', 'conflicted',
  ]))
  expect(commandLog()).not.toContainEqual(expect.objectContaining({ args: expect.arrayContaining(['reset']) }))
})

it('keeps detected test scripts unverified until execution stage', async () => {
  expect((await baseline.plan()).commands.every(command => command.status === 'unverified')).toBe(true)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/project-analyzer/test/git-baseline.test.ts packages/project-analyzer/test/verification-baseline.test.ts`

Expected: FAIL with missing baseline collectors.

- [ ] **Step 3: Implement read-only Git capture**

Run only `git rev-parse --show-toplevel`, `git rev-parse HEAD`, `git status --porcelain=v2 -z --untracked-files=all`, and read-only diff/stat commands with `--no-ext-diff`. Parse NUL records. If no repository exists, record `repository: false`; do not initialize Git in a target user project.

- [ ] **Step 4: Build the verification plan**

Return candidate commands with source script, exact argv through the detected package manager, expected purpose, risk classification, and `unverified` status. Unknown scripts require user approval in Stage 05 before first execution.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/project-analyzer/test/git-baseline.test.ts packages/project-analyzer/test/verification-baseline.test.ts
git add packages/project-analyzer
git commit -m "feat: preserve project and verification baselines"
```

---

### Task 6: Synthesize profiles and choose the safe development strategy

**Files:**
- Create: `packages/project-analyzer/src/project-analyzer.ts`
- Create: `packages/project-analyzer/src/strategy-selector.ts`
- Create: `presets/new-project/node-postgresql.yaml`
- Test: `packages/project-analyzer/test/project-analyzer.test.ts`
- Test: `packages/project-analyzer/test/strategy-selector.test.ts`
- Create: `tests/integration/project-analysis-flow.test.ts`

**Interfaces:**
- Consumes: all collectors, `StateStore`, approved design artifacts.
- Produces: `ProjectAnalyzer.analyze()`, `StrategySelector.select(profile)`, `DevelopmentStrategy`.

- [ ] **Step 1: Write failing strategy tests**

```ts
it.each([
  ['empty', 'new-node-postgresql'],
  ['nest-drizzle-postgres', 'modify-in-place'],
  ['express-prisma-mysql', 'modify-in-place'],
  ['non-node', 'unsupported-read-only'],
])('selects %s strategy for %s', async (fixtureName, expected) => {
  const profile = await analyzer.analyze(fixturePath(fixtureName))
  expect(selector.select(profile).kind).toBe(expected)
})

it('never recommends PostgreSQL or Node migration for the existing MySQL fixture', async () => {
  const strategy = selector.select(await analyzer.analyze(fixturePath('express-prisma-mysql')))
  expect(strategy.database).toBe('mysql')
  expect(strategy.migrations).not.toContain('postgresql')
  expect(strategy.nodeRuntime).toMatchObject({ exactVersion: '20.20.0', source: '.nvmrc' })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/project-analyzer/test/project-analyzer.test.ts packages/project-analyzer/test/strategy-selector.test.ts`

Expected: FAIL with missing analyzer/synthesizer.

- [ ] **Step 3: Implement confidence synthesis**

High confidence requires at least one high-precedence source and no unresolved conflict. Medium confidence permits multiple consistent lower-precedence sources. Low confidence includes a single convention or any material conflict. Persist all evidence and a plain-language summary to `.backend-team/project-profile.json` through an atomic write.

- [ ] **Step 4: Implement exact strategies**

`new-node-postgresql` carries exact Node.js `24.19.0` plus the approved defaults. `modify-in-place` carries the compatible exact Node version and evidence source alongside detected framework/ORM/database/package manager and forbids automatic replacements. Every selected version is installed under the target workspace NVM only after install approval when absent. `unsupported-read-only` contains the reason and no write capabilities. `needs-clarification` is returned for a missing/conflicting/unresolvable Node declaration or low-confidence service, database, ORM, package manager, or migration ownership.

- [ ] **Step 5: Run the fixture integration matrix**

Run:

```bash
npm test -- --run packages/project-analyzer/test tests/integration/project-analysis-flow.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all pass; command recorder proves no package script, database client, `.env` loader, or project import executed. Fixtures prove new projects select `24.19.0`, compatible existing declarations are preserved, conflicts require clarification, and no host Node/npm/npx binary is invoked.

- [ ] **Step 6: Commit**

```bash
git add packages/project-analyzer presets/new-project tests/integration/project-analysis-flow.test.ts
git commit -m "feat: select safe new and existing project strategies"
```

## Stage 03 completion gate

Proceed only when the full fixture matrix is correctly classified, the existing MySQL fixture retains MySQL and Prisma, mixed monorepos resolve or ask rather than guess, dirty worktree state is preserved byte-for-byte, sensitive files are excluded, and no target project code was executed during analysis.
