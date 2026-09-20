# Backend Team Read-Only Overlay Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Harness client overlay explain the current read-only/blocked state when the production control route is unavailable.

**Architecture:** The browser overlay receives an optional, bounded diagnostic descriptor from the Bundle client entry. It uses that descriptor only for local explanatory rendering after a failed state request; it never enables dispatch, creates credentials, or guesses a host session. Existing control-route behavior remains unchanged.

**Tech Stack:** TypeScript, structural React client contract, Vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-25-backend-agent-team-design.md`

## Global Constraints

- The default Bundle remains diagnostic-only until official host authentication, control-route, coordinator, and production Agent provenance are verified.
- The client cannot launch processes, write files, spawn Agents, approve actions, or access database credentials.
- Diagnostic text is bounded, non-secret, and must not include raw URLs, filesystem paths, prompts, or environment values.
- Existing same-origin and loopback checks remain mandatory.

---

### Task 1: Add a bounded read-only diagnostic descriptor

**Files:**
- Modify: `packages/web/src/client-overlay.ts`
- Modify: `packages/web/src/index.ts`
- Test: `packages/web/test/client-overlay.test.ts`

**Interfaces:**
- Consumes: optional `BackendTeamOverlayOptions.diagnostic` supplied by the host/client entry.
- Produces: `BackendTeamOverlayDiagnostic` and `formatBackendTeamOverlayDiagnostic()` for deterministic user-facing text.

- [x] **Step 1: Write the failing formatter tests**

```ts
it('formats a bounded read-only diagnostic without exposing paths', () => {
  expect(formatBackendTeamOverlayDiagnostic({
    mode: 'read-only',
    reason: 'production-agent-runtime-not-wired-in-diagnostic-bundle',
    missing: ['agents', 'session-auth'],
  })).toBe('当前为只读诊断模式。缺少能力：agents、session-auth。原因：production-agent-runtime-not-wired-in-diagnostic-bundle。')
})

it('limits diagnostic entries and rejects unsupported modes', () => {
  expect(() => formatBackendTeamOverlayDiagnostic({ mode: 'supported', reason: 'nope' } as never)).toThrow(/read-only/iu)
})
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run packages/web/test/client-overlay.test.ts`

Expected: FAIL because the diagnostic type and formatter do not exist.

- [x] **Step 3: Implement the bounded formatter and option**

Add a `read-only`-only descriptor with a maximum of eight missing capabilities and one 200-character reason. Export the formatter. Keep the existing fetch transport and dispatch validation unchanged.

- [x] **Step 4: Run the focused test and lint**

Run: `npx vitest run packages/web/test/client-overlay.test.ts && npx eslint packages/web/src/client-overlay.ts packages/web/src/index.ts packages/web/test/client-overlay.test.ts --quiet`

Expected: all focused tests pass and ESLint exits with code 0.

### Task 2: Render the diagnostic fallback without enabling mutations

**Files:**
- Modify: `packages/web/src/client-overlay.ts`
- Modify: `packages/bundle/src/client.ts`
- Test: `packages/web/test/client-overlay.test.ts`
- Test: `packages/bundle/test/client-manifest.test.ts`

**Interfaces:**
- Consumes: `BackendTeamOverlayDiagnostic` and the existing `createBackendTeamOverlayComponent()` factory.
- Produces: an overlay fallback that shows the diagnostic reason only when state loading fails; no control client is created and no dispatch button is enabled.

- [x] **Step 1: Write the failing fallback test**

Assert that the exported diagnostic fallback renderer returns a status region containing the read-only message and that it exposes no action callback.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run packages/web/test/client-overlay.test.ts packages/bundle/test/client-manifest.test.ts`

Expected: FAIL because the fallback renderer is not exposed or wired into the client factory.

- [x] **Step 3: Implement the fallback and pass the static descriptor from the Bundle client**

When the initial `/state` request fails, render the bounded diagnostic status if supplied; otherwise preserve the existing generic message. Do not render approval, database, or dispatch actions in this branch. Pass the known Stage 07 read-only reason from `packages/bundle/src/client.ts` without adding host credentials or filesystem data.

- [x] **Step 4: Run package tests, build, and packed Bundle verification**

Run: `npx vitest run packages/web/test packages/bundle/test && npm run typecheck && npm run build && node scripts/test-packed-bundle.mjs`

Expected: all selected tests pass, build exits 0, and the packed Bundle has exactly the expected files.

- [ ] **Step 5: Commit**

```bash
git add packages/web packages/bundle/src/client.ts docs/superpowers/plans/2026-09-04-backend-team-readonly-overlay.md
git commit -m "feat: explain read-only backend team status"
```

---

## Self-review

- The plan does not activate production orchestration or claim official host authentication.
- All diagnostic values are bounded and do not include paths, URLs, secrets, or prompts.
- Mutation remains unavailable when the control route cannot supply state.
