import type { ChangeRecordRow, PersonnelTransaction } from './store.ts';

export interface AuditContext {
  operatorId?: string;
  operatorName?: string;
  idFactory?: () => string;
  clock?: () => string;
}

export interface AuditChange {
  action: ChangeRecordRow['action'];
  fieldName: string;
  oldValue?: string | null;
  newValue?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

function defaultUuid(): string {
  return globalThis.crypto.randomUUID();
}

function valueOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function recordChanges(
  tx: PersonnelTransaction,
  personId: string,
  changes: readonly AuditChange[],
  context: AuditContext = {},
): void {
  const nextId = context.idFactory ?? defaultUuid;
  const occurredAt = (context.clock ?? (() => new Date().toISOString()))();
  const operatorId = context.operatorId ?? 'system';
  for (const change of changes) {
    tx.insertChangeRecord({
      id: nextId(),
      person_id: personId,
      action: change.action,
      field_name: change.fieldName,
      old_value: valueOf(change.oldValue),
      new_value: valueOf(change.newValue),
      operator_id: operatorId,
      operator_name: context.operatorName ?? null,
      occurred_at: occurredAt,
      effective_from: change.effectiveFrom ?? null,
      effective_to: change.effectiveTo ?? null,
    });
  }
}
