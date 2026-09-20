/**
 * personnel-roster 场景测试（T-08，证据 id=personnel-roster，AC-003 / AC-006）。
 * 执行：node --test test/personnel-roster.test.mjs
 *
 * 覆盖 S-2 三项任务（进程内 domain + 可回滚内存仓储，不连 PostgreSQL、不执行迁移）：
 * - T-06（src/personnel/domain/status.ts，AC-006）：R2 单向状态机
 *   仅允许 草稿→在职→停用；停用需原因与生效日期（R6 中文提示）；档案与历史保留；
 *   非法流转返回 invalid_status_transition（conflictRef=人员 id）且不产生半写；
 * - T-07（src/personnel/domain/roster.ts，AC-003/AC-006）：默认在册视图（省略 status
 *   即在职）、姓名/工号/部门/状态筛选、分页（含越界页与非法分页参数），
 *   以及可指派候选集查询（停用者不进入）；
 * - T-08（本文件）：personnel-roster 场景端到端串联——建档后默认在册立即命中且
 *   分页/筛选正确；停用后不在默认在册与可指派集合，但显式 status=inactive、
 *   字段级历史与既有业务关联（任职区间行）仍可读（R5 名称快照以内存桩表达）。
 *
 * 验收补强（tester）：在册摘要按基准日取生效任职区间（调岗前后与 retracted 区间）、
 * 在职但区间已结束者离开默认在册与可指派集合、三状态互不串档、停用后显式查询的
 * 契约摘要字段形状。
 *
 * test-plan 的 deferred 项（PG 约束实测、挂载路由/会话行为、openapi 契约一致性、
 * 包级 typecheck/build）不在本文件声称范围内。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PERSON_SUMMARY_FIELDS, PERSON_SUMMARY_REQUIRED_FIELDS } from '../src/personnel/contract/dto.ts';
import { PersonnelError } from '../src/personnel/contract/errors.ts';
import { getPerson, listAssignablePersons, listPersons } from '../src/personnel/domain/roster.ts';
import { createPerson } from '../src/personnel/domain/service.ts';
import { InMemoryPersonnelStore } from '../src/personnel/domain/store.ts';
import { transitionPersonStatus } from '../src/personnel/domain/status.ts';

/** 中文可理解提示的最低要求：消息含 CJK 字符（R6）。 */
const CJK = /[\u4e00-\u9fff]/;

/** 查询基准日：与 clock() 同日，落在测试内所有任职区间之内。 */
const AS_OF = '2026-09-10';
const OCCURRED_AT = '2026-09-10T00:00:00.000Z';

const DEPARTMENTS = {
  'DEPT-TECH': '研发部',
  'DEPT-PRODUCT': '产品部',
  'DEPT-HR': '人事部',
};

function validInput(overrides = {}) {
  return {
    employeeNo: 'EMP-0001',
    fullName: '张三',
    employmentType: 'full_time',
    employmentStartDate: '2026-01-01',
    departmentId: 'DEPT-TECH',
    departmentName: DEPARTMENTS['DEPT-TECH'],
    positionName: '后端工程师',
    effectiveFrom: '2026-01-01',
    ...overrides,
  };
}

let idCounter = 0;

function makeStore() {
  idCounter = 0;
  return {
    store: new InMemoryPersonnelStore(),
    context: {
      idFactory: () => `id-${(idCounter += 1)}`,
      clock: () => OCCURRED_AT,
      operatorId: 'hr-001',
      operatorName: '人事甲',
    },
  };
}

function personRow(overrides = {}) {
  return {
    id: 'p-seed',
    employee_no: 'EMP-9000',
    full_name: '待入职',
    mobile: null,
    email: null,
    employment_type: 'full_time',
    employment_start_date: '2026-01-01',
    employment_end_date: null,
    status: 'draft',
    deactivated_on: null,
    deactivation_reason: null,
    created_at: OCCURRED_AT,
    updated_at: OCCURRED_AT,
    ...overrides,
  };
}

function assignmentRow(overrides = {}) {
  return {
    id: 'p-seed-a1',
    person_id: 'p-seed',
    department_id: 'DEPT-HR',
    department_name: DEPARTMENTS['DEPT-HR'],
    position_id: null,
    position_name: '人事专员',
    reports_to_person_id: null,
    effective_from: '2026-09-01',
    effective_to: null,
    status: 'current',
    created_at: OCCURRED_AT,
    updated_at: OCCURRED_AT,
    ...overrides,
  };
}

/** 直接按仓储行写入一条「草稿」档案（createPerson 建档即在职，草稿态只能由存储层构造）。 */
function seedDraftPerson(store, { id, employeeNo, fullName, departmentId, effectiveFrom }) {
  store.transaction((tx) => {
    tx.insertPerson(personRow({ id, employee_no: employeeNo, full_name: fullName, status: 'draft' }));
    tx.insertAssignment(
      assignmentRow({
        id: `${id}-a1`,
        person_id: id,
        department_id: departmentId,
        department_name: DEPARTMENTS[departmentId],
        effective_from: effectiveFrom,
      }),
    );
  });
}

/** 取某人按插入顺序的第 index 条任职区间行（createPerson 只写一条）。 */
function assignmentOf(store, personId, index = 0) {
  const rows = store.listAssignmentsByPerson(personId);
  assert.ok(rows.length > index, `测试前置：人员 ${personId} 应有第 ${index + 1} 条任职区间`);
  return rows[index];
}

function employeeNosOf(items) {
  return items.map((item) => item.employeeNo);
}

function expectPersonnelError(code, fn) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== null, `应抛出 ${code}`);
  assert.ok(thrown instanceof PersonnelError, `应抛出 PersonnelError，实际 ${String(thrown)}`);
  assert.equal(thrown.code, code);
  assert.match(thrown.message, CJK);
  return thrown;
}

// ---------- T-06：R2 单向状态机与停用 F4（AC-006） ----------

test('T-06/R2：仅允许 草稿→在职→停用，其余流转返回 invalid_status_transition 且不写库', () => {
  const { store, context } = makeStore();
  seedDraftPerson(store, {
    id: 'p-flow',
    employeeNo: 'EMP-0500',
    fullName: '赵六',
    departmentId: 'DEPT-TECH',
    effectiveFrom: '2026-09-01',
  });

  // 草稿→停用：非法（R2）
  const rejected = expectPersonnelError('invalid_status_transition', () =>
    transitionPersonStatus(store, 'p-flow', { toStatus: 'inactive', reason: '离职', effectiveFrom: AS_OF }, context),
  );
  assert.equal(rejected.conflictRef, 'p-flow');
  assert.equal(store.findPersonById('p-flow').status, 'draft');
  assert.equal(store.countChangeRecords('p-flow'), 0, '被拒流转不得留下审计半写');
  assert.equal(store.findAssignmentById('p-flow-a1').effective_to, null);

  // 草稿→在职：合法（R2 首段）
  const activated = transitionPersonStatus(store, 'p-flow', { toStatus: 'active', effectiveFrom: AS_OF }, context);
  assert.equal(activated.status, 'active');
  assert.equal(activated.currentAssignment.departmentId, 'DEPT-TECH');
  assert.equal(store.findPersonById('p-flow').status, 'active');
  assert.equal(store.countChangeRecords('p-flow'), 1);

  // 在职→在职：非法
  expectPersonnelError('invalid_status_transition', () =>
    transitionPersonStatus(store, 'p-flow', { toStatus: 'active', effectiveFrom: AS_OF }, context),
  );
  assert.equal(store.countChangeRecords('p-flow'), 1, '第二次被拒同样不留痕');

  // 在职→停用：合法（F4）
  const deactivated = transitionPersonStatus(
    store,
    'p-flow',
    { toStatus: 'inactive', reason: '合同到期', effectiveFrom: AS_OF },
    context,
  );
  assert.equal(deactivated.status, 'inactive');
  assert.equal(deactivated.deactivationReason, '合同到期');
  assert.equal(deactivated.currentAssignment, null, '停用后不再返回当前任职');

  // 停用→在职、停用→停用：均非法（R2 单向）
  expectPersonnelError('invalid_status_transition', () =>
    transitionPersonStatus(store, 'p-flow', { toStatus: 'active', effectiveFrom: AS_OF }, context),
  );
  expectPersonnelError('invalid_status_transition', () =>
    transitionPersonStatus(store, 'p-flow', { toStatus: 'inactive', reason: '重复停用', effectiveFrom: AS_OF }, context),
  );
  const after = store.findPersonById('p-flow');
  assert.equal(after.status, 'inactive');
  assert.equal(after.deactivation_reason, '合同到期', '失败流转不得覆盖已登记的停用原因');
  assert.equal(after.deactivated_on, AS_OF);
  assert.equal(store.countChangeRecords('p-flow'), 3, '仅 3 次成功流转留有审计');
});

test('T-06/F4/R6：停用必须给出原因与生效日期，逐字段中文提示且不改动既有档案', () => {
  const { store, context } = makeStore();
  const created = createPerson(store, validInput(), context);
  const recordsBefore = store.countChangeRecords(created.personId);

  const cases = [
    [{ toStatus: 'inactive', effectiveFrom: AS_OF }, 'reason'],
    [{ toStatus: 'inactive', reason: null, effectiveFrom: AS_OF }, 'reason'],
    [{ toStatus: 'inactive', reason: '   ', effectiveFrom: AS_OF }, 'reason'],
    [{ toStatus: 'inactive', reason: '理'.repeat(201), effectiveFrom: AS_OF }, 'reason'],
    [{ toStatus: 'inactive', reason: '离职' }, 'effectiveFrom'],
    [{ toStatus: 'inactive', reason: '离职', effectiveFrom: '2026-13-01' }, 'effectiveFrom'],
    [{ toStatus: 'inactive', reason: '离职', effectiveFrom: '2026-02-30' }, 'effectiveFrom'],
    [{ toStatus: 'deleted', reason: '离职', effectiveFrom: AS_OF }, 'toStatus'],
    [{ toStatus: 'active', reason: '离职', effectiveFrom: 'bad-date' }, 'effectiveFrom'],
  ];
  for (const [payload, field] of cases) {
    const error = expectPersonnelError('validation_failed', () =>
      transitionPersonStatus(store, created.personId, payload, context),
    );
    assert.ok(
      error.fieldErrors.some((entry) => entry.field === field && CJK.test(entry.message)),
      `${JSON.stringify(payload)} 应在 ${field} 上给出中文提示：${JSON.stringify(error.fieldErrors)}`,
    );
  }

  // 非对象请求体同样被拒（R6）
  expectPersonnelError('validation_failed', () => transitionPersonStatus(store, created.personId, null, context));
  expectPersonnelError('validation_failed', () => transitionPersonStatus(store, created.personId, 'inactive', context));

  // 全部失败尝试后：状态、停用字段、审计条数与在册视图均未受影响
  const person = store.findPersonById(created.personId);
  assert.equal(person.status, 'active');
  assert.equal(person.deactivated_on, null);
  assert.equal(person.deactivation_reason, null);
  assert.equal(store.countChangeRecords(created.personId), recordsBefore);
  assert.equal(listPersons(store, { asOf: AS_OF }).total, 1);

  // 不存在的人员：not_found
  expectPersonnelError('not_found', () =>
    transitionPersonStatus(store, 'p-ghost', { toStatus: 'inactive', reason: '离职', effectiveFrom: AS_OF }, context),
  );
});

test('T-06/F4/R7：停用为状态变更而非删除，档案与字段级历史（含生效期间、操作人）保留', () => {
  const { store, context } = makeStore();
  const created = createPerson(store, validInput(), context);
  const personsBefore = store.countPersons();
  const assignmentsBefore = store.countAssignments();

  transitionPersonStatus(
    store,
    created.personId,
    { toStatus: 'inactive', reason: '个人原因离职', effectiveFrom: AS_OF },
    context,
  );

  assert.equal(store.countPersons(), personsBefore, 'F4 不得物理删除档案');
  assert.equal(store.countAssignments(), assignmentsBefore, 'F4 不得删除任职记录，只关闭区间');
  const person = store.findPersonById(created.personId);
  assert.equal(person.status, 'inactive');
  assert.equal(person.deactivated_on, AS_OF);
  assert.equal(person.deactivation_reason, '个人原因离职');
  assert.equal(person.full_name, '张三');
  assert.equal(person.employee_no, 'EMP-0001');

  const history = store.listChangeRecords(created.personId);
  const statusChange = history.find((record) => record.field_name === 'status');
  assert.ok(statusChange !== undefined, '应存在 status 字段的字段级历史');
  assert.equal(statusChange.action, 'status_change');
  assert.equal(statusChange.old_value, 'active');
  assert.equal(statusChange.new_value, 'inactive');
  assert.equal(statusChange.effective_from, AS_OF);
  assert.equal(statusChange.operator_id, 'hr-001');
  assert.equal(statusChange.operator_name, '人事甲');
  assert.equal(statusChange.occurred_at, OCCURRED_AT);
  const reasonChange = history.find((record) => record.field_name === 'deactivationReason');
  assert.equal(reasonChange.old_value, null);
  assert.equal(reasonChange.new_value, '个人原因离职');
  assert.equal(reasonChange.effective_from, AS_OF);
});

test('T-06/F4/R5：停用关闭当时生效的任职区间，历史名称快照与既有业务关联保留', () => {
  const { store, context } = makeStore();
  const created = createPerson(store, validInput(), context);

  transitionPersonStatus(
    store,
    created.personId,
    { toStatus: 'inactive', reason: '离职', effectiveFrom: '2026-06-30' },
    context,
  );

  const assignments = store.listAssignmentsByPerson(created.personId);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].status, 'closed');
  assert.equal(assignments[0].effective_from, '2026-01-01');
  assert.equal(assignments[0].effective_to, '2026-06-30');
  assert.equal(assignments[0].department_id, 'DEPT-TECH');
  assert.equal(assignments[0].department_name, '研发部', 'R5：名称快照须在停用后可追溯');
  assert.equal(assignments[0].position_name, '后端工程师');
  const detail = getPerson(store, created.personId, '2026-03-01');
  assert.equal(detail.status, 'inactive');
  assert.equal(detail.currentAssignment.departmentName, '研发部');
});

// ---------- T-07：默认在册视图、筛选与分页（AC-003） ----------

test('T-07/AC-003：默认在册视图省略 status 即为在职，建档后同一基准日立即可被检索', () => {
  const { store, context } = makeStore();
  const created = createPerson(store, validInput(), context);
  seedDraftPerson(store, {
    id: 'p-draft',
    employeeNo: 'EMP-9000',
    fullName: '待入职',
    departmentId: 'DEPT-HR',
    effectiveFrom: '2026-09-01',
  });

  const roster = listPersons(store, { asOf: AS_OF });
  assert.deepEqual(roster.items.map((item) => item.employeeNo), ['EMP-0001']);
  assert.equal(roster.total, 1);
  assert.equal(roster.page, 1);
  assert.equal(roster.pageSize, 20);
  const summary = roster.items[0];
  assert.equal(summary.personId, created.personId);
  assert.equal(summary.status, 'active');
  assert.equal(summary.departmentId, 'DEPT-TECH');
  assert.equal(summary.departmentName, '研发部');
  assert.equal(summary.positionName, '后端工程师');
  assert.deepEqual(Object.keys(summary).sort(), [...PERSON_SUMMARY_FIELDS].sort(), '摘要仅含契约 PersonSummary 字段');

  // 草稿不进入默认在册视图，但可显式按状态查得
  const drafts = listPersons(store, { status: 'draft', asOf: AS_OF });
  assert.equal(drafts.total, 1);
  assert.deepEqual(employeeNosOf(drafts.items), ['EMP-9000']);
});

test('T-07/AC-003：姓名/工号/部门/状态筛选（子串、大小写不敏感）与组合筛选', () => {
  const { store, context } = makeStore();
  createPerson(store, validInput(), context);
  createPerson(
    store,
    validInput({
      employeeNo: 'EMP-0002',
      fullName: '李四',
      departmentId: 'DEPT-PRODUCT',
      departmentName: DEPARTMENTS['DEPT-PRODUCT'],
      positionName: '产品经理',
      effectiveFrom: '2026-02-01',
    }),
    context,
  );
  createPerson(
    store,
    validInput({
      employeeNo: 'EMP-0003',
      fullName: 'Zhang San',
      departmentId: 'DEPT-TECH',
      departmentName: DEPARTMENTS['DEPT-TECH'],
      positionName: '前端工程师',
      effectiveFrom: '2026-03-01',
    }),
    context,
  );

  assert.deepEqual(employeeNosOf(listPersons(store, { name: '张', asOf: AS_OF }).items), ['EMP-0001']);
  assert.deepEqual(employeeNosOf(listPersons(store, { name: 'zhang', asOf: AS_OF }).items), ['EMP-0003']);
  assert.deepEqual(employeeNosOf(listPersons(store, { employeeNo: '0002', asOf: AS_OF }).items), ['EMP-0002']);
  assert.deepEqual(employeeNosOf(listPersons(store, { employeeNo: 'emp-00', asOf: AS_OF }).items), [
    'EMP-0001',
    'EMP-0002',
    'EMP-0003',
  ]);
  assert.deepEqual(employeeNosOf(listPersons(store, { departmentId: 'tech', asOf: AS_OF }).items), [
    'EMP-0001',
    'EMP-0003',
  ]);
  assert.deepEqual(employeeNosOf(listPersons(store, { departmentId: 'DEPT-PRODUCT', asOf: AS_OF }).items), [
    'EMP-0002',
  ]);
  assert.deepEqual(
    employeeNosOf(listPersons(store, { departmentId: 'tech', name: 'zhang', asOf: AS_OF }).items),
    ['EMP-0003'],
  );
  assert.deepEqual(employeeNosOf(listPersons(store, { status: 'active', name: '李', asOf: AS_OF }).items), ['EMP-0002']);
  // 无命中：空集合且 total=0（前端可据此显示空态）
  for (const query of [{ name: '赵' }, { employeeNo: 'EMP-9999' }, { departmentId: 'DEPT-FINANCE' }]) {
    const page = listPersons(store, { ...query, asOf: AS_OF });
    assert.deepEqual(page.items, [], JSON.stringify(query));
    assert.equal(page.total, 0, JSON.stringify(query));
  }
});

test('T-07/AC-003：分页稳定且不重不漏，越界页返回空集合但保留 total；非法分页参数被拒', () => {
  const { store, context } = makeStore();
  for (let index = 1; index <= 5; index += 1) {
    createPerson(
      store,
      validInput({
        employeeNo: `EMP-000${index}`,
        fullName: `员工${index}`,
        departmentId: index % 2 === 0 ? 'DEPT-PRODUCT' : 'DEPT-TECH',
        departmentName: index % 2 === 0 ? DEPARTMENTS['DEPT-PRODUCT'] : DEPARTMENTS['DEPT-TECH'],
      }),
      context,
    );
  }

  const pages = [1, 2, 3].map((page) => listPersons(store, { page, pageSize: 2, asOf: AS_OF }));
  assert.deepEqual(pages.map((page) => page.total), [5, 5, 5]);
  assert.deepEqual(pages.map((page) => page.pageSize), [2, 2, 2]);
  assert.deepEqual(employeeNosOf(pages[0].items), ['EMP-0001', 'EMP-0002']);
  assert.deepEqual(employeeNosOf(pages[1].items), ['EMP-0003', 'EMP-0004']);
  assert.deepEqual(employeeNosOf(pages[2].items), ['EMP-0005']);
  assert.deepEqual(
    pages.flatMap((page) => employeeNosOf(page.items)).sort(),
    ['EMP-0001', 'EMP-0002', 'EMP-0003', 'EMP-0004', 'EMP-0005'],
    '逐页拼接应与全集一致：不重复、不遗漏',
  );

  const beyond = listPersons(store, { page: 4, pageSize: 2, asOf: AS_OF });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.total, 5);
  assert.equal(beyond.page, 4);

  // 筛选与分页叠加：命中集合内的分页仍正确
  const techPage = listPersons(store, { departmentId: 'tech', page: 1, pageSize: 2, asOf: AS_OF });
  assert.equal(techPage.total, 3);
  assert.deepEqual(employeeNosOf(techPage.items), ['EMP-0001', 'EMP-0003']);
  assert.deepEqual(
    employeeNosOf(listPersons(store, { departmentId: 'tech', page: 2, pageSize: 2, asOf: AS_OF }).items),
    ['EMP-0005'],
  );

  for (const query of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { pageSize: 0 }, { pageSize: 201 }, { pageSize: 'x' }]) {
    const error = expectPersonnelError('validation_failed', () => listPersons(store, { ...query, asOf: AS_OF }));
    assert.ok(error.fieldErrors.length > 0);
    for (const entry of error.fieldErrors) assert.match(entry.message, CJK);
  }
});

test('T-07：可指派候选集仅含在职人员，停用者不进入（草稿亦不进入）', () => {
  const { store, context } = makeStore();
  const first = createPerson(store, validInput(), context);
  createPerson(store, validInput({ employeeNo: 'EMP-0002', fullName: '李四' }), context);
  seedDraftPerson(store, {
    id: 'p-draft',
    employeeNo: 'EMP-9000',
    fullName: '待入职',
    departmentId: 'DEPT-HR',
    effectiveFrom: '2026-09-01',
  });

  assert.deepEqual(employeeNosOf(listAssignablePersons(store, AS_OF)), ['EMP-0001', 'EMP-0002']);
  transitionPersonStatus(store, first.personId, { toStatus: 'inactive', reason: '离职', effectiveFrom: AS_OF }, context);
  const candidates = listAssignablePersons(store, AS_OF);
  assert.deepEqual(employeeNosOf(candidates), ['EMP-0002']);
  assert.deepEqual(
    candidates.map((item) => item.status),
    ['active'],
    '候选集不得出现非在职人员',
  );
});

// ---------- T-08：personnel-roster 端到端场景（AC-003 / AC-006） ----------

test('T-08/AC-003+AC-006：建档即在册（筛选/分页正确）→ 停用后离开默认在册与可指派集合，但显式查询、历史与业务关联仍可读', () => {
  const { store, context } = makeStore();
  const left = createPerson(store, validInput(), context);
  const staying = createPerson(
    store,
    validInput({
      employeeNo: 'EMP-0002',
      fullName: '李四',
      departmentId: 'DEPT-PRODUCT',
      departmentName: DEPARTMENTS['DEPT-PRODUCT'],
      positionName: '产品经理',
      effectiveFrom: '2026-02-01',
    }),
    context,
  );

  // 前半段：F1 完成后默认在册立即命中，筛选与分页正确
  assert.equal(listPersons(store, { asOf: AS_OF }).total, 2);
  assert.deepEqual(employeeNosOf(listPersons(store, { departmentId: 'product', asOf: AS_OF }).items), ['EMP-0002']);
  assert.deepEqual(employeeNosOf(listPersons(store, { page: 2, pageSize: 1, asOf: AS_OF }).items), ['EMP-0002']);

  // 后半段：F4 停用
  transitionPersonStatus(store, left.personId, { toStatus: 'inactive', reason: '个人原因离职', effectiveFrom: AS_OF }, context);

  // 默认在册视图与可指派集合都不再含停用人员（AC-006 / R5）
  assert.deepEqual(employeeNosOf(listPersons(store, { asOf: AS_OF }).items), ['EMP-0002']);
  assert.equal(listPersons(store, { asOf: AS_OF }).total, 1);
  assert.deepEqual(employeeNosOf(listAssignablePersons(store, AS_OF)), ['EMP-0002']);
  // 任何筛选路径（姓名/工号/部门）也不得把停用者带回默认视图
  for (const query of [{ name: '张' }, { employeeNo: 'EMP-0001' }, { departmentId: 'tech' }]) {
    assert.deepEqual(listPersons(store, { ...query, asOf: AS_OF }).items, [], JSON.stringify(query));
  }

  // 显式 status=inactive 仍可分页读到停用人员
  const inactivePage = listPersons(store, { status: 'inactive', page: 1, pageSize: 20, asOf: AS_OF });
  assert.equal(inactivePage.total, 1);
  assert.equal(inactivePage.items[0].personId, left.personId);
  assert.equal(inactivePage.items[0].status, 'inactive');

  // 人员维度详情与既有业务关联仍可读（不物理删除）
  const detail = getPerson(store, left.personId, AS_OF);
  assert.equal(detail.employeeNo, 'EMP-0001');
  assert.equal(detail.fullName, '张三');
  assert.equal(detail.status, 'inactive');
  assert.equal(detail.deactivationReason, '个人原因离职');
  assert.equal(store.countPersons(), 2);
  const assignments = store.listAssignmentsByPerson(left.personId);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].status, 'closed');
  assert.equal(assignments[0].effective_to, AS_OF);
  assert.equal(assignments[0].department_name, '研发部');
  assert.throws(
    () =>
      store.transaction((tx) => {
        tx.deletePerson(left.personId);
      }),
    (error) => {
      assert.ok(error instanceof PersonnelError);
      assert.equal(error.code, 'referenced_by_business');
      return true;
    },
    '停用档案仍受任职记录 FK RESTRICT 保护（AC-006 的关联保留）',
  );

  // 字段级历史（含建档与停用）按人员可查（R7/AC-010 的在册侧）
  const history = store.listChangeRecords(left.personId);
  assert.ok(history.some((record) => record.action === 'create'));
  assert.ok(
    history.some(
      (record) =>
        record.action === 'status_change' &&
        record.old_value === 'active' &&
        record.new_value === 'inactive' &&
        record.effective_from === AS_OF,
    ),
  );
  assert.ok(history.some((record) => record.action === 'assignment_change' && record.new_value === '研发部'));
  for (const record of history) {
    assert.equal(record.person_id, left.personId);
    assert.equal(record.operator_id, 'hr-001');
    assert.equal(record.occurred_at, OCCURRED_AT);
  }

  // 未停用人员不受影响
  assert.equal(store.findPersonById(staying.personId).status, 'active');
  assert.equal(getPerson(store, staying.personId, AS_OF).currentAssignment.departmentName, '产品部');
});

// ---------- 验收补强：在册视图的区间语义与状态分区（T-07 / AC-003 / AC-006） ----------

test('T-07/AC-003：在册摘要与部门筛选取「基准日生效」的区间——调岗前后各自命中，retracted 区间不参与', () => {
  const { store, context } = makeStore();
  const created = createPerson(store, validInput(), context);
  const first = assignmentOf(store, created.personId);

  store.transaction((tx) => {
    tx.updateAssignment({ ...first, effective_to: '2026-05-31', status: 'closed', updated_at: OCCURRED_AT });
    tx.insertAssignment(
      assignmentRow({
        id: `${created.personId}-a2`,
        person_id: created.personId,
        department_id: 'DEPT-PRODUCT',
        department_name: DEPARTMENTS['DEPT-PRODUCT'],
        position_name: '产品经理',
        effective_from: '2026-06-01',
        effective_to: null,
        status: 'current',
      }),
    );
    // 已撤销的区间（更晚开始）不得被摘要或部门筛选选中
    tx.insertAssignment(
      assignmentRow({
        id: `${created.personId}-a3`,
        person_id: created.personId,
        department_id: 'DEPT-HR',
        department_name: DEPARTMENTS['DEPT-HR'],
        position_name: '人事专员',
        effective_from: '2026-08-01',
        effective_to: null,
        status: 'retracted',
      }),
    );
  });

  const present = listPersons(store, { asOf: AS_OF });
  assert.equal(present.total, 1);
  assert.equal(present.items[0].departmentId, 'DEPT-PRODUCT');
  assert.equal(present.items[0].departmentName, '产品部');
  assert.equal(present.items[0].positionName, '产品经理');

  const past = listPersons(store, { asOf: '2026-03-01' });
  assert.equal(past.total, 1);
  assert.equal(past.items[0].departmentId, 'DEPT-TECH', 'asOf 落在旧区间时应给出旧部门（R5 快照）');
  assert.equal(past.items[0].departmentName, '研发部');

  assert.deepEqual(employeeNosOf(listPersons(store, { departmentId: 'product', asOf: AS_OF }).items), ['EMP-0001']);
  assert.deepEqual(listPersons(store, { departmentId: 'product', asOf: '2026-03-01' }).items, []);
  assert.deepEqual(employeeNosOf(listPersons(store, { departmentId: 'tech', asOf: '2026-03-01' }).items), ['EMP-0001']);
  assert.deepEqual(
    listPersons(store, { departmentId: 'hr', asOf: AS_OF }).items,
    [],
    'retracted 区间不得进入在册摘要或按部门筛选的结果',
  );

  const candidates = listAssignablePersons(store, AS_OF);
  assert.deepEqual(employeeNosOf(candidates), ['EMP-0001']);
  assert.equal(candidates[0].departmentId, 'DEPT-PRODUCT', '可指派候选须带当前生效部门，供汇报关系校验使用');
});

test('T-07/AC-003：在职但任职区间已结束者不进入默认在册与可指派集合，详情按历史基准日仍可读', () => {
  const { store, context } = makeStore();
  const created = createPerson(store, validInput(), context);
  const first = assignmentOf(store, created.personId);
  store.transaction((tx) => {
    tx.updateAssignment({ ...first, effective_to: '2026-05-31', status: 'closed', updated_at: OCCURRED_AT });
  });

  assert.equal(store.findPersonById(created.personId).status, 'active', '仅关闭区间不改变人员状态（停用属 F4）');
  assert.deepEqual(listPersons(store, { asOf: AS_OF }).items, [], '默认在册须限定「在职且处于生效区间」');
  assert.deepEqual(listPersons(store, { status: 'active', asOf: AS_OF }).items, []);
  assert.deepEqual(listPersons(store, { employeeNo: 'EMP-0001', asOf: AS_OF }).items, [], '筛选路径同样不得带回');
  assert.equal(listAssignablePersons(store, AS_OF).length, 0, '区间已结束者不应成为可指派候选');

  const detail = getPerson(store, created.personId, '2026-03-01');
  assert.equal(detail.status, 'active');
  assert.equal(detail.currentAssignment.departmentName, '研发部', '区间内基准日仍可读到组织归属（历史可读）');
});

test('T-07/AC-003+AC-006：草稿/在职/停用三态互不串档，默认在册恰等于 active 子集', () => {
  const { store, context } = makeStore();
  createPerson(store, validInput(), context);
  const leaving = createPerson(store, validInput({ employeeNo: 'EMP-0002', fullName: '李四' }), context);
  seedDraftPerson(store, {
    id: 'p-draft',
    employeeNo: 'EMP-9000',
    fullName: '待入职',
    departmentId: 'DEPT-HR',
    effectiveFrom: '2026-09-01',
  });
  transitionPersonStatus(
    store,
    leaving.personId,
    { toStatus: 'inactive', reason: '离职', effectiveFrom: AS_OF },
    context,
  );

  const drafts = listPersons(store, { status: 'draft', asOf: AS_OF });
  const actives = listPersons(store, { status: 'active', asOf: AS_OF });
  const inactives = listPersons(store, { status: 'inactive', asOf: AS_OF });
  const rosterDefault = listPersons(store, { asOf: AS_OF });

  assert.deepEqual(employeeNosOf(drafts.items), ['EMP-9000']);
  assert.deepEqual(employeeNosOf(actives.items), ['EMP-0001']);
  assert.deepEqual(employeeNosOf(inactives.items), ['EMP-0002']);
  assert.deepEqual(
    employeeNosOf(rosterDefault.items),
    employeeNosOf(actives.items),
    '省略 status 的默认在册视图必须与显式 status=active 完全一致',
  );
  assert.equal(
    drafts.total + actives.total + inactives.total,
    store.countPersons(),
    '三态子集互斥且完备：既无串档也无遗漏',
  );
  assert.deepEqual(employeeNosOf(listAssignablePersons(store, AS_OF)), ['EMP-0001']);
});

test('T-08/AC-006：停用后显式 status=inactive 的摘要字段形状符合契约，且停用生效日前仍带部门快照', () => {
  const { store, context } = makeStore();
  const created = createPerson(store, validInput(), context);
  transitionPersonStatus(
    store,
    created.personId,
    { toStatus: 'inactive', reason: '合同到期不续签', effectiveFrom: '2026-08-31' },
    context,
  );

  // 基准日已无生效区间：摘要仅保留契约 required 字段，不得凭空补部门
  const afterClose = listPersons(store, { status: 'inactive', asOf: AS_OF });
  assert.equal(afterClose.total, 1);
  assert.deepEqual(
    Object.keys(afterClose.items[0]).sort(),
    [...PERSON_SUMMARY_REQUIRED_FIELDS].sort(),
    `停用摘要应仅含契约必填字段，实际：${JSON.stringify(afterClose.items[0])}`,
  );
  assert.equal(afterClose.items[0].personId, created.personId);
  assert.equal(afterClose.items[0].employeeNo, 'EMP-0001');
  assert.equal(afterClose.items[0].status, 'inactive');

  // 停用生效日之前仍在区间内：显式查询与人员详情都能读到名称快照（R5）
  const withinTerm = listPersons(store, { status: 'inactive', asOf: '2026-06-30' });
  assert.equal(withinTerm.total, 1);
  assert.equal(withinTerm.items[0].departmentId, 'DEPT-TECH');
  assert.equal(withinTerm.items[0].departmentName, '研发部');
  assert.equal(withinTerm.items[0].positionName, '后端工程师');
  assert.deepEqual(
    listPersons(store, { asOf: '2026-06-30' }).items,
    [],
    '停用人员在任何基准日的默认在册视图都不出现（AC-006）',
  );

  const detail = getPerson(store, created.personId, '2026-06-30');
  assert.equal(detail.status, 'inactive');
  assert.equal(detail.deactivationReason, '合同到期不续签');
  assert.equal(detail.currentAssignment.departmentName, '研发部');

  const history = store.listChangeRecords(created.personId);
  assert.ok(
    history.some(
      (record) =>
        record.field_name === 'deactivationReason' &&
        record.new_value === '合同到期不续签' &&
        record.effective_from === '2026-08-31',
    ),
    '停用原因须以字段级历史留痕（F4/R7 的在册侧）',
  );
});

test('T-07/AC-003：筛选值做 trim 后匹配（前后空白不致漏检）', () => {
  const { store, context } = makeStore();
  createPerson(store, validInput(), context);

  assert.deepEqual(employeeNosOf(listPersons(store, { name: '  张  ', asOf: AS_OF }).items), ['EMP-0001']);
  assert.deepEqual(employeeNosOf(listPersons(store, { employeeNo: ' emp-0001 ', asOf: AS_OF }).items), ['EMP-0001']);
  assert.deepEqual(employeeNosOf(listPersons(store, { departmentId: '  DEPT-TECH ', asOf: AS_OF }).items), ['EMP-0001']);
});

test('PROBE/T-07：未来生效区间（尚未开始任职）的在职人员是否进入默认在册与可指派集合', () => {
  const { store, context } = makeStore();
  createPerson(store, validInput({ employmentStartDate: '2026-12-01', effectiveFrom: '2026-12-01' }), context);
  assert.equal(
    listPersons(store, { asOf: AS_OF }).total,
    0,
    'architecture 规定「默认在册视图 = 状态在职且在生效区间内」',
  );
  assert.equal(listAssignablePersons(store, AS_OF).length, 0, '尚未开始任职者不应成为可指派候选');
});
