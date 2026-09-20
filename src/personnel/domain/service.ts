/**
 * createPerson 用例（T-04 / F1 / R2），并保留 F3 基础信息变更 updatePerson。
 *
 * S-1 自足实现：仅依赖契约（contract/dto.ts、contract/errors.ts）、入参校验
 * （domain/validation.ts）与仓储端口（domain/store.ts），供 `node --test` 在
 * 进程内运行；不导入 persistence/schema.ts（Drizzle/PG 侧由宿主 deferred 验证）。
 *
 * createPerson：校验通过后在同一事务内写入 person（置在职 active）与首条任职
 * 区间（status=current）；任一步失败整体回滚（F1/R2）。工号唯一（R1）、任职
 * 外键（FK ON DELETE RESTRICT 语义）、自引用禁止与部分唯一索引由内存仓储的
 * 约束镜像守护；汇报链环路检测与区间重叠的完整领域规则按 tasks.md 属
 * T-09/T-11/T-12（S-3/S-4）接入，EXCLUDE 排他约束按 ADR-003 待 PG 能力确认后追加。
 */

import {
  CONTACT_INFO_FIELDS,
  EMPLOYMENT_TYPES,
  PERSON_UPDATE_REQUEST_FIELDS,
  type Assignment,
  type PersonCreateRequest,
  type PersonDetail,
  type PersonUpdateRequest,
} from '../contract/dto.ts';
import { PersonnelError, type FieldError } from '../contract/errors.ts';
import { isIsoCalendarDate, validatePersonCreate, type ValidationOutcome } from './validation.ts';
import type {
  AssignmentRow,
  ChangeRecordRow,
  PersonnelDatabase,
  PersonnelTransaction,
  PersonRow,
} from './store.ts';

/** 用例上下文：操作人（审计）、可注入时钟与 id 工厂（node 测试使用桩件）。 */
export interface PersonnelContext {
  operatorId?: string;
  operatorName?: string | null;
  clock?: () => string;
  idFactory?: () => string;
}

export type CreatePersonContext = PersonnelContext;

function defaultUuid(): string {
  return globalThis.crypto.randomUUID();
}

function operatorIdOf(context: PersonnelContext): string {
  return context.operatorId !== undefined && context.operatorId !== '' ? context.operatorId : 'personnel-service';
}

interface FieldChange {
  action: ChangeRecordRow['action'];
  fieldName: string;
  oldValue?: string | null;
  newValue?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

/** 与业务写同一事务追加 change_record（R7 字段级历史）。 */
function recordChanges(
  tx: PersonnelTransaction,
  personId: string,
  changes: FieldChange[],
  context: PersonnelContext,
): void {
  const nextId = context.idFactory ?? defaultUuid;
  const occurredAt = (context.clock ?? (() => new Date().toISOString()))();
  for (const change of changes) {
    const row: ChangeRecordRow = {
      id: nextId(),
      person_id: personId,
      action: change.action,
      field_name: change.fieldName,
      old_value: change.oldValue ?? null,
      new_value: change.newValue ?? null,
      operator_id: operatorIdOf(context),
      operator_name: context.operatorName ?? null,
      occurred_at: occurredAt,
      effective_from: change.effectiveFrom ?? null,
      effective_to: change.effectiveTo ?? null,
    };
    tx.insertChangeRecord(row);
  }
}

function assignmentFromRow(row: AssignmentRow): Assignment {
  const assignment: Assignment = {
    assignmentId: row.id,
    personId: row.person_id,
    departmentId: row.department_id,
    departmentName: row.department_name,
    positionName: row.position_name,
    effectiveFrom: row.effective_from,
    status: row.status,
  };
  if (row.position_id !== null) assignment.positionId = row.position_id;
  assignment.reportsToPersonId = row.reports_to_person_id;
  assignment.effectiveTo = row.effective_to;
  return assignment;
}

/** 行 → 契约 PersonDetail（字段仅取白名单，不含敏感字段）。 */
export function personDetailFromRows(person: PersonRow, currentAssignment: AssignmentRow | null): PersonDetail {
  const detail: PersonDetail = {
    personId: person.id,
    employeeNo: person.employee_no,
    fullName: person.full_name,
    employmentType: person.employment_type,
    employmentStartDate: person.employment_start_date,
    employmentEndDate: person.employment_end_date,
    status: person.status,
    deactivationReason: person.deactivation_reason,
    currentAssignment: currentAssignment === null ? null : assignmentFromRow(currentAssignment),
    createdAt: person.created_at,
    updatedAt: person.updated_at,
  };
  if (person.mobile !== null || person.email !== null) {
    detail.contact = { mobile: person.mobile, email: person.email };
  }
  return detail;
}

/**
 * F1 建档：校验 → 同一事务写 person（在职 active）与首条任职区间（current）。
 * 失败语义：
 * - 校验失败抛 validation_failed（含逐条中文 fieldErrors，R6/AC-001）；
 * - 工号冲突由仓储唯一约束抛 duplicate_employee_no（conflictRef=被占用工号，R1）；
 * - 事务内任一步失败（含外键/ CHECK 违例与审计追加失败）整体回滚（R2/F1），
 *   仓储中不残留任何半写行。
 */
export function createPerson(
  db: PersonnelDatabase,
  input: unknown,
  context: CreatePersonContext = {},
): PersonDetail {
  const outcome: ValidationOutcome = validatePersonCreate(input);
  if (!outcome.ok) {
    throw PersonnelError.validationFailed(outcome.message, outcome.fieldErrors);
  }
  const request: PersonCreateRequest = outcome.value;

  const nextId = context.idFactory ?? defaultUuid;
  const now = (context.clock ?? (() => new Date().toISOString()))();

  return db.transaction((tx: PersonnelTransaction): PersonDetail => {
    const personRow: PersonRow = {
      id: nextId(),
      employee_no: request.employeeNo,
      full_name: request.fullName,
      mobile: request.contact?.mobile ?? null,
      email: request.contact?.email ?? null,
      employment_type: request.employmentType,
      employment_start_date: request.employmentStartDate,
      employment_end_date: request.employmentEndDate ?? null,
      // F1 成功即进入在职（R2：draft → active）
      status: 'active',
      deactivated_on: null,
      deactivation_reason: null,
      created_at: now,
      updated_at: now,
    };
    // employee_no 全表唯一（R1/AC-002）由仓储镜像约束拒绝：duplicate_employee_no
    tx.insertPerson(personRow);

    const assignmentRow: AssignmentRow = {
      id: nextId(),
      person_id: personRow.id,
      department_id: request.departmentId,
      department_name: request.departmentName,
      position_id: request.positionId ?? null,
      position_name: request.positionName,
      reports_to_person_id: request.reportsToPersonId ?? null,
      effective_from: request.effectiveFrom,
      effective_to: null,
      status: 'current',
      created_at: now,
      updated_at: now,
    };
    // FK（reports_to_person_id → person，ON DELETE RESTRICT 语义）与自引用 CHECK
    // 在父档案不存在/非法时抛错并触发整体回滚（R4 的完整规则由 S-4 接入）
    tx.insertAssignment(assignmentRow);

    recordChanges(
      tx,
      personRow.id,
      [
        { action: 'create', fieldName: 'person', newValue: 'active' },
        { action: 'assignment_change', fieldName: 'departmentId', newValue: assignmentRow.department_id, effectiveFrom: assignmentRow.effective_from },
        { action: 'assignment_change', fieldName: 'departmentName', newValue: assignmentRow.department_name, effectiveFrom: assignmentRow.effective_from },
        { action: 'assignment_change', fieldName: 'positionId', newValue: assignmentRow.position_id, effectiveFrom: assignmentRow.effective_from },
        { action: 'assignment_change', fieldName: 'positionName', newValue: assignmentRow.position_name, effectiveFrom: assignmentRow.effective_from },
        { action: 'assignment_change', fieldName: 'reportsToPersonId', newValue: assignmentRow.reports_to_person_id, effectiveFrom: assignmentRow.effective_from },
      ],
      context,
    );

    return personDetailFromRows(personRow, assignmentRow);
  });
}

function parsePersonUpdate(input: unknown): PersonUpdateRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw PersonnelError.validationFailed('人员变更请求必须是 JSON 对象', [
      { field: 'request', message: '人员变更请求必须是 JSON 对象' },
    ]);
  }
  const source = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const field of Object.keys(source)) {
    if (!(PERSON_UPDATE_REQUEST_FIELDS as readonly string[]).includes(field)) {
      errors.push({ field, message: `字段（${field}）不在 PersonUpdateRequest 白名单内，组织/岗位与汇报关系请通过任职变更接口修改` });
    }
  }
  if (Object.keys(source).length === 0) errors.push({ field: 'request', message: '至少需要提交一个可变更字段' });

  const update: PersonUpdateRequest = {};
  const fullName = source.fullName;
  if (fullName !== undefined) {
    if (typeof fullName !== 'string' || fullName.trim() === '' || fullName.length > 64) {
      errors.push({ field: 'fullName', message: '姓名（fullName）必须是 1–64 个字符的非空字符串' });
    } else update.fullName = fullName;
  }
  const employmentType = source.employmentType;
  if (employmentType !== undefined) {
    if (typeof employmentType !== 'string' || !(EMPLOYMENT_TYPES as readonly string[]).includes(employmentType)) {
      errors.push({ field: 'employmentType', message: `雇佣类型（employmentType）必须是 ${EMPLOYMENT_TYPES.join('、')} 之一` });
    } else update.employmentType = employmentType as PersonUpdateRequest['employmentType'];
  }
  for (const field of ['employmentStartDate', 'employmentEndDate'] as const) {
    const value = source[field];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== 'string' || !isIsoCalendarDate(value))) {
      errors.push({ field, message: `${field} 必须是 YYYY-MM-DD 格式的有效日期或 null` });
    } else if (field === 'employmentStartDate') update.employmentStartDate = value as string;
    else update.employmentEndDate = value as string | null;
  }
  const contact = source.contact;
  if (contact !== undefined) {
    if (contact === null || typeof contact !== 'object' || Array.isArray(contact)) {
      errors.push({ field: 'contact', message: '联系方式（contact）必须是对象' });
    } else {
      const raw = contact as Record<string, unknown>;
      for (const key of Object.keys(raw)) {
        if (!(CONTACT_INFO_FIELDS as readonly string[]).includes(key)) {
          errors.push({ field: `contact.${key}`, message: `联系方式字段（contact.${key}）不在契约允许范围内` });
        }
      }
      const nextContact: NonNullable<PersonUpdateRequest['contact']> = {};
      for (const field of CONTACT_INFO_FIELDS) {
        const value = raw[field];
        if (value === undefined || value === null) {
          if (value === null) nextContact[field] = null;
        } else if (
          typeof value !== 'string' ||
          (field === 'mobile' && value.length > 32) ||
          (field === 'email' && !/^\S+@\S+\.\S+$/.test(value))
        ) {
          errors.push({ field: `contact.${field}`, message: `联系方式字段（contact.${field}）格式不正确` });
        } else nextContact[field] = value;
      }
      update.contact = nextContact;
    }
  }
  if (errors.length > 0) throw PersonnelError.validationFailed('人员变更请求校验未通过（R6）', errors);
  return update;
}

function currentAssignment(tx: PersonnelTransaction, personId: string): AssignmentRow | null {
  return (
    tx
      .listAssignmentsByPerson(personId)
      .filter((assignment) => assignment.status === 'current')
      .sort((left, right) => right.effective_from.localeCompare(left.effective_from))[0] ?? null
  );
}

/** F3 基础与雇佣信息变更（仅 PersonUpdateRequest 白名单字段）；同事务追加字段级历史。 */
export function updatePerson(
  db: PersonnelDatabase,
  personId: string,
  input: unknown,
  context: PersonnelContext = {},
): PersonDetail {
  const request = parsePersonUpdate(input);
  const now = (context.clock ?? (() => new Date().toISOString()))();
  return db.transaction((tx) => {
    const person = tx.findPersonById(personId);
    if (person === null) throw new PersonnelError('not_found', `人员档案 ${personId} 不存在`);
    const next: PersonRow = {
      ...person,
      full_name: request.fullName ?? person.full_name,
      mobile:
        request.contact === undefined || request.contact.mobile === undefined
          ? person.mobile
          : request.contact.mobile,
      email:
        request.contact === undefined || request.contact.email === undefined
          ? person.email
          : request.contact.email,
      employment_type: request.employmentType ?? person.employment_type,
      employment_start_date: request.employmentStartDate ?? person.employment_start_date,
      employment_end_date:
        request.employmentEndDate === undefined ? person.employment_end_date : request.employmentEndDate,
      updated_at: now,
    };
    if (next.employment_end_date !== null && next.employment_end_date < next.employment_start_date) {
      throw PersonnelError.validationFailed('雇佣结束日期不得早于开始日期（R6）', [
        { field: 'employmentEndDate', message: '雇佣结束日期不得早于开始日期' },
      ]);
    }
    tx.updatePerson(next);
    const changes: FieldChange[] = [];
    if (person.full_name !== next.full_name) changes.push({ action: 'update', fieldName: 'fullName', oldValue: person.full_name, newValue: next.full_name });
    if (person.mobile !== next.mobile) changes.push({ action: 'update', fieldName: 'contact.mobile', oldValue: person.mobile, newValue: next.mobile });
    if (person.email !== next.email) changes.push({ action: 'update', fieldName: 'contact.email', oldValue: person.email, newValue: next.email });
    if (person.employment_type !== next.employment_type) changes.push({ action: 'update', fieldName: 'employmentType', oldValue: person.employment_type, newValue: next.employment_type });
    if (person.employment_start_date !== next.employment_start_date) changes.push({ action: 'update', fieldName: 'employmentStartDate', oldValue: person.employment_start_date, newValue: next.employment_start_date });
    if (person.employment_end_date !== next.employment_end_date) changes.push({ action: 'update', fieldName: 'employmentEndDate', oldValue: person.employment_end_date, newValue: next.employment_end_date });
    recordChanges(tx, personId, changes, context);
    return personDetailFromRows(next, currentAssignment(tx, personId));
  });
}
