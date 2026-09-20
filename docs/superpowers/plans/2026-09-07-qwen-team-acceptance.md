# Qwen and BackendTeam acceptance implementation plan

**Goal:** Validate the configured direct Qwen model API through Chrome and advance the smallest real BackendTeam workflow without replacing DSH's Agent loop.

**Architecture:** Reuse the installed rc.6 `llm-pi-ai` provider and existing production composition. Keep credentials in DSH's credential store. Use isolated acceptance workspaces and explicit tool permissions. Distinguish model/ordinary DSH acceptance from the BackendTeam production workflow.

- [x] Verify real text and host tool execution from Chrome; save sanitized evidence.
- [x] Verify synthetic image input and streaming/cancellation where exposed.
- [x] Inspect production entry dependencies; fix the discovered production usage-accounting defect with regression tests. The separate specification-artifact boundary remains outstanding.
- [x] Run relevant checks and update evidence with remaining prerequisites, without marking mocked workflows as real production acceptance.

Real production BUILD acceptance also passed: actual Qwen, actual TeamCoordinator, managed write/read, structured result acceptance. Approvals were seeded test inputs, no command tool was enabled, and this is not full specification/UI acceptance. The earlier insufficient 4096-token total budget failure is preserved separately; the successful probe used an explicit larger task budget.

User approved this direction after the remaining-work assessment. No Python installation, production deployment, or unrelated working-tree cleanup is included.

Inspection found a production budget-accounting bug: only the last assistant message was counted. The regression first failed (18 instead of 56 tokens), then passed after summing per-call message usage including disjoint cache input. Invalid cache counts now fail closed. Scope excludes prior-session events and does not double-count reasoning tokens.

Production specification assembly requires a dedicated artifact-writing boundary: current specification spawns lack AgentTask, development-only tools reject pre-approval phases, and feature-relative paths do not match workspace-relative tools. Do not solve this by weakening the development guards.

Follow-up: the separate document-writing boundary and structured specification
task dispatch have now been implemented and regression tested. See
`2026-09-07-specification-agent-tools.md` for real-model probe status and the
remaining default Web workflow release gate.
