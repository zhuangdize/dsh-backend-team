import type { ChangeRecord, PersonDetail } from '../contract/dto.ts';
import { PersonnelError } from '../contract/errors.ts';
import { recordChanges, type AuditContext } from './audit.ts';
import { personDetailFromRows } from './service.ts';
import type { ChangeRecordRow, PersonnelDatabase } from './store.ts';

export interface LifecycleContext extends AuditContext {
  /** 业务引用查询由宿主模块注入，人员模块不复制下游业务数据。 */
  isReferenced?: (personId: string) => boolean;
  deleteAuthorized?: boolean;
}

export interface HistoryPage {
  items: ChangeRecord[];
  page: number;
  pageSize: number;
  total: number;
}

function toDto(row: ChangeRecordRow): ChangeRecord {
  return {
    recordId: row.id,
    personId: row.person_id,
    action: row.action,
    fieldName: row.field_name,
    oldValue: row.old_value,
    newValue: row.new_value,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    occurredAt: row.occurred_at,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

function pageArgs(page = 1, pageSize = 20): [number, number] {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new PersonnelError('validation_failed', '分页参数不合法', {
      fieldErrors: [
        { field: 'page', message: 'page 必须是大于等于 1 的整数' },
        { field: 'pageSize', message: 'pageSize 必须是 1–200 的整数' },
      ],
    });
  }
  return [page, pageSize];
}

export function listPersonHistory(db: PersonnelDatabase, personId: string, page = 1, pageSize = 20): HistoryPage {
  if (db.findPersonById(personId) === null) throw new PersonnelError('not_found', `人员档案 ${personId} 不存在`);
  const [validPage, validPageSize] = pageArgs(page, pageSize);
  const records = db
    .listChangeRecords(personId)
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at) || right.id.localeCompare(left.id));
  const start = (validPage - 1) * validPageSize;
  return {
    items: records.slice(start, start + validPageSize).map(toDto),
    page: validPage,
    pageSize: validPageSize,
    total: records.length,
  };
}

export function deletePerson(db: PersonnelDatabase, personId: string, context: LifecycleContext = {}): void {
  if (context.deleteAuthorized !== true) throw new PersonnelError('forbidden', '当前操作未获得物理删除授权');
  const person = db.findPersonById(personId);
  if (person === null) throw new PersonnelError('not_found', `人员档案 ${personId} 不存在`);
  const referenced = context.isReferenced?.(personId) === true || db.listAssignmentsByPerson(personId).length > 0;
  if (referenced) {
    // 删除尝试本身是审计事实，不能随着失败事务回滚。
    recordChanges(db, personId, [{ action: 'delete_attempt', fieldName: 'person', oldValue: person.status, newValue: null }], context);
    throw new PersonnelError('referenced_by_business', '人员档案仍被业务或任职历史引用，不能物理删除', { conflictRef: personId });
  }
  db.transaction((tx) => {
    tx.deletePerson(personId);
  });
}

export function getLifecycleDetail(db: PersonnelDatabase, personId: string): PersonDetail {
  const person = db.findPersonById(personId);
  if (person === null) throw new PersonnelError('not_found', `人员档案 ${personId} 不存在`);
  const current = db.listAssignmentsByPerson(personId).find((assignment) => assignment.status === 'current') ?? null;
  return personDetailFromRows(person, current);
}
