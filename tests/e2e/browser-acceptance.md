# Backend Team browser acceptance matrix

Status: `partial` — the matrix below records real Codex Chrome slices and their boundaries. It is not a full production journey pass.

Last checked: 2026-09-14. Detailed machine evidence: `.backend-team/artifacts/browser-acceptance-matrix-t19-20260914.json`; isolation rerun: `.backend-team/artifacts/browser-acceptance-matrix-t19-20260914-rerun.json`.

Run the following only against the actual DeepSeek Harness Web UI with Codex Chrome after the production Harness provenance gate is verified. Do not replace this with a mock client or a simulated trusted version field.

| Interaction | Required observable evidence | Current status |
|---|---|---|
| Open Backend Team panel | Accessible labels, task list, current-task marker, side-by-side panel | `passed` (real host, read-only) |
| Submit and refine requirements | User input, resulting phase, screenshot | `partial` (approval UI and isolated workflow; business submission gated) |
| Approve requirements and design | Approval controls, revision and resulting phases | `partial` (real card observed; user approval not impersonated) |
| Observe expert/subagent activity | Parent/child activity, usage, cancel/resume record | `partial` (isolated coordinator fixtures) |
| Approve workspace runtime installation | Consent text, workspace-local executable realpaths | `blocked` (release provenance) |
| Start PostgreSQL and DbGate | Loopback URL, authenticated DbGate view, listener audit | `passed` (isolated real runtime) |
| Design table, field, and index | DbGate actions, SQL preview, Drizzle diff, migration review | `partial` (GUI and migration slices; formal integration pending) |
| Continue development and inspect evidence | Build/verify phases and generated verification report | `passed` (real host, read-only delivery) |
| Interrupt and resume | Interrupted phase, recovery record, no duplicate side effects | `partial` (durable fixtures and restart state) |
| Uninstall Bundle | Profile row count, preserved project data, before/after snapshot | `blocked` (signed clean Profile missing) |

Record per run:

- Release candidate checksum, native architecture, fresh Profile identifier, and workspace identifier.
- Codex Chrome screenshots plus accessible labels used for every interaction.
- Console and network errors, redacted of credentials and sensitive project content.
- Profile-row count, workspace data-preservation result, and process/listener cleanup result.
- Links to the machine evidence and the ten scenario IDs in `scenarios.ts`.

The browser gate remains `partial` until every required row has evidence from the same production composition. It does not override the separate `blocked` Harness provenance or PostgreSQL-artifact gates, and it cannot establish real-model or dual-architecture evidence by itself.

The deterministic fixture executor in `scenarios.ts` exercises only the catalog contract. It is not a browser run and cannot change this status.

### 2026-09-15 refresh

The real Codex Chrome slices now include the same isolated production-host evidence used by T13, T14 and T18: DbGate 7.2.3 → ORM/migration, restart recovery of a pending migration, and dark 390×844 task progress, approval preview, resource panel and task-center states. The narrow layout fix changed the progress summary to an icon column plus a full-width content column; the host stayed at `document/body.scrollWidth=390` and no approval decision was taken. The machine-readable update is `.backend-team/artifacts/browser-acceptance-matrix-t19-20260915.json`.

The matrix remains `partial`. The full ten-scenario journey still needs one same-production-composition run, protected production Harness/model provenance, signed dual-architecture release materials, and the signed release-candidate uninstall path. The refresh does not approve a business task or promote a release.
