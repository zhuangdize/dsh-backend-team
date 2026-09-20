export interface ProtectedOperation {
  readonly operationId: string
  readonly requiresAuth: boolean
  readonly requiresRole?: boolean
  readonly requiresTenantIsolation?: boolean
}

export interface AuthorizationEvidence {
  readonly operationId: string
  readonly unauthenticatedDenied: boolean
  readonly wrongRoleDenied?: boolean
  readonly crossTenantDenied?: boolean
  readonly allowedRoleSucceeded: boolean
}

export interface AuthorizationFinding {
  readonly code: 'MISSING_DENY_AUTH_TEST' | 'MISSING_DENY_ROLE_TEST' | 'MISSING_DENY_TENANT_TEST' | 'MISSING_ALLOW_AUTH_TEST'
  readonly operationId: string
  readonly severity: 'block'
  readonly message: string
}

/** Requires both negative and positive authorization evidence for protected API operations. */
export class AuthorizationReview {
  review(operations: readonly ProtectedOperation[], evidence: readonly AuthorizationEvidence[]): readonly AuthorizationFinding[] {
    const byOperation = new Map(evidence.map((item) => [item.operationId, item]))
    const findings: AuthorizationFinding[] = []
    for (const operation of operations.filter((item) => item.requiresAuth)) {
      const current = byOperation.get(operation.operationId)
      if (!current || !current.unauthenticatedDenied) findings.push({ code: 'MISSING_DENY_AUTH_TEST', operationId: operation.operationId, severity: 'block', message: 'protected operation lacks unauthenticated denial evidence' })
      if (!current || !current.allowedRoleSucceeded) findings.push({ code: 'MISSING_ALLOW_AUTH_TEST', operationId: operation.operationId, severity: 'block', message: 'protected operation lacks allowed-role success evidence' })
      if (operation.requiresRole && (!current || !current.wrongRoleDenied)) findings.push({ code: 'MISSING_DENY_ROLE_TEST', operationId: operation.operationId, severity: 'block', message: 'role-protected operation lacks wrong-role denial evidence' })
      if (operation.requiresTenantIsolation && (!current || !current.crossTenantDenied)) findings.push({ code: 'MISSING_DENY_TENANT_TEST', operationId: operation.operationId, severity: 'block', message: 'tenant-isolated operation lacks cross-tenant denial evidence' })
    }
    return Object.freeze(findings)
  }
}
