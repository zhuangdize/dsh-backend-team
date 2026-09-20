# Codex App Server model route for DSH

The approved goal is a configurable Codex backend that works without a DeepSeek API key. A DSH model adapter is preferable to an isolated diagnostic button: the user selects the Codex route in the existing model picker and existing DSH agents use it.

The Bundle's optional `codexAppServer.enabled` configuration registers `codex-app-server`. An explicit local executable path avoids using an HTTP compatibility proxy or extracting ChatGPT tokens. App Server owns account state and model discovery. Communication is child-process stdio with timeouts, cancellation and bounded buffers.

The adapter sends complete DSH message history for each model request. It maps DSH tool schemas to client-owned dynamic tools, captures requested calls, and returns them to DSH for execution. Codex environment/native tool access must be disabled and verified; the DSH guard, ownership and patch path remain authoritative. Unsupported media/options are rejected explicitly. This is not unrestricted Codex execution inside the project.

Model listing uses `model/list`; account status uses `account/read` without exposing credentials. No model ID or subscription entitlement is fabricated. Failed login, disabled configuration and unavailable binary produce actionable errors. Missing DeepSeek credentials do not block registration of the Codex route.

Validation: stdio protocol fixtures; model/tool/usage/cancellation adapter tests; actual local account/model discovery; actual Codex text and host-tool roundtrip; packed Bundle registration; Codex Chrome model selection and real response. Full existing production workflow and Python installation remain separate from this change.

Validated against Codex CLI 0.148.0. Empty environments alone do not remove native skills. The bridge also disables `orchestrator.skills` and `orchestrator.mcp`, native utility tools, inherited MCP servers and plugins. A loopback registry probe with explicit dummy credentials exposed only the declared DSH dynamic tool. Existing formal Codex login remains managed by Codex for real inference.

Current limits: text is buffered until completion; images, temperature and stop sequences are rejected. App Server has no per-request hard output-token cap, so maxTokens is checked against returned usage and cannot guarantee an upstream cost ceiling. See [configuration and usage](../../codex-app-server.md).
