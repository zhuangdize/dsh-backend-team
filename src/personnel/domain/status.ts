import type { PersonDetail, StatusTransitionRequest } from '../contract/dto.ts';
import { PersonnelError } from '../contract/errors.ts';
import { recordChanges, type AuditContext } from './audit.ts';
import { personDetailFromRows } from './service.ts';
import type { PersonnelDatabase, PersonnelTransaction } from './store.ts';
import { isIsoCalendarDate } from './validation.ts';

export type StatusContext = AuditContext

function asRequest(input: unknown): StatusTransitionRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PersonnelError('validation_failed', '状态流转请求必须是 JSON 对象', {
      fieldErrors: [{ field: 'request', message: '状态流转请求必须是 JSON 对象' }],
    });
  }
  const source = input as Record<string, unknown>;
  const toStatus = source.toStatus;
  const effectiveFrom = source.effectiveFrom;
  if (toStatus !== 'active' && toStatus !== 'inactive') {
    throw new PersonnelError('validation_failed', 'toStatus 必须是 active 或 inactive', {
      fieldErrors: [{ field: 'toStatus', message: 'toStatus 必须是 active 或 inactive' }],
    });
  }
  if (typeof effectiveFrom !== 'string' || !isIsoCalendarDate(effectiveFrom)) {
    throw new PersonnelError('validation_failed', 'effectiveFrom 必须是 YYYY-MM-DD 格式的有效日期', {
      fieldErrors: [{ field: 'effectiveFrom', message: 'effectiveFrom 必须是 YYYY-MM-DD 格式的有效日期' }],
    });
  }
  const reason = source.reason;
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 200)) {
    throw new PersonnelError('validation_failed', 'reason 必须是长度不超过 200 的字符串或 null', {
      fieldErrors: [{ field: 'reason', message: 'reason 必须是长度不超过 200 的字符串或 null' }],
    });
  }
  return { toStatus, effectiveFrom, reason: reason as string | null | undefined };
}

function currentAssignmentAt(db: PersonnelTransaction, personId: string, at: string) {
  return (
    db
      .listAssignmentsByPerson(personId)
      .filter(
        (assignment) =>
          assignment.status !== 'retracted' &&
          assignment.effective_from <= at &&
          (assignment.effective_to === null || at < assignment.effective_to),
      )
      .sort((left, right) => right.effective_from.localeCompare(left.effective_from))[0] ?? null
  );
}

export function transitionPersonStatus(
  db: PersonnelDatabase,
  personId: string,
  input: unknown,
  context: StatusContext = {},
): PersonDetail {
  const request = asRequest(input);
  const now = (context.clock ?? (() => new Date().toISOString()))();
  return db.transaction((tx) => {
    const person = tx.findPersonById(personId);
    if (person === null) throw new PersonnelError('not_found', `人员档案 ${personId} 不存在`);

    const allowed = (person.status === 'draft' && request.toStatus === 'active') || (person.status === 'active' && request.toStatus === 'inactive');
    if (!allowed) {
      throw new PersonnelError('invalid_status_transition', `不允许从 ${person.status} 流转到 ${request.toStatus}（R2）`, {
        conflictRef: personId,
      });
    }
    if (request.toStatus === 'inactive' && (request.reason === undefined || request.reason === null || request.reason.trim() === '')) {
      throw new PersonnelError('validation_failed', '停用必须填写 reason（停用原因）', {
        fieldErrors: [{ field: 'reason', message: '停用必须填写 reason（停用原因）' }],
      });
    }

    const previousStatus = person.status;
    const updated = {
      ...person,
      status: request.toStatus,
      deactivated_on: request.toStatus === 'inactive' ? request.effectiveFrom : null,
      deactivation_reason: request.toStatus === 'inactive' ? request.reason ?? null : null,
      updated_at: now,
    };
    tx.updatePerson(updated);

    const assignment = currentAssignmentAt(tx, personId, request.effectiveFrom);
    if (request.toStatus === 'inactive' && assignment !== null) {
      tx.updateAssignment({ ...assignment, effective_to: request.effectiveFrom, status: 'closed', updated_at: now });
    }
    recordChanges(tx, personId, [
      { action: 'status_change', fieldName: 'status', oldValue: previousStatus, newValue: request.toStatus, effectiveFrom: request.effectiveFrom },
      ...(request.toStatus === 'inactive'
        ? [
            { action: 'status_change' as const, fieldName: 'deactivationReason', oldValue: person.deactivation_reason, newValue: request.reason ?? null, effectiveFrom: request.effectiveFrom },
          ]
        : []),
    ], context);

    return personDetailFromRows(updated, request.toStatus === 'inactive' ? null : currentAssignmentAt(tx, personId, request.effectiveFrom));
  });
}
