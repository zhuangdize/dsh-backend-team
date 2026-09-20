# PostgreSQL 18.6 portable runtime

The team pins the official PostgreSQL 18.6 source archive and verifies its SHA-256 before a native macOS build. Runtime files are installed only below `.backend-team/runtime/postgresql` in the target workspace.

The checked-in Darwin manifest is intentionally marked `pending-native-build`. It contains no fabricated artifact URL or binary hash. Release is blocked until native arm64 and x64 builds pass dependency-closure, architecture, temporary-cluster, and write-boundary checks.

On the current Apple Silicon host, `scripts/build-postgresql-runtime.sh` has
produced a local-only arm64 archive at
`.backend-team/artifacts/postgresql-18.6-darwin-arm64.tar.xz` with SHA-256
`2c91690995dab19f4193b60297a4070f9c28df96bcf2711a49dcc48d6bae4ec0`.
`npm run verify:postgresql-execution-port` extracts that archive, initializes
an SCRAM cluster, verifies loopback binding and `pg_isready`, creates the
workspace development/test databases, executes `CREATE TABLE`/`INSERT`/`SELECT`
through the verified execution port, and stops the cluster. This is local
development evidence only; it is not a release artifact attestation.
