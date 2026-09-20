import type { Assignment, AssignmentCreateRequest } from '../contract/dto.ts';
import { PersonnelError } from '../contract/errors.ts';
import { recordChanges, type AuditContext } from './audit.ts';
import type { AssignmentRow, PersonnelDatabase, PersonnelTransaction, PersonRow } from './store.ts';
import { isIsoCalendarDate } from './validation.ts';

export interface AssignmentContext extends AuditContext {
  /** 用于测试和批处理的业务日期；未提供时取 clock 的日期。 */
  today?: string;
}

function defaultUuid(): string {
  return globalThis.crypto.randomUUID();
}

function businessDate(context: AssignmentContext): string {
  return context.today ?? (context.clock ?? (() => new Date().toISOString()))().slice(0, 10);
}

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PersonnelError('validation_failed', '任职变更请求必须是 JSON 对象', {
      fieldErrors: [{ field: 'request', message: '任职变更请求必须是 JSON 对象' }],
    });
  }
  return input as Record<string, unknown>;
}

function requiredText(input: Record<string, unknown>, field: string, max: number): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PersonnelError('validation_failed', `字段（${field}）为必填项且不能为空`, {
      fieldErrors: [{ field, message: `字段（${field}）为必填项且不能为空` }],
    });
  }
  if (value.length > max) {
    throw new PersonnelError('validation_failed', `字段（${field}）长度不能超过 ${max} 个字符`, {
      fieldErrors: [{ field, message: `字段（${field}）长度不能超过 ${max} 个字符` }],
    });
  }
  return value;
}

function optionalText(input: Record<string, unknown>, field: string, max: number): string | null {
  const value = input[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new PersonnelError('validation_failed', `字段（${field}）必须是长度不超过 ${max} 的字符串`, {
      fieldErrors: [{ field, message: `字段（${field}）必须是长度不超过 ${max} 的字符串` }],
    });
  }
  return value;
}

function requiredDate(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || !isIsoCalendarDate(value)) {
    throw new PersonnelError('validation_failed', `日期字段（${field}）必须是 YYYY-MM-DD 格式的有效日期`, {
      fieldErrors: [{ field, message: `日期字段（${field}）必须是 YYYY-MM-DD 格式的有效日期` }],
    });
  }
  return value;
}

function optionalDate(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isIsoCalendarDate(value)) {
    throw new PersonnelError('validation_failed', `日期字段（${field}）必须是 YYYY-MM-DD 格式的有效日期或 null`, {
      fieldErrors: [{ field, message: `日期字段（${field}）必须是 YYYY-MM-DD 格式的有效日期或 null` }],
    });
  }
  return value;
}

export function validateAssignmentCreate(input: unknown): AssignmentCreateRequest {
  const source = asObject(input);
  const departmentId = requiredText(source, 'departmentId', 64);
  const departmentName = requiredText(source, 'departmentName', 64);
  const positionName = requiredText(source, 'positionName', 64);
  const effectiveFrom = requiredDate(source, 'effectiveFrom');
  const positionId = optionalText(source, 'positionId', 64);
  const reportsToPersonId = optionalText(source, 'reportsToPersonId', 128);
  const effectiveTo = optionalDate(source, 'effectiveTo');
  if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
    throw new PersonnelError('validation_failed', '任职结束日期必须晚于生效日期', {
      fieldErrors: [{ field: 'effectiveTo', message: '任职结束日期必须晚于生效日期' }],
    });
  }
  const request: AssignmentCreateRequest = {
    departmentId,
    departmentName,
    positionName,
    effectiveFrom,
    effectiveTo,
  };
  if (positionId !== null) request.positionId = positionId;
  request.reportsToPersonId = reportsToPersonId;
  return request;
}

function effectiveAssignmentAt(assignments: readonly AssignmentRow[], personId: string, at: string): AssignmentRow | null {
  return (
    assignments
      .filter(
        (assignment) =>
          assignment.person_id === personId &&
          assignment.status !== 'retracted' &&
          assignment.effective_from <= at &&
          (assignment.effective_to === null || at < assignment.effective_to),
      )
      .sort((left, right) => right.effective_from.localeCompare(left.effective_from))[0] ?? null
  );
}

function rangesOverlap(
  leftStart: string,
  leftEnd: string | null,
  rightStart: string,
  rightEnd: string | null,
): boolean {
  return (leftEnd === null || rightStart < leftEnd) && (rightEnd === null || leftStart < rightEnd);
}

function assertNoOverlap(
  assignments: readonly AssignmentRow[],
  personId: string,
  request: AssignmentCreateRequest,
  status: AssignmentRow['status'],
): void {
  for (const existing of assignments) {
    if (existing.person_id !== personId || existing.status === 'retracted') continue;
    let existingEnd = existing.effective_to;
    // 当前任职是开放区间；登记未来任职时，其逻辑结束点就是新任职的生效日。
    if (status === 'pending' && existing.status === 'current' && existingEnd === null && existing.effective_from < request.effectiveFrom) {
      existingEnd = request.effectiveFrom;
    }
    // 生效中的新任职会在同一事务内关闭旧的 current 区间。
    if (status === 'current' && existing.status === 'current' && existing.effective_from < request.effectiveFrom) continue;
    if (rangesOverlap(existing.effective_from, existingEnd, request.effectiveFrom, request.effectiveTo ?? null)) {
      throw new PersonnelError(
        'overlapping_assignment',
        `任职区间与既有区间 ${existing.id}（${existing.effective_from} 至 ${existing.effective_to ?? '未定'}）重叠`,
        { conflictRef: existing.id },
      );
    }
  }
}

/** 校验任职记录的汇报关系，供建档与调岗共用。 */
export function assertReportLine(
  tx: PersonnelTransaction,
  person: PersonRow,
  reportsToPersonId: string | null,
  effectiveFrom: string,
): void {
  if (reportsToPersonId === null) return;
  if (reportsToPersonId === person.id) {
    throw new PersonnelError('invalid_report_line', '汇报上级不能是本人（R4）', { conflictRef: person.id });
  }
  const manager = tx.findPersonById(reportsToPersonId);
  if (manager === null || manager.status !== 'active') {
    throw new PersonnelError('invalid_report_line', '汇报上级必须是生效日期时的在职人员（R4）', {
      conflictRef: reportsToPersonId,
    });
  }
  const seen = new Set<string>([person.id]);
  let cursor: string | null = reportsToPersonId;
  const assignments = tx.listAssignments();
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new PersonnelError('invalid_report_line', '汇报关系形成环路（R4）', { conflictRef: cursor });
    }
    seen.add(cursor);
    const current = effectiveAssignmentAt(assignments, cursor, effectiveFrom);
    cursor = current?.reports_to_person_id ?? null;
  }
}

function assignmentToDto(row: AssignmentRow): Assignment {
  const result: Assignment = {
    assignmentId: row.id,
    personId: row.person_id,
    departmentId: row.department_id,
    departmentName: row.department_name,
    positionName: row.position_name,
    reportsToPersonId: row.reports_to_person_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
  };
  if (row.position_id !== null) result.positionId = row.position_id;
  return result;
}

function closeCurrentAssignment(tx: PersonnelTransaction, personId: string, effectiveTo: string, now: string): AssignmentRow | null {
  const current = tx.listAssignmentsByPerson(personId).find(
    (assignment) => assignment.status === 'current' && assignment.effective_from < effectiveTo,
  );
  if (current === undefined) return null;
  const closed = { ...current, effective_to: effectiveTo, status: 'closed' as const, updated_at: now };
  tx.updateAssignment(closed);
  return closed;
}

export function createAssignment(
  db: PersonnelDatabase,
  personId: string,
  input: unknown,
  context: AssignmentContext = {},
): Assignment {
  const request = validateAssignmentCreate(input);
  const nextId = context.idFactory ?? defaultUuid;
  const now = (context.clock ?? (() => new Date().toISOString()))();
  const status: AssignmentRow['status'] = request.effectiveFrom <= businessDate(context) ? 'current' : 'pending';

  return db.transaction((tx) => {
    const person = tx.findPersonById(personId);
    if (person === null) throw new PersonnelError('not_found', `人员档案 ${personId} 不存在`);
    if (person.status !== 'active') throw new PersonnelError('conflict', '停用人员不能新增任职记录', { conflictRef: personId });
    assertReportLine(tx, person, request.reportsToPersonId ?? null, request.effectiveFrom);
    assertNoOverlap(tx.listAssignmentsByPerson(personId), personId, request, status);

    const previous = effectiveAssignmentAt(tx.listAssignments(), personId, request.effectiveFrom);
    if (status === 'current') closeCurrentAssignment(tx, personId, request.effectiveFrom, now);

    const row: AssignmentRow = {
      id: nextId(),
      person_id: personId,
      department_id: request.departmentId,
      department_name: request.departmentName,
      position_id: request.positionId ?? null,
      position_name: request.positionName,
      reports_to_person_id: request.reportsToPersonId ?? null,
      effective_from: request.effectiveFrom,
      effective_to: request.effectiveTo ?? null,
      status,
      created_at: now,
      updated_at: now,
    };
    tx.insertAssignment(row);
    recordChanges(tx, personId, [
      { action: 'assignment_change', fieldName: 'departmentId', oldValue: previous?.department_id, newValue: row.department_id, effectiveFrom: row.effective_from, effectiveTo: row.effective_to },
      { action: 'assignment_change', fieldName: 'departmentName', oldValue: previous?.department_name, newValue: row.department_name, effectiveFrom: row.effective_from, effectiveTo: row.effective_to },
      { action: 'assignment_change', fieldName: 'positionId', oldValue: previous?.position_id, newValue: row.position_id, effectiveFrom: row.effective_from, effectiveTo: row.effective_to },
      { action: 'assignment_change', fieldName: 'positionName', oldValue: previous?.position_name, newValue: row.position_name, effectiveFrom: row.effective_from, effectiveTo: row.effective_to },
      { action: 'assignment_change', fieldName: 'reportsToPersonId', oldValue: previous?.reports_to_person_id, newValue: row.reports_to_person_id, effectiveFrom: row.effective_from, effectiveTo: row.effective_to },
    ], context);
    return assignmentToDto(row);
  });
}

export function applyDueAssignments(db: PersonnelDatabase, asOf: string, context: AssignmentContext = {}): void {
  const now = (context.clock ?? (() => new Date().toISOString()))();
  db.transaction((tx) => {
    const due = tx
      .listAssignments()
      .filter((assignment) => assignment.status === 'pending' && assignment.effective_from <= asOf)
      .sort((left, right) => left.effective_from.localeCompare(right.effective_from));
    for (const pending of due) {
      const previous = effectiveAssignmentAt(tx.listAssignments(), pending.person_id, pending.effective_from);
      closeCurrentAssignment(tx, pending.person_id, pending.effective_from, now);
      const current = { ...pending, status: 'current' as const, updated_at: now };
      tx.updateAssignment(current);
      if (previous !== null && previous.id !== current.id) {
        recordChanges(tx, pending.person_id, [
          { action: 'assignment_change', fieldName: 'assignmentStatus', oldValue: 'pending', newValue: 'current', effectiveFrom: pending.effective_from },
        ], context);
      }
    }
  });
}

export function retractAssignment(
  db: PersonnelDatabase,
  personId: string,
  assignmentId: string,
  context: AssignmentContext = {},
): Assignment {
  const now = (context.clock ?? (() => new Date().toISOString()))();
  return db.transaction((tx) => {
    const row = tx.findAssignmentById(assignmentId);
    if (row === null || row.person_id !== personId) throw new PersonnelError('not_found', `任职记录 ${assignmentId} 不存在`);
    if (row.status !== 'pending') {
      throw new PersonnelError('not_yet_retractable', '已生效的任职变更不可撤销（仅 pending 可撤销）', {
        conflictRef: assignmentId,
      });
    }
    const retracted = { ...row, status: 'retracted' as const, updated_at: now };
    tx.updateAssignment(retracted);
    recordChanges(tx, personId, [{ action: 'assignment_retract', fieldName: 'assignmentStatus', oldValue: 'pending', newValue: 'retracted', effectiveFrom: row.effective_from }], context);
    return assignmentToDto(retracted);
  });
}
