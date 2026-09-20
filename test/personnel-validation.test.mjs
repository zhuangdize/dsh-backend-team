/**
 * personnel-validation 场景测试（T-05，证据 id=personnel-validation，AC-001 / AC-009）。
 * 执行：node --test test/personnel-validation.test.mjs
 *
 * 覆盖 S-1 各任务（进程内 domain + 内存仓储，不连 PostgreSQL、不执行迁移）：
 * - T-01：契约字段白名单（PersonCreateRequest / PersonUpdateRequest / ContactInfo /
 *   PersonDetail / Assignment / ErrorResponse）与 openapi.yaml 逐字段对应，
 *   遍历清单断言不含 idNumber、salary、bankAccount 及常见别名（AC-009）；
 * - T-02：逐项与组合缺省 8 个必填字段 → validation_failed 且 fieldErrors 为逐条中文提示；
 *   长度 1–32/1–64、雇佣类型枚举、日期格式与终止不早于起始、邮箱格式（AC-001/R6）；
 * - T-03：person/assignment 列清单与 M1/M2 DDL 及 DTO 白名单一一对应、无敏感列；
 *   M1 含 employee_no UNIQUE、M2 含两条 FK ON DELETE RESTRICT、M1/M2 为仅向前建表脚本；
 *   status CHECK 与停用原因 CHECK 在 Drizzle schema（persistence/schema.ts）声明并由内存
 *   仓储镜像执行，事务快照回滚；M1/M2 的 DDL 尚未含这些 CHECK——迁移文件属宿主控制，
 *   developer 角色写入被宿主拒绝并要求走迁移审批流程，因此「待迁移追加清单」由本文件
 *   逐名核对（既不静默缺失、也不谎报已落地），PG 约束实测属 test-plan 的 deferred 项；
 *   任职区间 EXCLUDE 排他约束按 ADR-003 待 PG 能力确认后追加（不在本测试范围）。
 * - T-04：createPerson 同一事务写 person（在职 active）与首条任职区间（current），
 *   任一步失败（含审计追加失败）整体回滚（F1/R2/R7），
 *   工号冲突返回 duplicate_employee_no 与 conflictRef（R1）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ASSIGNMENT_FIELDS,
  DTO_FIELD_WHITELISTS,
  EMPLOYMENT_TYPES,
  FORBIDDEN_SENSITIVE_FIELD_NAMES,
  PERSON_CREATE_REQUEST_FIELDS,
  PERSON_CREATE_REQUIRED_FIELDS,
  PERSON_DETAIL_FIELDS,
  PERSON_STATUSES,
  ASSIGNMENT_STATUSES,
  findForbiddenFieldNames,
  isForbiddenSensitiveFieldName,
} from '../src/personnel/contract/dto.ts';
import {
  ERROR_RESPONSE_FIELDS,
  FIELD_ERROR_FIELDS,
  PERSONNEL_ERROR_CODES,
  PersonnelError,
} from '../src/personnel/contract/errors.ts';
import { validatePersonCreate } from '../src/personnel/domain/validation.ts';
import {
  ASSIGNMENT_COLUMNS,
  CHANGE_RECORD_COLUMNS,
  InMemoryPersonnelStore,
  PERSON_COLUMNS,
} from '../src/personnel/domain/store.ts';
import { createPerson } from '../src/personnel/domain/service.ts';

/** 中文可理解提示的最低要求：消息含 CJK 字符（R6）。 */
const CJK = /[\u4e00-\u9fff]/;

const CONTRACT_URL = new URL(
  '../specs/task-8b077f28-2167-45ca-aaa1-e02db241f377/contracts/openapi.yaml',
  import.meta.url,
);
const contractText = readFileSync(CONTRACT_URL, 'utf8');

/** 取 components.schemas.<name> 的原文行区间（4 空格缩进的兄弟键为边界）。 */
function schemaBlockLines(name) {
  const lines = contractText.split('\n');
  const start = lines.indexOf(`    ${name}:`);
  assert.notEqual(start, -1, `openapi.yaml 缺少 components.schemas.${name}`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {4}[A-Za-z][A-Za-z0-9]*:\s*$/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block;
}

/** 契约 schema 的顶层属性名清单（8 空格缩进的键）。 */
function schemaProperties(name) {
  const fields = [];
  for (const line of schemaBlockLines(name)) {
    const match = /^ {8}([A-Za-z][A-Za-z0-9]*):\s*$/.exec(line);
    if (match !== null) fields.push(match[1]);
  }
  assert.ok(fields.length > 0, `契约 schema ${name} 未解析到属性`);
  return fields;
}

/** 契约 schema 的 flow 风格 required / enum 列表。 */
function schemaFlowList(name, key) {
  const line = schemaBlockLines(name).find((entry) => new RegExp(`^ {6}${key}: \\[.*\\]$`).test(entry));
  assert.ok(line !== undefined, `契约 schema ${name} 缺少 ${key} 列表`);
  return line
    .slice(line.indexOf('[') + 1, line.lastIndexOf(']'))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** ErrorResponse.code 的块式 enum 值。 */
function schemaCodeEnum() {
  const lines = schemaBlockLines('ErrorResponse');
  const start = lines.findIndex((entry) => /^ {8}code:\s*$/.test(entry));
  assert.notEqual(start, -1, '契约 ErrorResponse 缺少 code 属性');
  const values = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const item = /^ {12}- ([A-Za-z_]+)\s*$/.exec(lines[i]);
    if (item !== null) {
      values.push(item[1]);
      continue;
    }
    if (values.length > 0 && /^ {8}\S/.test(lines[i])) break;
  }
  assert.ok(values.length > 0, '契约 ErrorResponse.code 未解析到枚举值');
  return values;
}

function migrationText(file) {
  return readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
}

function drizzleSchemaText() {
  return readFileSync(
    new URL('../src/personnel/persistence/schema.ts', import.meta.url),
    'utf8',
  );
}

/** 从 CREATE TABLE DDL 中取列名（跳过 CONSTRAINT 行与注释）。 */
function ddlColumns(sqlText, table) {
  const header = `CREATE TABLE "${table}" (`;
  const start = sqlText.indexOf(header);
  assert.notEqual(start, -1, `迁移缺少 ${header}`);
  const end = sqlText.indexOf('\n);', start);
  assert.notEqual(end, -1, `迁移中 ${table} 的 CREATE TABLE 未闭合`);
  const columns = [];
  for (const line of sqlText.slice(start, end).split('\n')) {
    const match = /^\s*"([a-z_]+)"\s+/.exec(line);
    if (match !== null) columns.push(match[1]);
  }
  return columns;
}

/** 迁移脚本的语句清单（去掉整行注释，按 statement-breakpoint 切分）。 */
function sqlStatements(sqlText) {
  const cleaned = sqlText
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('--') || trimmed.startsWith('-->');
    })
    .join('\n');
  return cleaned
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

/** openapi.yaml 原文中的必填清单（不靠测试内手抄）。 */
const CONTRACT_CREATE_REQUIRED = schemaFlowList('PersonCreateRequest', 'required');

function validInput() {
  return {
    employeeNo: 'EMP-0001',
    fullName: '张三',
    contact: { mobile: '13800000000', email: 'zhangsan@example.com' },
    employmentType: 'full_time',
    employmentStartDate: '2026-01-01',
    departmentId: 'DEPT-TECH',
    departmentName: '研发部',
    positionId: 'POS-BE',
    positionName: '后端工程师',
    effectiveFrom: '2026-01-01',
  };
}

function makeStore() {
  let counter = 0;
  const store = new InMemoryPersonnelStore();
  const context = {
    idFactory: () => `id-${++counter}`,
    clock: () => '2026-09-10T00:00:00.000Z',
  };
  return { store, context };
}

function camel(name) {
  return name.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function personRow(overrides = {}) {
  return {
    id: 'p1',
    employee_no: 'EMP-T1',
    full_name: '王五',
    mobile: null,
    email: null,
    employment_type: 'full_time',
    employment_start_date: '2026-01-01',
    employment_end_date: null,
    status: 'active',
    deactivated_on: null,
    deactivation_reason: null,
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function assignmentRow(overrides = {}) {
  return {
    id: 'a1',
    person_id: 'p1',
    department_id: 'DEPT-TECH',
    department_name: '研发部',
    position_id: null,
    position_name: '后端工程师',
    reports_to_person_id: null,
    effective_from: '2026-01-01',
    effective_to: null,
    status: 'current',
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function changeRecordRow(overrides = {}) {
  return {
    id: 'c1',
    person_id: 'p1',
    action: 'create',
    field_name: 'person',
    old_value: null,
    new_value: 'active',
    operator_id: 'hr-1',
    operator_name: null,
    occurred_at: '2026-09-10T00:00:00.000Z',
    effective_from: null,
    effective_to: null,
    ...overrides,
  };
}

function insertPerson(store, overrides = {}) {
  store.transaction((tx) => tx.insertPerson(personRow(overrides)));
}

// ---------- T-01 契约绑定与字段白名单（AC-001 / AC-009） ----------

test('T-01/AC-001 契约绑定：PersonCreateRequest.required 与实现的必填清单完全一致（8 项）', () => {
  assert.equal(CONTRACT_CREATE_REQUIRED.length, 8);
  assert.deepEqual([...CONTRACT_CREATE_REQUIRED].sort(), [...PERSON_CREATE_REQUIRED_FIELDS].sort());
  for (const field of PERSON_CREATE_REQUIRED_FIELDS) {
    assert.ok(PERSON_CREATE_REQUEST_FIELDS.includes(field), field);
  }
});

test('T-01/AC-009：契约六类 DTO 的顶层属性与实现字段白名单逐一对应', () => {
  const pairs = [
    ['PersonCreateRequest', [...PERSON_CREATE_REQUEST_FIELDS]],
    ['PersonUpdateRequest', [...DTO_FIELD_WHITELISTS.PersonUpdateRequest]],
    ['ContactInfo', [...DTO_FIELD_WHITELISTS.ContactInfo]],
    ['PersonDetail', [...PERSON_DETAIL_FIELDS]],
    ['Assignment', [...ASSIGNMENT_FIELDS]],
    ['ErrorResponse', [...ERROR_RESPONSE_FIELDS]],
  ];
  for (const [schemaName, whitelist] of pairs) {
    assert.deepEqual(schemaProperties(schemaName).sort(), whitelist.sort(), `${schemaName} 字段与契约不一致`);
  }
});

test('T-01/AC-009：契约与实现的全部字段清单均不含证件号/薪酬/银行账户及常见别名', () => {
  const lists = {
    ...DTO_FIELD_WHITELISTS,
    ErrorResponse: ERROR_RESPONSE_FIELDS,
    FieldError: FIELD_ERROR_FIELDS,
  };
  for (const name of ['PersonCreateRequest', 'PersonUpdateRequest', 'ContactInfo', 'PersonDetail', 'Assignment']) {
    assert.ok(Array.isArray(lists[name]) && lists[name].length > 0, `缺少 ${name} 字段清单`);
  }
  for (const [name, fields] of Object.entries(lists)) {
    assert.deepEqual(findForbiddenFieldNames([...fields]), [], `${name} 含敏感字段`);
  }
  for (const name of [
    'PersonCreateRequest',
    'PersonUpdateRequest',
    'ContactInfo',
    'PersonDetail',
    'Assignment',
    'PersonSummary',
    'AssignmentCreateRequest',
    'StatusTransitionRequest',
    'ChangeRecord',
    'ErrorResponse',
  ]) {
    assert.deepEqual(findForbiddenFieldNames(schemaProperties(name)), [], `契约 ${name} 含敏感字段`);
  }
});

test('T-01/AC-009：敏感字段与常见别名（大小写/分隔符/前缀变体）可被识别', () => {
  for (const alias of FORBIDDEN_SENSITIVE_FIELD_NAMES) {
    assert.ok(isForbiddenSensitiveFieldName(alias), alias);
  }
  for (const variant of [
    'id_number',
    'ID-Card Number',
    'identity_number',
    'monthly salary',
    'bank_account',
    'BANK-CARD-NO',
    'salaryInfo',
    'SSN',
    'iban',
  ]) {
    assert.ok(isForbiddenSensitiveFieldName(variant), variant);
  }
});

test('T-01：契约枚举与实现的字符串联合一致（R2/R3 状态、雇佣类型）', () => {
  assert.deepEqual(schemaFlowList('PersonStatus', 'enum'), [...PERSON_STATUSES]);
  assert.deepEqual(schemaFlowList('EmploymentType', 'enum'), [...EMPLOYMENT_TYPES]);
  assert.deepEqual(schemaFlowList('AssignmentStatus', 'enum'), [...ASSIGNMENT_STATUSES]);
  assert.deepEqual(schemaCodeEnum().sort(), [...PERSONNEL_ERROR_CODES].sort());
});

test('T-01：错误结构含 code、中文 message、fieldErrors、conflictRef', () => {
  const error = new PersonnelError('validation_failed', '输入校验未通过', {
    fieldErrors: [{ field: 'employeeNo', message: '工号为必填项' }],
    conflictRef: null,
  });
  const body = error.toErrorResponse();
  assert.deepEqual(Object.keys(body).sort(), [...ERROR_RESPONSE_FIELDS].sort());
  assert.equal(body.code, 'validation_failed');
  assert.equal(body.conflictRef, null);
  assert.deepEqual(body.fieldErrors, [{ field: 'employeeNo', message: '工号为必填项' }]);
  assert.deepEqual(FIELD_ERROR_FIELDS, ['field', 'message']);
});

// ---------- T-02 逐项与组合缺省必填字段（AC-001 / R6） ----------

for (const field of PERSON_CREATE_REQUIRED_FIELDS) {
  test(`T-02/AC-001/R6：缺省必填字段 ${field} → validation_failed 且该字段有逐条中文提示`, () => {
    const input = validInput();
    delete input[field];
    const result = validatePersonCreate(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'validation_failed');
    assert.match(result.message, CJK);
    const hits = result.fieldErrors.filter((e) => e.field === field);
    assert.equal(hits.length, 1);
    assert.match(hits[0].message, CJK);
    assert.deepEqual(Object.keys(hits[0]).sort(), [...FIELD_ERROR_FIELDS].sort());
  });

  test(`T-02/AC-001/R6：必填字段 ${field} 为空白字符串同样被拒绝`, () => {
    const input = { ...validInput(), [field]: '   ' };
    const result = validatePersonCreate(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'validation_failed');
    assert.ok(
      result.fieldErrors.some((e) => e.field === field && CJK.test(e.message)),
      `字段 ${field} 空白应给出中文提示`,
    );
  });
}

test('T-02/AC-001/R6：组合缺省全部 8 个必填字段 → fieldErrors 逐一列出且消息均为中文', () => {
  const input = validInput();
  for (const field of PERSON_CREATE_REQUIRED_FIELDS) delete input[field];
  const result = validatePersonCreate(input);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'validation_failed');
  assert.match(result.message, CJK);
  const flagged = result.fieldErrors.map((e) => e.field).sort();
  assert.deepEqual(flagged, [...CONTRACT_CREATE_REQUIRED].sort());
  for (const error of result.fieldErrors) assert.match(error.message, CJK);
});

test('T-02/R6：长度 1–32/1–64、枚举、日期格式与先后、邮箱格式逐条中文提示', () => {
  const cases = [
    [{ employeeNo: 'E'.repeat(33) }, 'employeeNo'],
    [{ fullName: '名'.repeat(65) }, 'fullName'],
    [{ departmentId: 'D'.repeat(65) }, 'departmentId'],
    [{ departmentName: '部'.repeat(65) }, 'departmentName'],
    [{ positionName: '岗'.repeat(65) }, 'positionName'],
    [{ employmentType: 'freelance' }, 'employmentType'],
    [{ employmentStartDate: 'not-a-date' }, 'employmentStartDate'],
    [{ employmentStartDate: '2026-02-30' }, 'employmentStartDate'],
    [{ effectiveFrom: '2026-13-01' }, 'effectiveFrom'],
    [{ employmentEndDate: '2025-12-31' }, 'employmentEndDate'],
    [{ contact: { email: 'not-an-email' } }, 'contact.email'],
    [{ contact: { mobile: '1'.repeat(33) } }, 'contact.mobile'],
  ];
  for (const [patch, field] of cases) {
    const input = { ...validInput(), ...patch };
    const result = validatePersonCreate(input);
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.code, 'validation_failed');
    const hit = result.fieldErrors.find((e) => e.field === field);
    assert.ok(hit !== undefined, `${field} 应有错误：${JSON.stringify(result.fieldErrors)}`);
    assert.match(hit.message, CJK);
  }
});

test('T-02/R6：边界长度（工号 32、姓名 64）与同日终止通过校验', () => {
  const result = validatePersonCreate({
    ...validInput(),
    employeeNo: 'E'.repeat(32),
    fullName: '名'.repeat(64),
    employmentEndDate: '2026-01-01',
  });
  assert.equal(result.ok, true, JSON.stringify(result.fieldErrors ?? null));
});

test('T-02/AC-009：白名单外字段与非法汇报上级标识被拒绝（中文提示）', () => {
  const result = validatePersonCreate({ ...validInput(), nickname: '小张', reportsToPersonId: 'not-a-uuid' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'validation_failed');
  assert.ok(result.fieldErrors.some((e) => e.field === 'nickname' && CJK.test(e.message)));
  assert.ok(result.fieldErrors.some((e) => e.field === 'reportsToPersonId' && CJK.test(e.message)));
  const nested = validatePersonCreate({ ...validInput(), contact: { email: 'a@b.co', idCard: 'REDACTED-ID-SAMPLE' } });
  assert.equal(nested.ok, false);
  const hit = nested.fieldErrors.find((e) => e.field === 'contact.idCard');
  assert.ok(hit !== undefined);
  assert.match(hit.message, CJK);
});

test('T-01/T-02/AC-009：入参提交敏感字段被显式拒绝并给出中文提示', () => {
  const input = {
    ...validInput(),
    idNumber: 'REDACTED-ID-SAMPLE',
    salary: 'REDACTED-SALARY-SAMPLE',
    bankAccount: 'REDACTED-BANK-ACCOUNT-SAMPLE',
  };
  const result = validatePersonCreate(input);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'validation_failed');
  assert.match(result.message, CJK);
  for (const key of ['idNumber', 'salary', 'bankAccount']) {
    const hit = result.fieldErrors.find((e) => e.field === key);
    assert.ok(hit !== undefined, `应拒绝敏感字段 ${key}`);
    assert.match(hit.message, CJK);
  }
});

test('T-02/R6：合法入参（全部雇佣类型、结束日期不早于开始、合法邮箱）通过校验', () => {
  for (const employmentType of EMPLOYMENT_TYPES) {
    const result = validatePersonCreate({ ...validInput(), employmentType });
    assert.equal(result.ok, true, employmentType);
  }
  const withEnd = validatePersonCreate({ ...validInput(), employmentEndDate: '2026-12-31' });
  assert.equal(withEnd.ok, true);
  assert.equal(withEnd.value.employmentEndDate, '2026-12-31');
  const ok = validatePersonCreate(validInput());
  assert.equal(ok.ok, true);
  assert.equal(ok.value.employeeNo, 'EMP-0001');
  assert.deepEqual(ok.value.contact, { mobile: '13800000000', email: 'zhangsan@example.com' });
});

// ---------- T-03 迁移列 ↔ Drizzle 列 ↔ DTO 白名单，约束镜像与回滚 ----------

test('T-03：M1/M2 的 DDL 列与仓储列清单、DTO 白名单一一对应（不含敏感列）', () => {
  const personSql = migrationText('0001_personnel_person.sql');
  const assignmentSql = migrationText('0002_personnel_assignment.sql');
  assert.deepEqual(ddlColumns(personSql, 'person').sort(), [...PERSON_COLUMNS].sort());
  assert.deepEqual(ddlColumns(assignmentSql, 'assignment').sort(), [...ASSIGNMENT_COLUMNS].sort());
  // person 列（snake_case→camelCase）映射到 PersonDetail 白名单：
  // id→personId；mobile/email 两列合并为 contact；deactivated_on 为存储侧列。
  const detailLike = ddlColumns(personSql, 'person')
    .map(camel)
    .map((c) => (c === 'id' ? 'personId' : c))
    .filter((c) => c !== 'mobile' && c !== 'email');
  detailLike.push('contact');
  assert.deepEqual(
    detailLike.sort(),
    [...PERSON_DETAIL_FIELDS.filter((f) => f !== 'currentAssignment'), 'deactivatedOn'].sort(),
  );
  // Drizzle schema 声明的列与迁移 DDL 一一对应：列名以列构造器首参出现，
  // 形如 text('employee_no') 或 timestamp('created_at', { withTimezone: true, ... })。
  const schemaText = drizzleSchemaText();
  for (const column of [...PERSON_COLUMNS, ...ASSIGNMENT_COLUMNS]) {
    assert.match(
      schemaText,
      new RegExp(`\\(\\s*'${column}'\\s*[,)]`),
      `schema.ts 缺少列 ${column}（应作为列构造器首参声明）`,
    );
  }
  assert.deepEqual(findForbiddenFieldNames([...PERSON_COLUMNS, ...ASSIGNMENT_COLUMNS, ...CHANGE_RECORD_COLUMNS]), []);
  assert.deepEqual(findForbiddenFieldNames([...personSql.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((n) => n.includes('_'))), []);
  assert.deepEqual(
    findForbiddenFieldNames([...schemaText.matchAll(/'([a-z][a-z_]+)'/g)].map((m) => m[1]).filter((n) => n.includes('_'))),
    [],
  );
});

test('T-03：status CHECK、停用原因 CHECK 等在 Drizzle schema 中声明（T-03 约束清单）', () => {
  const schemaText = drizzleSchemaText();
  // person：status 枚举 CHECK 与「停用必须有原因」CHECK
  assert.match(schemaText, /check\(\s*'ck_person_status'[\s\S]*?PERSON_STATUSES/);
  assert.match(schemaText, /ck_person_deactivation_reason_required[\s\S]*?<>\s*'inactive'[\s\S]*?is not null/);
  assert.match(schemaText, /ck_person_employment_dates[\s\S]*?>= \$\{t\.employmentStartDate\}/);
  // assignment：区间先后、状态枚举与 R4 禁自引用 CHECK
  assert.match(schemaText, /ck_assignment_effective_dates/);
  assert.match(schemaText, /ck_assignment_status/);
  assert.match(schemaText, /ck_assignment_no_self_report/);
  // 外键全部 ON DELETE RESTRICT，无级联删除（AC-007）
  const restrictCount = [...schemaText.matchAll(/onDelete: 'restrict'/g)].length;
  assert.ok(restrictCount >= 3, `应有 ≥3 处 FK ON DELETE RESTRICT，当前 ${restrictCount}`);
  assert.doesNotMatch(schemaText, /onDelete: 'cascade'/);
  // ADR-003：EXCLUDE 排他约束待 PG 能力确认后追加（本稿仅注释占位，不得静默启用）
  assert.match(schemaText, /EXCLUDE/);
});

/**
 * 待迁移追加的约束清单（T-03 已知差异的机器可核对版本）：
 * schema.ts 已声明、但 M1/M2 的 DDL 尚未包含，需宿主走迁移审批流程按 drizzle-kit
 * 重生成后在 PG 实测（test-plan 的 deferred 项）。清单之外不得出现「静默缺失」的约束。
 */
const PENDING_MIGRATION_CONSTRAINTS = [
  'ck_person_employee_no_length',
  'ck_person_full_name_length',
  'ck_person_mobile_length',
  'ck_person_employment_type',
  'ck_person_status',
  'ck_person_employment_dates',
  'ck_person_deactivation_reason_required',
  'ck_person_deactivation_reason_length',
  'idx_person_roster_status_created',
  'idx_person_full_name',
  'ck_assignment_department_id_length',
  'ck_assignment_department_name_required',
  'ck_assignment_position_name_required',
  'ck_assignment_status',
  'ck_assignment_effective_dates',
  'ck_assignment_no_self_report',
  'idx_assignment_person_effective_from',
  'uq_assignment_person_effective_from',
  'idx_assignment_reports_to_person',
  'idx_assignment_department_id',
  // M3 is host-owned too; keep its schema declarations explicit until T-15.
  'ck_change_record_action',
  'idx_change_record_person_occurred_at',
];

test('T-03：Drizzle 声明的约束与 DDL 已落地约束 + 待迁移清单完全对账（不静默缺失、不谎报已落地）', (t) => {
  const schemaText = drizzleSchemaText();
  const declared = new Set(
    [...schemaText.matchAll(/(?:check|index|uniqueIndex)\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]),
  );
  assert.ok(declared.size >= PENDING_MIGRATION_CONSTRAINTS.length, `schema.ts 声明的约束过少：${declared.size}`);

  const ddlText = migrationText('0001_personnel_person.sql') + migrationText('0002_personnel_assignment.sql');
  const inDdl = new Set([...ddlText.matchAll(/(?:CONSTRAINT|INDEX|UNIQUE)\s+"([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  // 已落地的迁移约束必须同样存在于 Drizzle 声明中（UNIQUE employee_no 两侧一致）
  for (const name of inDdl) {
    if (name.startsWith('ck_') || name.startsWith('idx_') || name.startsWith('uq_')) {
      assert.ok(declared.has(name), `迁移含约束 ${name} 但 schema.ts 未声明`);
    }
  }
  // 待追加清单：必须已在 schema.ts 声明，且当前确实不在 DDL 中（若宿主已补齐则本条转为通过性提示）
  const pending = PENDING_MIGRATION_CONSTRAINTS.filter((name) => !inDdl.has(name));
  for (const name of PENDING_MIGRATION_CONSTRAINTS) {
    assert.ok(declared.has(name), `待迁移清单中的 ${name} 未在 schema.ts 声明`);
  }
  const undeclared = [...declared].filter(
    (name) => !inDdl.has(name) && !PENDING_MIGRATION_CONSTRAINTS.includes(name),
  );
  assert.deepEqual(undeclared, [], '存在既未写入迁移也未登记待办的约束');
  if (pending.length > 0) {
    t.diagnostic(
      `T-03 待宿主迁移审批流程补齐的 DDL 约束 ${pending.length} 项（内存仓储已镜像同等语义）：${pending.join(', ')}`,
    );
  }
  // 迁移未落地前，这些规则必须由内存仓储镜像守护（否则 S-1 的 node 证据不成立）
  assert.match(
    readFileSync(new URL('../src/personnel/domain/store.ts', import.meta.url), 'utf8'),
    /person\.status|status「/,
    '内存仓储缺少 status CHECK 镜像',
  );
});

test('T-03：M1 employee_no 唯一、M2 外键 ON DELETE RESTRICT 与 FK 引用列在 DDL 中落地', () => {
  const personSql = migrationText('0001_personnel_person.sql');
  const assignmentSql = migrationText('0002_personnel_assignment.sql');
  assert.match(personSql, /UNIQUE\("employee_no"\)|CREATE UNIQUE INDEX[^\n]*\("employee_no"\)/i);
  assert.match(
    assignmentSql,
    /FOREIGN KEY \("person_id"\) REFERENCES [^\n]*"person"\("id"\)[^\n]*ON DELETE restrict/i,
  );
  assert.match(
    assignmentSql,
    /FOREIGN KEY \("reports_to_person_id"\) REFERENCES [^\n]*"person"\("id"\)[^\n]*ON DELETE restrict/i,
  );
  // 仅向前迁移：不含回滚/破坏性语句
  for (const sqlText of [personSql, assignmentSql]) {
    assert.doesNotMatch(sqlText, /^\s*DROP\s+(TABLE|INDEX|CONSTRAINT)/im);
    assert.doesNotMatch(sqlText, /\bDELETE\s+FROM\b/i);
  }
});

test('T-03：M1/M2 为仅向前建表脚本，只新建 personnel 表、不触碰既有对象（AC-011 足迹）', () => {
  const cases = [
    ['0001_personnel_person.sql', ['person']],
    ['0002_personnel_assignment.sql', ['assignment']],
  ];
  for (const [file, created] of cases) {
    const sqlText = migrationText(file);
    const statements = sqlStatements(sqlText);
    assert.ok(statements.length > 0, `${file} 没有可执行语句`);
    for (const statement of statements) {
      assert.match(
        statement,
        /^(CREATE TABLE "|CREATE (UNIQUE )?INDEX "|ALTER TABLE ")/,
        `${file} 含预期外的语句形式：${statement.slice(0, 40)}`,
      );
    }
    const createdTables = [...sqlText.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(createdTables.sort(), [...created].sort(), `${file} 只应新建计划内表`);
    // 允许 schema 限定写法（如 "public"."person"）：仅断言被引用表属于 personnel 计划内表。
    const referenced = [...sqlText.matchAll(/REFERENCES (?:"?[A-Za-z_]+"?\.)?"([a-z_]+)"/g)].map((m) => m[1]);
    for (const table of referenced) {
      assert.ok(['person', 'assignment'].includes(table), `${file} 引用了 personnel 之外的表 ${table}`);
    }
    // 破坏性/数据写入语句按「语句形态」匹配：DROP、TRUNCATE、INSERT INTO、DELETE FROM、
    // UPDATE 语句、ALTER COLUMN、RENAME COLUMN。外键子句 ON DELETE RESTRICT /
    // ON UPDATE no action 中的关键字属约束定义语法（上一条测试断言其存在），不按裸词误判。
    assert.doesNotMatch(
      sqlText,
      /\b(DROP|TRUNCATE|INSERT\s+INTO|ALTER\s+COLUMN|RENAME\s+COLUMN)\b|\bDELETE\s+FROM\b|(?<!\bON\s)\bUPDATE\b/i,
      `${file} 含破坏性或数据写入语句（迁移仅向前、不改数据）`,
    );
  }
});

test('T-03：仓储镜像 status CHECK 与停用原因 CHECK（R2/F4 存储层守护）', () => {
  const store = new InMemoryPersonnelStore();
  for (const status of ['active', 'draft']) {
    insertPerson(store, { id: `p-${status}`, employee_no: `EMP-${status}`, status });
  }
  assert.throws(() => insertPerson(store, { id: 'p-x', employee_no: 'EMP-X', status: 'left' }), /status/);
  assert.throws(
    () => insertPerson(store, { id: 'p-y', employee_no: 'EMP-Y', status: 'terminated' }),
    PersonnelError,
  );
  // 停用必须带原因；原因长度 ≤200
  assert.throws(
    () => insertPerson(store, { id: 'p-z', employee_no: 'EMP-Z', status: 'inactive', deactivation_reason: null }),
    /deactivation_reason/,
  );
  insertPerson(store, { id: 'p-ok', employee_no: 'EMP-OK', status: 'inactive', deactivation_reason: '离职' });
  assert.throws(
    () => insertPerson(store, { id: 'p-long', employee_no: 'EMP-LONG', status: 'inactive', deactivation_reason: '理'.repeat(201) }),
    /deactivation_reason/,
  );
  assert.throws(
    () => insertPerson(store, { id: 'p-date', employee_no: 'EMP-DATE', employment_end_date: '2025-12-31' }),
    /employment_end_date/,
  );
  assert.throws(
    () => insertPerson(store, { id: 'p-type', employee_no: 'EMP-TYPE', employment_type: 'freelance' }),
    /employment_type/,
  );
});

test('T-03：assignment 镜像 FK RESTRICT、区间日期与自引用 CHECK（R3/R4/AC-007）', () => {
  const store = new InMemoryPersonnelStore();
  insertPerson(store);
  assert.throws(() => store.transaction((tx) => tx.insertAssignment(assignmentRow({ person_id: 'ghost' }))), /person_id/);
  assert.throws(
    () => store.transaction((tx) => tx.insertAssignment(assignmentRow({ effective_to: '2025-12-31' }))),
    /effective_to/,
  );
  assert.throws(
    () => store.transaction((tx) => tx.insertAssignment(assignmentRow({ reports_to_person_id: 'p1' }))),
    /自引用/,
  );
  assert.throws(
    () => store.transaction((tx) => tx.insertAssignment(assignmentRow({ status: 'archived' }))),
    /status/,
  );
  store.transaction((tx) => tx.insertAssignment(assignmentRow()));
  // FK RESTRICT：仍有任职记录时不可物理删除人员
  assert.throws(() => store.transaction((tx) => tx.deletePerson('p1')), (error) => {
    assert.ok(error instanceof PersonnelError);
    assert.equal(error.code, 'referenced_by_business');
    assert.match(error.message, CJK);
    return true;
  });
  assert.ok(store.findPersonById('p1') !== null);
});

test('T-03：内存仓储事务内任一步抛错整体回滚（含审计记录，F1/R2）', () => {
  const store = new InMemoryPersonnelStore();
  assert.throws(
    () =>
      store.transaction((tx) => {
        tx.insertPerson(personRow());
        tx.insertAssignment(assignmentRow());
        tx.insertChangeRecord(changeRecordRow());
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(store.countPersons(), 0);
  assert.equal(store.countAssignments(), 0);
  assert.deepEqual(store.listChangeRecords('p1'), []);
});

// ---------- T-04 createPerson（F1 / R2） ----------

test('T-04/F1：建档成功后同一事务写入 person（在职）与首条任职区间（current）', () => {
  const { store, context } = makeStore();
  const detail = createPerson(store, validInput(), context);
  assert.equal(detail.status, 'active');
  assert.equal(detail.personId, 'id-1');
  assert.equal(detail.employeeNo, 'EMP-0001');
  assert.equal(detail.fullName, '张三');
  assert.equal(detail.createdAt, '2026-09-10T00:00:00.000Z');
  assert.equal(detail.currentAssignment.assignmentId, 'id-2');
  assert.equal(detail.currentAssignment.status, 'current');
  assert.equal(detail.currentAssignment.personId, 'id-1');
  assert.equal(detail.currentAssignment.departmentId, 'DEPT-TECH');
  assert.equal(detail.currentAssignment.departmentName, '研发部');
  assert.equal(detail.currentAssignment.positionName, '后端工程师');
  assert.equal(detail.currentAssignment.effectiveFrom, '2026-01-01');
  assert.equal(detail.currentAssignment.effectiveTo, null);
  assert.equal(store.countPersons(), 1);
  assert.equal(store.countAssignments(), 1);
  assert.equal(store.findPersonById('id-1').status, 'active');
  assert.equal(store.listAssignmentsByPerson('id-1')[0].status, 'current');
});

test('T-04/F1：草稿→在职（R2）后按人员可查字段级历史（含操作人与时间）', () => {
  const { store, context } = makeStore();
  const detail = createPerson(store, validInput(), { ...context, operatorId: 'hr-001', operatorName: '人事甲' });
  const records = store.listChangeRecords(detail.personId);
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.equal(record.person_id, detail.personId);
    assert.equal(record.operator_id, 'hr-001');
    assert.equal(record.operator_name, '人事甲');
    assert.equal(record.occurred_at, '2026-09-10T00:00:00.000Z');
    assert.deepEqual(Object.keys(record).sort(), [...CHANGE_RECORD_COLUMNS].sort());
  }
  const created = records.find((record) => record.action === 'create' && record.field_name === 'person');
  assert.ok(created !== undefined);
  assert.equal(created.new_value, 'active');
  const department = records.find((record) => record.field_name === 'departmentId');
  assert.equal(department.new_value, 'DEPT-TECH');
  assert.equal(department.effective_from, '2026-01-01');
});

test('T-04/AC-009：createPerson 输出与仓储行仅含白名单字段，不含敏感字段', () => {
  const { store, context } = makeStore();
  const detail = createPerson(store, validInput(), context);
  assert.deepEqual(Object.keys(detail).sort(), [...PERSON_DETAIL_FIELDS].sort());
  for (const key of Object.keys(detail.currentAssignment)) {
    assert.ok(ASSIGNMENT_FIELDS.includes(key), key);
  }
  assert.deepEqual(findForbiddenFieldNames(Object.keys(detail)), []);
  const personRowRead = store.findPersonById(detail.personId);
  assert.equal(personRowRead.status, 'active');
  assert.deepEqual(Object.keys(personRowRead).sort(), [...PERSON_COLUMNS].sort());
  const assignmentRows = store.listAssignmentsByPerson(detail.personId);
  assert.equal(assignmentRows.length, 1);
  assert.deepEqual(Object.keys(assignmentRows[0]).sort(), [...ASSIGNMENT_COLUMNS].sort());
});

test('T-04/AC-001/R6：createPerson 缺省必填字段抛 validation_failed 且不落任何数据', () => {
  const { store, context } = makeStore();
  const input = validInput();
  delete input.departmentId;
  delete input.positionName;
  assert.throws(
    () => createPerson(store, input, context),
    (error) => {
      assert.ok(error instanceof PersonnelError);
      assert.equal(error.code, 'validation_failed');
      assert.match(error.message, CJK);
      assert.deepEqual(error.fieldErrors.map((e) => e.field).sort(), ['departmentId', 'positionName']);
      for (const fieldError of error.fieldErrors) assert.match(fieldError.message, CJK);
      return true;
    },
  );
  assert.equal(store.countPersons(), 0);
  assert.equal(store.countAssignments(), 0);
  assert.equal(store.countChangeRecords(), 0);
});

test('T-04/F1/R2：任职区间写入失败（外键违例）时整体回滚，person 无半写残留', () => {
  const { store, context } = makeStore();
  createPerson(store, validInput(), context);
  const recordsAfterFirst = store.countChangeRecords();
  const ghost = '00000000-0000-4000-8000-0000000000ff';
  const second = { ...validInput(), employeeNo: 'EMP-0002', reportsToPersonId: ghost };
  assert.throws(
    () => createPerson(store, second, context),
    (error) => {
      assert.ok(error instanceof PersonnelError);
      assert.match(error.message, CJK);
      return true;
    },
  );
  assert.equal(store.countPersons(), 1);
  assert.equal(store.countAssignments(), 1);
  assert.equal(store.countChangeRecords(), recordsAfterFirst);
  assert.equal(store.findPersonByEmployeeNo('EMP-0002'), null);
});

test('T-04/F1/R2/R7：审计追加失败时档案与任职区间一并回滚（同一事务，无半写）', () => {
  let counter = 0;
  const store = new InMemoryPersonnelStore();
  const context = {
    idFactory: () => `id-${++counter}`,
    clock: () => '2026-09-10T00:00:00.000Z',
    operatorId: 'hr-002',
  };
  // 预置一条既有档案与审计行，使其 id 与第二次建档将写入的某条 change_record 主键冲突
  store.transaction((tx) => {
    tx.insertPerson(personRow({ id: 'seed', employee_no: 'EMP-SEED' }));
    tx.insertChangeRecord(changeRecordRow({ id: 'id-5', person_id: 'seed' }));
  });
  assert.throws(
    () => createPerson(store, validInput(), context),
    (error) => {
      assert.ok(error instanceof PersonnelError);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, CJK);
      return true;
    },
  );
  // 回滚后仅剩预置数据：本次建档的 person / assignment / change_record 全部撤销
  assert.equal(store.countPersons(), 1);
  assert.equal(store.findPersonById('seed') !== null, true);
  assert.equal(store.findPersonByEmployeeNo('EMP-0001'), null);
  assert.equal(store.countAssignments(), 0);
  assert.deepEqual(store.listChangeRecords('id-1'), []);
  assert.equal(store.countChangeRecords(), 1);
});

test('T-04/R1（S-1 范围守护）：重复 employee_no 建档被 duplicate_employee_no 拒绝且无半写', () => {
  const { store, context } = makeStore();
  createPerson(store, validInput(), context);
  const duplicate = { ...validInput(), fullName: '李四', effectiveFrom: '2026-02-01' };
  assert.throws(
    () => createPerson(store, duplicate, context),
    (error) => {
      assert.ok(error instanceof PersonnelError);
      assert.equal(error.code, 'duplicate_employee_no');
      assert.equal(error.conflictRef, 'EMP-0001');
      assert.match(error.message, CJK);
      return true;
    },
  );
  assert.equal(store.countPersons(), 1);
  assert.equal(store.countAssignments(), 1);
});

test('T-04：duplicate_employee_no 的契约响应体形状（code/message/fieldErrors/conflictRef/requestId）', () => {
  const body = PersonnelError.duplicateEmployeeNo('EMP-0001').toErrorResponse();
  assert.equal(body.code, 'duplicate_employee_no');
  assert.equal(body.conflictRef, 'EMP-0001');
  assert.match(body.message, CJK);
  assert.deepEqual(Object.keys(body).sort(), [...ERROR_RESPONSE_FIELDS].sort());
});
