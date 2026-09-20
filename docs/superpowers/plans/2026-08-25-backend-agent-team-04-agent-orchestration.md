# Backend Agent Team Stage 04: Bounded Agent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a coordinator-led Agent Team where experts can create strictly bounded work subagents, results are verified and persisted, writes are owned, and concurrency/budgets cannot exceed approved limits.

**Architecture:** The coordinator is the only global state writer and user-facing actor. A scheduler accepts schema-validated tasks, intersects child capabilities with parent capabilities, leases file ownership, and delegates through the application `BackendTeamOrchestrationPort`. Experts can delegate at depth one; depth-two workers return structured handoffs and have no delegation or phase-control capability.

**Tech Stack:** TypeScript, Zod, YAML presets, Vitest, Stage 01 application orchestration contracts and deterministic mocks.

**Spec:** `docs/superpowers/specs/2026-08-25-backend-agent-team-design.md`

## Global Constraints

- Follow the master plan and Stages 01–03.
- Maximum topology is coordinator → expert → work subagent; a depth-two task cannot spawn.
- Maximum concurrent experts is 3, maximum children per expert is 3, maximum concurrent writers is 2.
- A child capability is the intersection of requested capability, parent capability, approved phase, project boundary, and policy decision.
- Only the coordinator changes global phase, records user approval, writes the canonical state, or announces completion.
- Experts and workers receive self-contained context packets, not raw conversation history or secrets.
- Every child result is verified by its parent and retained until receipt is durably recorded.
- Stage 01 does not prove an rc.6 Agent-spawn or event Context API. Stage 04 keeps orchestration behind `BackendTeamOrchestrationPort` and uses mocks only. Stage 07 Task 2 owns the production port, durable event implementation, control-mediated approval, and exact public official API/provenance gate for Agent spawn/result/cancel/usage; mock success is not host evidence, and a missing seam blocks Bundle E2E/release.

---

### Task 1: Define task, capability, budget, and handoff contracts

**Files:**
- Modify: `packages/contracts/src/harness.ts`
- Create: `packages/contracts/src/agent-task.ts`
- Create: `packages/contracts/src/handoff.ts`
- Create: `packages/contracts/src/budget.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/agent-team/package.json`
- Create: `packages/agent-team/tsconfig.json`
- Create: `packages/agent-team/src/index.ts`
- Test: `packages/contracts/test/agent-contracts.test.ts`

**Interfaces:**
- Produces: `AgentTask`, `AgentCapabilitySet`, `AgentBudget`, `AgentResult`, `AgentHandoff`, `AgentRole`, `TaskDepth`.
- Consumes: stable Stage 01 Harness types.

- [ ] **Step 1: Write failing schema tests**

```ts
it('rejects a task without non-goals, evidence, or return schema', () => {
  expect(() => AgentTaskSchema.parse({ id: 'task-1', objective: 'Implement API' })).toThrow()
})

it('rejects worker delegation capability at depth two', () => {
  expect(() => AgentTaskSchema.parse({ ...validTask, depth: 2, capabilities: { ...caps, canDelegate: true } })).toThrow()
})

it('requires a verification record before an Agent result is accepted', () => {
  expect(() => AgentResultSchema.parse({ status: 'passed', summary: 'done' })).toThrow()
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/contracts/test/agent-contracts.test.ts`

Expected: FAIL with missing schemas.

- [ ] **Step 3: Implement the exact task contract**

```ts
interface AgentTask {
  id: string
  parentTaskId: string | null
  depth: 0 | 1 | 2
  role: AgentRole
  objective: string
  nonGoals: readonly string[]
  inputArtifacts: readonly { path: string; sha256: string }[]
  readPaths: readonly string[]
  writePaths: readonly string[]
  capabilities: AgentCapabilitySet
  budget: AgentBudget
  doneWhen: readonly string[]
  verification: readonly VerificationInstruction[]
  returnSchema: string
}
```

Capabilities explicitly cover read, write, commands, network hosts, install, migration, delegation, phase transition, approval, user communication, and completion announcement. Default is false/empty.

- [ ] **Step 4: Implement budgets and handoffs**

Budget contains max tokens, wall-clock milliseconds, tool calls, retries, and child count. Handoff contains task ID, status, summary, changed paths with before/after hashes, commands and exit codes, evidence paths, risks, unresolved items, consumed budget, child result IDs, and parent verification status.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- --run packages/contracts/test/agent-contracts.test.ts
npm run typecheck
git add packages/contracts packages/agent-team
git commit -m "feat: define bounded agent task contracts"
```

---

### Task 2: Validate expert presets and role permissions

**Files:**
- Create: `packages/agent-team/src/preset-loader.ts`
- Create: `packages/agent-team/src/role-policy.ts`
- Create: `presets/experts/project-analyzer.yaml`
- Create: `presets/experts/planner.yaml`
- Create: `presets/experts/developer.yaml`
- Create: `presets/experts/tester.yaml`
- Create: `presets/experts/security-reviewer.yaml`
- Create: `presets/experts/fixer.yaml`
- Modify: existing expert presets from Stage 02 to use the same schema
- Test: `packages/agent-team/test/preset-loader.test.ts`
- Test: `packages/agent-team/test/role-policy.test.ts`

**Interfaces:**
- Consumes: `AgentRole`, `AgentCapabilitySet`.
- Produces: `PresetLoader.loadAll()`, `RolePolicy.maxCapabilities(role, phase)`.

- [ ] **Step 1: Write failing permission-table tests**

```ts
it.each([
  ['requirements', false, false],
  ['project-analyzer', false, false],
  ['backend-architect', false, true],
  ['database-designer', false, true],
  ['developer', true, true],
  ['tester', false, true],
  ['security-reviewer', false, false],
  ['fixer', true, true],
])('%s businessWrite=%s canDelegate=%s', (role, businessWrite, canDelegate) => {
  const caps = policy.maxCapabilities(role as AgentRole, 'BUILD')
  expect(caps.businessCodeWrite).toBe(businessWrite)
  expect(caps.canDelegate).toBe(canDelegate)
})
```

Tester write paths are limited to test files and test artifacts even though `businessCodeWrite` is false.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/agent-team/test/preset-loader.test.ts packages/agent-team/test/role-policy.test.ts`

Expected: FAIL with missing loader/policy.

- [ ] **Step 3: Normalize every expert preset**

Each YAML file includes `role`, `purpose`, `allowedPhases`, `defaultCapabilities`, `readPathPatterns`, `writePathPatterns`, `requiredInputs`, `requiredOutputs`, `nonGoals`, `defaultBudget`, and `verification`. The loader rejects unknown keys, duplicate roles, absolute paths, broad `**` write access, and prompts that grant phase/approval/user authority.

- [ ] **Step 4: Implement phase-aware role maxima**

Requirements/design/planning roles never gain business-code write. Developer/fixer gain owned writes only in `BUILD`/`VERIFY` after current design approval. Tester writes only paths matching `**/*.test.*`, `**/*.spec.*`, `test/**`, `tests/**`, and `.backend-team/runs/**/verification/**`. Security/project analysis remain read-only in every phase.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/agent-team/test/preset-loader.test.ts packages/agent-team/test/role-policy.test.ts
git add packages/agent-team presets/experts
git commit -m "feat: enforce expert role permissions"
```

---

### Task 3: Implement privilege-monotonic expert-to-subagent delegation

**Files:**
- Create: `packages/agent-team/src/capability-intersection.ts`
- Create: `packages/agent-team/src/delegation-guard.ts`
- Create: `packages/agent-team/src/agent-factory.ts`
- Test: `packages/agent-team/test/capability-intersection.test.ts`
- Test: `packages/agent-team/test/delegation-guard.test.ts`

**Interfaces:**
- Consumes: parent `AgentTask`, proposed child task, `RolePolicy`, `PolicyEngine`, current state snapshot.
- Produces: `intersectCapabilities()`, `DelegationGuard.authorizeChild()`, `AgentFactory.spawn()`.

- [ ] **Step 1: Write adversarial failing tests**

```ts
it('removes every child privilege absent from the parent', () => {
  const child = intersectCapabilities(parentReadOnly, requestedWriter)
  expect(child.businessCodeWrite).toBe(false)
  expect(child.install).toBe(false)
  expect(child.networkHosts).toEqual([])
})

it('allows an expert to create a bounded worker', async () => {
  const decision = await guard.authorizeChild(expertTask, validWorkerTask)
  expect(decision.effect).toBe('allow')
  expect(decision.task.depth).toBe(2)
  expect(decision.task.capabilities.canDelegate).toBe(false)
})

it('denies delegation from a worker', async () => {
  await expect(guard.authorizeChild(workerTask, proposedGrandchild)).rejects.toThrow('maximum agent depth')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/agent-team/test/capability-intersection.test.ts packages/agent-team/test/delegation-guard.test.ts`

Expected: FAIL with missing delegation guard.

- [ ] **Step 3: Implement capability intersection**

Boolean privileges use logical AND. Read/write paths use canonical set intersection. Network hosts intersect exact normalized hosts; wildcards are rejected. Numeric budgets take the lower remaining value. Child `canChangePhase`, `canApprove`, `canContactUser`, and `canAnnounceCompletion` are always false regardless of request.

- [ ] **Step 4: Implement delegation authorization**

Require parent depth 1, parent `canDelegate`, current child count below three, self-contained objective/non-goals/done criteria, no overlapping unowned write path, and input hashes matching current artifacts. Invoke Policy Engine for every requested tool/path. Return a rewritten child task containing only allowed capabilities; never trust a child-supplied depth or parent ID.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/agent-team/test/capability-intersection.test.ts packages/agent-team/test/delegation-guard.test.ts
npm run typecheck
git add packages/agent-team
git commit -m "feat: bound expert subagent delegation"
```

---

### Task 4: Implement scheduler concurrency and budget accounting

**Files:**
- Create: `packages/agent-team/src/task-scheduler.ts`
- Create: `packages/agent-team/src/budget-ledger.ts`
- Create: `packages/agent-team/src/task-queue.ts`
- Test: `packages/agent-team/test/task-scheduler.test.ts`
- Test: `packages/agent-team/test/budget-ledger.test.ts`

**Interfaces:**
- Consumes: authorized tasks and `BackendTeamOrchestrationPort.spawnAgent()`.
- Produces: `TaskScheduler.submit()`, `cancel()`, `snapshot()`, `BudgetLedger.reserve()/consume()/release()`.

- [ ] **Step 1: Write failing concurrency tests using controllable promises**

```ts
it('runs at most three experts and two writers', async () => {
  const runs = Array.from({ length: 8 }, (_, index) => scheduler.submit(taskFor(index)))
  await until(() => adapter.activeAgents === 3)
  expect(adapter.maxActiveAgents).toBe(3)
  expect(adapter.maxActiveWriters).toBe(2)
  adapter.completeAll()
  await Promise.all(runs)
})

it('does not start a child whose parent budget is exhausted', async () => {
  ledger.consume(parentId, { tokens: 1000, toolCalls: 10, wallMs: 1_000 })
  await expect(scheduler.submit(childTask)).rejects.toThrow('parent budget exhausted')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/agent-team/test/task-scheduler.test.ts packages/agent-team/test/budget-ledger.test.ts`

Expected: FAIL with missing scheduler.

- [ ] **Step 3: Implement fair queues and semaphores**

Maintain separate expert, read-worker, and write-worker queues. Use FIFO within priority (`blocking` before `normal`) and never let repeated read work starve a waiting writer. Acquire expert, global writer, parent child-count, ownership, and budget leases atomically before spawning; release all in `finally`.

- [ ] **Step 4: Implement monotonic budget accounting**

Reservations subtract from parent remaining budget before spawn. Actual usage is recorded from application Agent results; unused reserved capacity returns to the parent, but consumed capacity never does. On any budget ceiling, cancel through the `AgentHandle`, persist `blocked: budget-exhausted`, and stop spawning more agents.

- [ ] **Step 5: Run tests under fake timers and commit**

```bash
npm test -- --run packages/agent-team/test/task-scheduler.test.ts packages/agent-team/test/budget-ledger.test.ts
git add packages/agent-team
git commit -m "feat: schedule agents within concurrency budgets"
```

---

### Task 5: Enforce file ownership and shared-resource serialization

**Files:**
- Create: `packages/agent-team/src/ownership-manager.ts`
- Create: `packages/agent-team/src/path-overlap.ts`
- Create: `packages/agent-team/src/shared-resource.ts`
- Test: `packages/agent-team/test/ownership-manager.test.ts`
- Test: `packages/agent-team/test/path-overlap.test.ts`

**Interfaces:**
- Consumes: canonical read/write paths, service boundary, task identity.
- Produces: `OwnershipManager.acquire()/verifyWrite()/release()`, `SharedResource`.

- [ ] **Step 1: Write failing overlap and mutation tests**

```ts
it.each([
  [['src/users'], ['src/users/service.ts']],
  [['package.json'], ['package.json']],
  [['drizzle'], ['drizzle/0002.sql']],
])('serializes overlapping paths %j and %j', async (a, b) => {
  const first = await manager.acquire('a', a)
  await expect(manager.acquire('b', b)).rejects.toThrow('owned by task a')
  await first.release()
})

it('denies a write not declared by the task', async () => {
  await expect(manager.verifyWrite(task, 'src/admin.ts')).rejects.toThrow('outside task ownership')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/agent-team/test/ownership-manager.test.ts packages/agent-team/test/path-overlap.test.ts`

Expected: FAIL with missing ownership manager.

- [ ] **Step 3: Implement canonical path leases**

Use a segment trie after realpath-aware canonicalization. Parent/child directories overlap. A file and itself overlap. Read leases may coexist; any write lease conflicts with another read/write lease unless both belong to the same task. Leases include nonce and task ID and are persisted under `.backend-team/locks/ownership/` for recovery.

- [ ] **Step 4: Mark mandatory shared resources**

Always serialize root/package manifests, lockfiles, shared TypeScript configs, OpenAPI contract, common exported types, `.specify/feature.json`, Drizzle schema, migration journal/directory, and generated dependency metadata. Agent prompts do not override this list.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/agent-team/test/ownership-manager.test.ts packages/agent-team/test/path-overlap.test.ts
git add packages/agent-team
git commit -m "feat: serialize owned and shared agent writes"
```

---

### Task 6: Persist context packets, handoffs, and parent verification

**Files:**
- Create: `packages/agent-team/src/context-builder.ts`
- Create: `packages/agent-team/src/handoff-store.ts`
- Create: `packages/agent-team/src/result-verifier.ts`
- Test: `packages/agent-team/test/context-builder.test.ts`
- Test: `packages/agent-team/test/handoff-store.test.ts`
- Test: `packages/agent-team/test/result-verifier.test.ts`

**Interfaces:**
- Consumes: `AgentTask`, artifact hashes, project profile, current policy summary, Agent result.
- Produces: `ContextBuilder.build()`, `HandoffStore.write()/acknowledge()`, `ResultVerifier.verify()`.

- [ ] **Step 1: Write failing privacy and verification tests**

```ts
it('excludes secrets and unrelated conversation text from context', async () => {
  const packet = await builder.build(task)
  expect(packet).not.toContain('DATABASE_PASSWORD')
  expect(packet).not.toContain('raw user conversation')
  expect(packet).toContain(task.objective)
})

it('rejects a passed result with an undeclared changed file', async () => {
  const result = { ...validResult, changedPaths: ['src/outside-owner.ts'] }
  await expect(verifier.verify(task, result)).rejects.toThrow('undeclared change')
})

it('retains a child handoff until parent acknowledgement is durable', async () => {
  const record = await store.write(childHandoff)
  expect(await store.exists(record.id)).toBe(true)
  await store.acknowledge(record.id, parentTaskId)
  expect((await store.read(record.id)).acknowledgedBy).toBe(parentTaskId)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/agent-team/test/context-builder.test.ts packages/agent-team/test/handoff-store.test.ts packages/agent-team/test/result-verifier.test.ts`

Expected: FAIL with missing services.

- [ ] **Step 3: Implement minimal context packets**

Include only objective/non-goals, role instructions, approved artifact excerpts with hashes, project profile facts, owned paths, exact tool capabilities, budget, done criteria, and return schema. Replace credential-like values with stable redaction markers and reject binary/oversized inputs.

- [ ] **Step 4: Implement durable handoffs and verification**

Write handoffs atomically under `.backend-team/handoff/<task-id>.json`. Verification checks schema, input hash freshness, changed paths, ownership, command evidence, exit codes, claimed outputs, budget, and child acknowledgements. A parent can mark `accepted`, `needs-rework`, or `rejected`; only accepted results reach the coordinator.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- --run packages/agent-team/test/context-builder.test.ts packages/agent-team/test/handoff-store.test.ts packages/agent-team/test/result-verifier.test.ts
git add packages/agent-team
git commit -m "feat: verify durable agent handoffs"
```

---

### Task 7: Wire the coordinator and prove the complete topology

**Files:**
- Create: `packages/core/src/team-coordinator.ts`
- Create: `packages/agent-team/src/team-runtime.ts`
- Create: `packages/core/src/application-action-catalog.ts`
- Test: `packages/core/test/team-coordinator.test.ts`
- Create: `tests/integration/agent-topology-flow.test.ts`
- Create: `docs/operations/agent-team-limits.md`

**Interfaces:**
- Consumes: `SpecificationCoordinator`, `ProjectAnalyzer`, `TaskScheduler`, `HandoffStore`, `StateStore`, `BackendTeamOrchestrationPort`.
- Produces: `TeamCoordinator.dispatchExpert()`, `acceptExpertResult()`, application progress events, an application action catalog, and a mock-driven Stage 04 runtime.

- [ ] **Step 1: Write the failing topology test**

```ts
it('allows expert children while preserving coordinator authority', async () => {
  const flow = createTopologyFixture({ experts: 3, childrenPerExpert: 3 })
  await flow.run()
  expect(flow.maxDepth()).toBe(2)
  expect(flow.maxConcurrentExperts()).toBe(3)
  expect(flow.maxConcurrentWriters()).toBe(2)
  expect(flow.phaseWriters()).toEqual(['coordinator'])
  expect(flow.userMessengers()).toEqual(['coordinator'])
  expect(flow.unacknowledgedHandoffs()).toEqual([])
})
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run packages/core/test/team-coordinator.test.ts tests/integration/agent-topology-flow.test.ts`

Expected: FAIL with missing runtime wiring.

- [ ] **Step 3: Implement coordinator-only authority**

The coordinator creates expert tasks, persists phase/task state, relays user approvals, accepts verified expert results, and emits progress. Experts receive a narrow delegation callback but no `StateStore`, approval API, user message API, or completion API. Workers receive no delegation callback.

- [ ] **Step 4: Register Agent Team tools only in valid phases**

The application defines status and user-facing workflow actions as `BackendTeamApplicationTool` values in an application-owned catalog. Internal expert spawn/delegation is not a general user tool. Do not modify the production Bundle or register these actions with Harness in this stage. Stage 01 production remains diagnostic-only; Stage 07 Task 2 owns the production `BackendTeamOrchestrationPort` implementation and exact official API/provenance gates, and Task 4 alone may register later actions after every required seam passes. UI visibility is advisory: the coordinator validates phase and action rules, and every write/process/network/database adapter immediately re-authorizes the exact side effect through the Policy Engine.

- [ ] **Step 5: Run adversarial and full checks**

Test worker attempts to delegate, expert attempts phase change, forged approval, outside ownership write, fourth child, fourth expert, third writer, stale input hash, missing handoff, and budget exhaustion. Then run:

```bash
npm test -- --run packages/agent-team/test packages/core/test tests/integration/agent-topology-flow.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all forbidden attempts fail before side effects and produce audit events.

- [ ] **Step 6: Document and commit**

```bash
git add packages/core packages/agent-team tests/integration/agent-topology-flow.test.ts docs/operations/agent-team-limits.md
git commit -m "feat: coordinate bounded expert agent teams"
```

## Stage 04 completion gate

Proceed only when experts demonstrably create valid depth-two workers under `MockBackendTeamOrchestrationPort`, workers cannot create further agents, all privilege escalation attempts fail, only the coordinator controls phase/approval/user communication, concurrency limits hold under stress, and every accepted result has a parent-verified durable handoff. This is application evidence only: no production Agent/event/approval binding exists until Stage 07 Task 2 passes.
