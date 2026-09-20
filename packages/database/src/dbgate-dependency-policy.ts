export interface DbGateDependencyPolicy {
  readonly component: 'dbgate'
  readonly version: '7.2.3'
  /**
   * DbGate is installed as a PostgreSQL-only runtime.  `dbgate-serve` pulls in
   * every built-in connector, including the unmaintained Excel connector and
   * its vulnerable `xlsx` dependency.  The API and web packages are sufficient
   * for the same 7.2.3 UI when the launcher supplies an allowlisted plugin
   * directory.
   */
  readonly packages: readonly ['dbgate-api@7.2.3', 'dbgate-web@7.2.3', 'dbgate-plugin-postgres@7.2.3']
  readonly overrides: Readonly<{
    'dbgate-api': Readonly<{ jsonwebtoken: '9.0.3'; tar: '7.5.22' }>
    'flat-cache': Readonly<{ flatted: '3.4.4' }>
    'external-editor': Readonly<{ tmp: '0.2.7' }>
    qs: '6.16.0'
    http: '0.0.1-security'
  }>
  readonly residualRisks: Readonly<Record<never, never>>
}

export const DBGATE_DEPENDENCY_POLICY: DbGateDependencyPolicy = Object.freeze({
  component: 'dbgate',
  version: '7.2.3',
  packages: ['dbgate-api@7.2.3', 'dbgate-web@7.2.3', 'dbgate-plugin-postgres@7.2.3'] as const,
  overrides: Object.freeze({
    'dbgate-api': Object.freeze({ jsonwebtoken: '9.0.3', tar: '7.5.22' }),
    'flat-cache': Object.freeze({ flatted: '3.4.4' }),
    'external-editor': Object.freeze({ tmp: '0.2.7' }),
    qs: '6.16.0',
    http: '0.0.1-security',
  }),
  residualRisks: Object.freeze({}),
})
