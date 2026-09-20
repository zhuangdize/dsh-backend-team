export interface MigrationPreview { readonly migrationId: string; readonly sql: string; readonly sqlSha256: string; readonly risk: 'standard' | 'high' | 'destructive'; readonly reverseSql?: string }
export interface MigrationStatus { readonly applied: readonly string[]; readonly pending: readonly string[] }
export interface MigrationAdapter {
  preview(signal?: AbortSignal): Promise<MigrationPreview>
  apply(preview: MigrationPreview, approvalToken: string, signal?: AbortSignal): Promise<MigrationPreview>
  status(signal?: AbortSignal): Promise<MigrationStatus>
}
