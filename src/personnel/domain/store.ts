/**
 * 人员仓储端口 + 可回滚内存仓储（T-03）。
 *
 * 行结构（snake_case）与 `migrations/0001_personnel_person.sql`、
 * `migrations/0002_personnel_assignment.sql` 的列、src/personnel/persistence/schema.ts 的
 * Drizzle schema 及契约 DTO 白名单（src/personnel/contract/dto.ts）一一对应；
 * ChangeRecordRow 的列与 T-15 计划的 M3（change_record）对应。
 *
 * 内存实现镜像 PostgreSQL 语义供 `node --test` 使用（不连库、不执行迁移）：
 * - employee_no 全表唯一（R1）；
 * - status / 停用原因 / 日期先后 / 长度 CHECK 镜像；
 * - assignment 对 person 的外键（ON DELETE RESTRICT 语义：父不存在即拒绝，删父有引用即拒绝）；
 * - transaction() 同步快照回滚：事务内任一步抛错，全部写入撤销（F1/R2）。
 * 任职区间 EXCLUDE 排他约束按 ADR-003 待 PG 能力确认后在迁移追加；
 * 在其落地前，区间重叠（R3）由本文件的内存规则与 domain 层校验守护。
 */

import {
  ASSIGNMENT_STATUSES,
  EMPLOYMENT_TYPES,
  PERSON_STATUSES,
  type AssignmentStatus,
  type EmploymentType,
  type PersonStatus,
} from '../contract/dto.ts';
import { PersonnelError } from '../contract/errors.ts';

/** person 表列（与迁移 M1 一一对应）。 */
export const PERSON_COLUMNS = [
  'id',
  'employee_no',
  'full_name',
  'mobile',
  'email',
  'employment_type',
  'employment_start_date',
  'employment_end_date',
  'status',
  'deactivated_on',
  'deactivation_reason',
  'created_at',
  'updated_at',
] as const;

/** assignment 表列（与迁移 M2 一一对应）。 */
export const ASSIGNMENT_COLUMNS = [
  'id',
  'person_id',
  'department_id',
  'department_name',
  'position_id',
  'position_name',
  'reports_to_person_id',
  'effective_from',
  'effective_to',
  'status',
  'created_at',
  'updated_at',
] as const;

/** change_record 表列（M3 属 T-15；此处仅定义列集合与内存追加写语义）。 */
export const CHANGE_RECORD_COLUMNS = [
  'id',
  'person_id',
  'action',
  'field_name',
  'old_value',
  'new_value',
  'operator_id',
  'operator_name',
  'occurred_at',
  'effective_from',
  'effective_to',
] as const;

export interface PersonRow {
  id: string;
  employee_no: string;
  full_name: string;
  mobile: string | null;
  email: string | null;
  employment_type: EmploymentType;
  employment_start_date: string;
  employment_end_date: string | null;
  status: PersonStatus;
  deactivated_on: string | null;
  deactivation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssignmentRow {
  id: string;
  person_id: string;
  department_id: string;
  department_name: string;
  position_id: string | null;
  position_name: string;
  reports_to_person_id: string | null;
  effective_from: string;
  effective_to: string | null;
  status: AssignmentStatus;
  created_at: string;
  updated_at: string;
}

export interface ChangeRecordRow {
  id: string;
  person_id: string;
  action: 'create' | 'update' | 'assignment_change' | 'assignment_retract' | 'status_change' | 'delete_attempt';
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  operator_id: string;
  operator_name: string | null;
  occurred_at: string;
  effective_from: string | null;
  effective_to: string | null;
}

/** 事务句柄上的读写操作。 */
export interface PersonnelTransaction {
  insertPerson(row: PersonRow): void;
  insertAssignment(row: AssignmentRow): void;
  updatePerson(row: PersonRow): void;
  updateAssignment(row: AssignmentRow): void;
  insertChangeRecord(row: ChangeRecordRow): void;
  deletePerson(id: string): void;
  findPersonById(id: string): PersonRow | null;
  findPersonByEmployeeNo(employeeNo: string): PersonRow | null;
  findAssignmentById(id: string): AssignmentRow | null;
  listPersons(): PersonRow[];
  listAssignmentsByPerson(personId: string): AssignmentRow[];
  listAssignments(): AssignmentRow[];
  listChangeRecords(personId: string): ChangeRecordRow[];
  countPersons(): number;
  countAssignments(): number;
}

/** 仓储端口：用例只依赖该接口，便于替换为 Drizzle/PG 实现。 */
export interface PersonnelDatabase extends PersonnelTransaction {
  transaction<T>(fn: (tx: PersonnelTransaction) => T): T;
}

function constraintFailed(message: string, conflictRef: string | null = null): PersonnelError {
  return new PersonnelError('conflict', message, { conflictRef });
}

/** 校验 person 行以镜像 M1 的 NOT NULL / UNIQUE / CHECK 约束。 */
function assertPersonRow(row: PersonRow): void {
  if (row.id === '') throw constraintFailed('违反非空约束：person.id');
  if (row.employee_no.length < 1 || row.employee_no.length > 32) {
    throw constraintFailed(`违反 CHECK：person.employee_no 长度须在 1–32（当前 ${row.employee_no.length}）`);
  }
  if (row.full_name.length < 1 || row.full_name.length > 64) {
    throw constraintFailed(`违反 CHECK：person.full_name 长度须在 1–64（当前 ${row.full_name.length}）`);
  }
  if (row.mobile !== null && row.mobile.length > 32) {
    throw constraintFailed('违反 CHECK：person.mobile 长度不能超过 32');
  }
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(row.employment_type)) {
    throw constraintFailed(`违反 CHECK：person.employment_type「${row.employment_type}」不在枚举内`);
  }
  if (!(PERSON_STATUSES as readonly string[]).includes(row.status)) {
    throw constraintFailed(`违反 CHECK：person.status「${row.status}」不在枚举内（draft/active/inactive）`);
  }
  if (row.employment_end_date !== null && row.employment_end_date < row.employment_start_date) {
    throw constraintFailed('违反 CHECK：person.employment_end_date 不得早于 employment_start_date');
  }
  if (row.status === 'inactive' && (row.deactivation_reason === null || row.deactivation_reason === '')) {
    throw constraintFailed('违反 CHECK：停用（inactive）档案必须记录 deactivation_reason');
  }
  if (row.deactivation_reason !== null && row.deactivation_reason.length > 200) {
    throw constraintFailed('违反 CHECK：person.deactivation_reason 长度不能超过 200');
  }
}

/** 校验 assignment 行以镜像 M2 的 NOT NULL / CHECK 约束。 */
function assertAssignmentRow(row: AssignmentRow): void {
  if (row.id === '') throw constraintFailed('违反非空约束：assignment.id');
  if (row.department_id.length < 1 || row.department_id.length > 64) {
    throw constraintFailed(`违反 CHECK：assignment.department_id 长度须在 1–64（当前 ${row.department_id.length}）`);
  }
  if (row.department_name === '') throw constraintFailed('违反非空约束：assignment.department_name');
  if (row.position_name === '') throw constraintFailed('违反非空约束：assignment.position_name');
  if (!(ASSIGNMENT_STATUSES as readonly string[]).includes(row.status)) {
    throw constraintFailed(`违反 CHECK：assignment.status「${row.status}」不在枚举内（pending/current/closed/retracted）`);
  }
  if (row.effective_to !== null && row.effective_to < row.effective_from) {
    throw constraintFailed('违反 CHECK：assignment.effective_to 不得早于 effective_from');
  }
  if (row.reports_to_person_id !== null && row.reports_to_person_id === row.person_id) {
    throw constraintFailed('违反 CHECK：assignment 汇报上级不得为本人（R4 禁自引用）');
  }
}

/** 校验 change_record 行以镜像 M3 的 NOT NULL / CHECK 约束（R7 追加写）。 */
function assertChangeRecordRow(row: ChangeRecordRow): void {
  if (row.id === '' || row.person_id === '' || row.field_name === '' || row.operator_id === '') {
    throw constraintFailed('违反非空约束：change_record.id / person_id / field_name / operator_id');
  }
  const actions = ['create', 'update', 'assignment_change', 'assignment_retract', 'status_change', 'delete_attempt'];
  if (!actions.includes(row.action)) {
    throw constraintFailed(`违反 CHECK：change_record.action「${row.action}」不在枚举内`);
  }
}

/**
 * 可回滚内存仓储：`transaction` 以快照实现原子性，
 * 任一步抛错即整体回滚并原样重抛（F1/R2 的 node 测试基座）。
 */
export class InMemoryPersonnelStore implements PersonnelDatabase {
  #persons: PersonRow[] = [];
  #assignments: AssignmentRow[] = [];
  #changeRecords: ChangeRecordRow[] = [];

  transaction<T>(fn: (tx: PersonnelTransaction) => T): T {
    const personSnapshot = this.#persons.map((row) => ({ ...row }));
    const assignmentSnapshot = this.#assignments.map((row) => ({ ...row }));
    const changeRecordSnapshot = this.#changeRecords.map((row) => ({ ...row }));
    try {
      return fn(this);
    } catch (error) {
      this.#persons = personSnapshot;
      this.#assignments = assignmentSnapshot;
      this.#changeRecords = changeRecordSnapshot;
      throw error;
    }
  }

  insertPerson(row: PersonRow): void {
    assertPersonRow(row);
    if (this.#persons.some((p) => p.employee_no === row.employee_no)) {
      throw PersonnelError.duplicateEmployeeNo(row.employee_no);
    }
    if (this.#persons.some((p) => p.id === row.id)) {
      throw constraintFailed(`违反主键约束：person.id ${row.id} 已存在`, row.id);
    }
    this.#persons.push({ ...row });
  }

  insertAssignment(row: AssignmentRow): void {
    assertAssignmentRow(row);
    // FK person_id → person.id（ON DELETE RESTRICT：父不存在即拒绝写入）
    if (!this.#persons.some((p) => p.id === row.person_id)) {
      throw constraintFailed(
        `违反外键约束：assignment.person_id ${row.person_id} 在 person 中不存在（FK ON DELETE RESTRICT）`,
        row.person_id,
      );
    }
    if (row.reports_to_person_id !== null && !this.#persons.some((p) => p.id === row.reports_to_person_id)) {
      throw constraintFailed(
        `违反外键约束：assignment.reports_to_person_id ${row.reports_to_person_id} 在 person 中不存在`,
        row.reports_to_person_id,
      );
    }
    if (this.#assignments.some((a) => a.id === row.id)) {
      throw constraintFailed(`违反主键约束：assignment.id ${row.id} 已存在`, row.id);
    }
    // 部分唯一索引 uq_assignment_person_effective_from（status <> 'retracted'）
    if (
      row.status !== 'retracted' &&
      this.#assignments.some(
        (a) => a.status !== 'retracted' && a.person_id === row.person_id && a.effective_from === row.effective_from,
      )
    ) {
      throw constraintFailed(`违反 UNIQUE：同一人员在 ${row.effective_from} 已存在非撤销任职区间`, row.person_id);
    }
    // ADR-003 的 EXCLUDE 尚未在迁移落地：此处按 [from, to) 语义内存镜像 R3 区间不重叠
    if (row.status !== 'retracted') {
      const overlap = this.#assignments.find(
        (a) =>
          a.status !== 'retracted' &&
          a.person_id === row.person_id &&
          !(row.status === 'pending' && a.status === 'current' && a.effective_to === null && a.effective_from < row.effective_from) &&
          (a.effective_to === null || row.effective_from < a.effective_to) &&
          (row.effective_to === null || (a.effective_to !== null && a.effective_from < row.effective_to)),
      );
      if (overlap !== undefined) {
        throw new PersonnelError(
          'overlapping_assignment',
          `任职区间与既有区间 ${overlap.id}（${overlap.effective_from} 至 ${overlap.effective_to ?? '未定'}）重叠（R3）`,
          { conflictRef: overlap.id },
        );
      }
    }
    this.#assignments.push({ ...row });
  }

  updatePerson(row: PersonRow): void {
    assertPersonRow(row);
    const index = this.#persons.findIndex((person) => person.id === row.id);
    if (index < 0) throw new PersonnelError('not_found', `人员档案 ${row.id} 不存在`);
    if (this.#persons.some((person) => person.id !== row.id && person.employee_no === row.employee_no)) {
      throw PersonnelError.duplicateEmployeeNo(row.employee_no);
    }
    this.#persons[index] = { ...row };
  }

  updateAssignment(row: AssignmentRow): void {
    assertAssignmentRow(row);
    const index = this.#assignments.findIndex((assignment) => assignment.id === row.id);
    if (index < 0) throw new PersonnelError('not_found', `任职记录 ${row.id} 不存在`);
    if (!this.#persons.some((person) => person.id === row.person_id)) {
      throw constraintFailed(`违反外键约束：assignment.person_id ${row.person_id} 在 person 中不存在`, row.person_id);
    }
    if (row.reports_to_person_id !== null && !this.#persons.some((person) => person.id === row.reports_to_person_id)) {
      throw constraintFailed(
        `违反外键约束：assignment.reports_to_person_id ${row.reports_to_person_id} 在 person 中不存在`,
        row.reports_to_person_id,
      );
    }
    const conflicting = this.#assignments.some(
      (assignment) =>
        assignment.id !== row.id &&
        assignment.status !== 'retracted' &&
        row.status !== 'retracted' &&
        assignment.person_id === row.person_id &&
        assignment.effective_from === row.effective_from,
    );
    if (conflicting) throw constraintFailed(`违反 UNIQUE：同一人员在 ${row.effective_from} 已存在非撤销任职区间`, row.person_id);
    this.#assignments[index] = { ...row };
  }

  insertChangeRecord(row: ChangeRecordRow): void {
    assertChangeRecordRow(row);
    if (this.#changeRecords.some((record) => record.id === row.id)) {
      throw constraintFailed(`违反主键约束：change_record.id ${row.id} 已存在`, row.id);
    }
    if (!this.#persons.some((person) => person.id === row.person_id)) {
      throw constraintFailed(
        `违反外键约束：change_record.person_id ${row.person_id} 在 person 中不存在`,
        row.person_id,
      );
    }
    this.#changeRecords.push({ ...row });
  }

  deletePerson(id: string): void {
    // FK ON DELETE RESTRICT 兜底：仍被任职/审计引用时不得物理删除（AC-007 守护规则属 T-14）
    if (this.#assignments.some((assignment) => assignment.person_id === id)) {
      throw new PersonnelError('referenced_by_business', `人员 ${id} 仍被任职记录引用，不可物理删除（R2）`, {
        conflictRef: id,
      });
    }
    const index = this.#persons.findIndex((person) => person.id === id);
    if (index < 0) throw new PersonnelError('not_found', `人员档案 ${id} 不存在`);
    this.#persons.splice(index, 1);
  }

  findPersonById(id: string): PersonRow | null {
    const row = this.#persons.find((p) => p.id === id);
    return row === undefined ? null : { ...row };
  }

  findPersonByEmployeeNo(employeeNo: string): PersonRow | null {
    const row = this.#persons.find((p) => p.employee_no === employeeNo);
    return row === undefined ? null : { ...row };
  }

  findAssignmentById(id: string): AssignmentRow | null {
    const row = this.#assignments.find((assignment) => assignment.id === id);
    return row === undefined ? null : { ...row };
  }

  listPersons(): PersonRow[] {
    return this.#persons.map((row) => ({ ...row }));
  }

  listAssignmentsByPerson(personId: string): AssignmentRow[] {
    return this.#assignments.filter((a) => a.person_id === personId).map((row) => ({ ...row }));
  }

  listAssignments(): AssignmentRow[] {
    return this.#assignments.map((row) => ({ ...row }));
  }

  listChangeRecords(personId: string): ChangeRecordRow[] {
    return this.#changeRecords.filter((record) => record.person_id === personId).map((row) => ({ ...row }));
  }

  countPersons(): number {
    return this.#persons.length;
  }

  countAssignments(): number {
    return this.#assignments.length;
  }

  countChangeRecords(personId?: string): number {
    if (personId === undefined) return this.#changeRecords.length;
    return this.#changeRecords.filter((record) => record.person_id === personId).length;
  }
}
