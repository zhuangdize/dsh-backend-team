# Real DSH production ports

**Goal:** Connect the Backend Team production entry to verifiable DeepSeek Harness rc.6 Host/WebServer, Session, Agent, and workspace-local PostgreSQL execution seams without weakening the diagnostic default or inventing undocumented APIs.

**Architecture:** Keep the Bundle's default `apply()` diagnostic-only. Add explicit structural adapters for the official `ctx.webServer`, `ctx.sessions`, and `ctx.agents` services; require the host to pass the real Cordis context and loopback route binding. Expose database lifecycle through a narrow application port backed by the existing `PostgresqlCluster`, `DatabaseCatalog`, and optional `DbGateLauncher`; no raw SQL, credentials, or arbitrary process runner crosses the Bundle boundary.

## Tasks

- [x] Add failing contract tests for a verified DSH host-context adapter and its fail-closed behavior.
- [x] Add failing contract tests for the database execution port and lifecycle/GUI navigation mapping.
- [x] Implement the adapters and export them from the public Bundle surface.
- [x] Wire the explicit production host helper to accept the verified Host/Session/Agent context and database port.
- [x] Run focused tests, typecheck, lint, build, packed-bundle checks, and local rc.6 smoke checks; update compatibility evidence without claiming unproven official capabilities.

## Safety gates

- Host binding must be the official `webServer.register` shape and loopback-only route owner.
- Session authentication must require exact live Session + Agent identity and canonical workspace cwd.
- Agent creation must retain the official `ctx.agents.create()` lifecycle and dispose the returned handle.
- Database actions must remain workspace-local, loopback-only, and revision-fenced; missing dependencies return read-only/failure-closed behavior.
