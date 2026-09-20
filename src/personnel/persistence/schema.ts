/**
 * Drizzle schema：person / assignment / change_record 三表（T-03，change_record 结构为 T-15 预留）。
 *
 * 列与 `migrations/0001_personnel_person.sql`、`migrations/0002_personnel_assignment.sql` 的 DDL、
 * src/personnel/domain/store.ts 的 PERSON_COLUMNS / ASSIGNMENT_COLUMNS 以及契约 DTO 白名单
 * （src/personnel/contract/dto.ts）一一对应；按 Q4/AC-009 不含证件号、薪酬、银行账户列。
 * 全部外键 ON DELETE RESTRICT，无级联物理删除（AC-007）。
 *
 * 已知差异（不静默，供宿主收口）：M1/M2 的 DDL 目前只落 `UQ_person_employee_no` 与两条
 * RESTRICT 外键；本文件声明的 CHECK（status 枚举、停用原因必填与长度、字段长度、日期先后、
 * R4 禁自引用）与部分唯一/检索索引尚未写入迁移文件。迁移 SQL 属宿主控制：developer 角色对
 * migrations/*.sql 的写入被宿主拒绝并提示走迁移审批流程，因此这些约束当前由本文件的 schema
 * 声明与 src/personnel/domain/store.ts 的内存镜像共同守护，需宿主以 drizzle-kit 流程重生成
 * M1/M2 后在 PG 实测（PG 约束实测本身也是 test-plan 的 deferred 项）。
 * 待写入迁移的约束名清单（由 test/personnel-validation.test.mjs 逐名核对，不遗漏）：
 * ck_person_employee_no_length、ck_person_full_name_length、ck_person_mobile_length、
 * ck_person_employment_type、ck_person_status、ck_person_employment_dates、
 * ck_person_deactivation_reason_required、ck_person_deactivation_reason_length、
 * idx_person_roster_status_created、idx_person_full_name、ck_assignment_department_id_length、
 * ck_assignment_department_name_required、ck_assignment_position_name_required、
 * ck_assignment_status、ck_assignment_effective_dates、ck_assignment_no_self_report、
 * idx_assignment_person_effective_from、uq_assignment_person_effective_from、
 * idx_assignment_reports_to_person、idx_assignment_department_id；
 * 另含 change_record 两项（ck_change_record_action、idx_change_record_person_occurred_at），
 * 随 M3（T-15 的仅追加迁移）落地。
 *
 * 边界：本文件仅供 PG 侧构建使用，`node --test` 的 personnel-validation 不导入它
 * （沙箱内 drizzle-orm 未安装，安装属宿主 deferred 项）；迁移未被执行、依赖未被安装。
 * 任职区间 EXCLUDE 排他约束按 ADR-003 待 PG 能力确认后随后续仅向前迁移追加。
 */

import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import {
  ASSIGNMENT_STATUSES,
  EMPLOYMENT_TYPES,
  PERSON_STATUSES,
  type AssignmentStatus,
  type EmploymentType,
  type PersonStatus,
} from '../contract/dto.ts';

const CHANGE_RECORD_ACTIONS = [
  'create',
  'update',
  'assignment_change',
  'assignment_retract',
  'status_change',
  'delete_attempt',
] as const;

/** person 主档案：仅基础与雇佣信息（Q4 / AC-009）。 */
export const personTable = pgTable(
  'person',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // R1 / AC-002：employee_no 全表唯一且停用后不复用（M1 的 UQ_person_employee_no）。
    employeeNo: text('employee_no').notNull().unique('UQ_person_employee_no'),
    fullName: text('full_name').notNull(),
    mobile: text('mobile'),
    email: text('email'),
    employmentType: text('employment_type').$type<EmploymentType>().notNull(),
    employmentStartDate: date('employment_start_date').notNull(),
    employmentEndDate: date('employment_end_date'),
    status: text('status').$type<PersonStatus>().notNull().default('draft'),
    deactivatedOn: date('deactivated_on'),
    deactivationReason: text('deactivation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    check('ck_person_employee_no_length', sql`char_length(${t.employeeNo}) between 1 and 32`),
    check('ck_person_full_name_length', sql`char_length(${t.fullName}) between 1 and 64`),
    check('ck_person_mobile_length', sql`${t.mobile} is null or char_length(${t.mobile}) <= 32`),
    check(
      'ck_person_employment_type',
      sql`${t.employmentType} in (${sql.join(
        EMPLOYMENT_TYPES.map((value) => sql`${value}`),
        sql`, `,
      )})`,
    ),
    // R2 状态枚举 CHECK（draft / active / inactive）
    check(
      'ck_person_status',
      sql`${t.status} in (${sql.join(PERSON_STATUSES.map((value) => sql`${value}`), sql`, `)})`,
    ),
    check(
      'ck_person_employment_dates',
      sql`${t.employmentEndDate} is null or ${t.employmentEndDate} >= ${t.employmentStartDate}`,
    ),
    // F4 停用原因 CHECK：inactive 必须有原因，且长度 ≤200
    check('ck_person_deactivation_reason_required', sql`${t.status} <> 'inactive' or ${t.deactivationReason} is not null`),
    check(
      'ck_person_deactivation_reason_length',
      sql`${t.deactivationReason} is null or char_length(${t.deactivationReason}) <= 200`,
    ),
    index('idx_person_roster_status_created')
      .on(t.status, sql`${t.createdAt} desc`)
      .where(sql`${t.status} = 'active'`),
    index('idx_person_full_name').on(t.fullName),
  ],
);

/** assignment：部门/岗位/汇报关系的任职区间（R3/R5）。 */
export const assignmentTable = pgTable(
  'assignment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => personTable.id, { onDelete: 'restrict', onUpdate: 'no action' }),
    departmentId: text('department_id').notNull(),
    departmentName: text('department_name').notNull(),
    positionId: text('position_id'),
    positionName: text('position_name').notNull(),
    reportsToPersonId: uuid('reports_to_person_id').references(() => personTable.id, {
      onDelete: 'restrict',
      onUpdate: 'no action',
    }),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    status: text('status').$type<AssignmentStatus>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    check('ck_assignment_department_id_length', sql`char_length(${t.departmentId}) between 1 and 64`),
    check('ck_assignment_department_name_required', sql`${t.departmentName} <> ''`),
    check('ck_assignment_position_name_required', sql`${t.positionName} <> ''`),
    check(
      'ck_assignment_status',
      sql`${t.status} in (${sql.join(
        ASSIGNMENT_STATUSES.map((value) => sql`${value}`),
        sql`, `,
      )})`,
    ),
    check('ck_assignment_effective_dates', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    // R4 禁自引用（汇报链无环由 domain 层递归校验强制）
    check('ck_assignment_no_self_report', sql`${t.reportsToPersonId} is null or ${t.reportsToPersonId} <> ${t.personId}`),
    index('idx_assignment_person_effective_from').on(t.personId, t.effectiveFrom),
    uniqueIndex('uq_assignment_person_effective_from')
      .on(t.personId, t.effectiveFrom)
      .where(sql`${t.status} <> 'retracted'`),
    index('idx_assignment_reports_to_person').on(t.reportsToPersonId),
    index('idx_assignment_department_id').on(t.departmentId),
    // ADR-003：EXCLUDE USING gist (person_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
    // WHERE status <> 'retracted' —— 依赖 btree_gist，待 PG 能力确认后随后续迁移追加。
  ],
);

/** change_record：字段级历史与审计的追加写表（列与 ChangeRecord DTO 对应；仓储在 T-15 接入）。 */
export const changeRecordTable = pgTable(
  'change_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => personTable.id, { onDelete: 'restrict', onUpdate: 'no action' }),
    action: text('action').$type<(typeof CHANGE_RECORD_ACTIONS)[number]>().notNull(),
    fieldName: text('field_name').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    operatorId: text('operator_id').notNull(),
    operatorName: text('operator_name'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),
  },
  (t) => [
    // 以下两项随 M3（T-15 的 change_record 仅追加迁移）落地，已登记入待迁移清单。
    check(
      'ck_change_record_action',
      sql`${t.action} in (${sql.join(
        CHANGE_RECORD_ACTIONS.map((value) => sql`${value}`),
        sql`, `,
      )})`,
    ),
    index('idx_change_record_person_occurred_at').on(t.personId, sql`${t.occurredAt} desc`),
  ],
);

export type PersonRecord = typeof personTable.$inferSelect;
export type AssignmentRecord = typeof assignmentTable.$inferSelect;
export type ChangeRecordRecord = typeof changeRecordTable.$inferSelect;
