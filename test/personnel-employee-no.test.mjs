/**
 * personnel-employee-no 场景测试（T-10，证据 id=personnel-employee-no，AC-002 / R1）。
 * 执行：node --test test/personnel-employee-no.test.mjs
 *
 * 覆盖（进程内 domain + 可回滚内存仓储，不连 PostgreSQL、不执行迁移）：
 * - T-09（工号唯一守护经 service.createPerson 接入，AC-002/R1）：
 *   同 employee_no 重复建档被拒——错误码 duplicate_employee_no、conflictRef 等于被占用工号、
 *   中文文案提示冲突工号；守护为「全表唯一」：停用与草稿档案同样占用工号；
 *   仓储层镜像 UNIQUE 索引的 employee_no 写入路径（insert/update）同样被拒，
 *   且冲突发生在事务内时整体回滚，不留半写行（F1/R2 基座）。
 * - T-10（R1 停用后不复用）：首条置停用后以同 employee_no 重复建档仍被拒，
 *   重复尝试同样被拒；被拒后停用者的状态、停用原因、区间与审计不被改动，
 *   新工号仍可正常建档（守护只拦冲突，不拦正常创建）。
 *
 * 说明：「停用」前置以内存仓储对 F4 持久化结果的镜像构造（status=inactive、
 * deactivated_on/reason、当前区间 closed），等价于 status.ts 成功停用的落库形态；
 * R2 状态机本身由 personnel-roster 证据（T-08）覆盖，不在本文件重复声称。
 * test-plan 的 deferred 项（PG 唯一索引实测、挂载路由行为、openapi 契约一致性、
 * 包级 typecheck/build）同样不在本文件声称范围内。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_RESPONSE_FIELDS, PERSONNEL_ERROR_HTTP_STATUS, PersonnelError } from '../src/personnel/contract/errors.ts';
import { createPerson } from '../src/personnel/domain/service.ts';
import { InMemoryPersonnelStore } from '../src/personnel/domain/store.ts';

/** 中文可理解提示的最低要求：消息含 CJK 字符（R6/AC-002「提示冲突工号」）。 */
const CJK = /[\u4e00-\u9fff]/;

/** F4 停用生效日与固定时钟（审计断言用），晚于所有测试区间的起始日。 */
const DEACTIVATION_DATE = '2026-09-10';
const OCCURRED_AT = '2026-09-12T00:00:00.000Z';

function validInput(overrides = {}) {
  return {
    employeeNo: 'EMP-0001',
    fullName: '张三',
    employmentType: 'full_time',
    employmentStartDate: '2026-01-01',
    departmentId: 'DEPT-TECH',
    departmentName: '研发部',
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

/** 直接构造一条「草稿」person 行（createPerson 建档即在职，草稿态只能由存储层写入）。 */
function draftRow(id, employeeNo, fullName) {
  return {
    id,
    employee_no: employeeNo,
    full_name: fullName,
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
  };
}

/**
 * 以存储层镜像 F4 的持久化结果构造「已停用」前置：person 置 inactive（含原因与停用日）、
 * 当前任职区间关闭。status CHECK 要求 inactive 必须带 deactivation_reason，与此一致。
 */
function deactivateAsPersistedByF4(store, personId, reason, effectiveFrom) {
  store.transaction((tx) => {
    const person = tx.findPersonById(personId);
    assert.ok(person !== null, `测试前置：人员 ${personId} 应已建档`);
    tx.updatePerson({
      ...person,
      status: 'inactive',
      deactivated_on: effectiveFrom,
      deactivation_reason: reason,
      updated_at: OCCURRED_AT,
    });
    const current = tx.listAssignmentsByPerson(personId).find((row) => row.status === 'current');
    if (current !== undefined) {
      tx.updateAssignment({ ...current, status: 'closed', effective_to: effectiveFrom, updated_at: OCCURRED_AT });
    }
  });
}

/** 断言 fn 抛出 duplicate_employee_no，且 conflictRef 命中被占用工号（AC-002 / R1）。 */
function expectDuplicateEmployeeNo(fn, employeeNo) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== null, `重复工号 ${employeeNo} 的建档应被拒绝（AC-002/R1）`);
  assert.ok(thrown instanceof PersonnelError, `应抛出 PersonnelError，实际 ${String(thrown)}`);
  assert.equal(thrown.code, 'duplicate_employee_no', `错误码应为 duplicate_employee_no，实际 ${thrown.code}`);
  assert.equal(thrown.conflictRef, employeeNo, 'conflictRef 应等于被占用的工号（AC-002 提示冲突工号）');
  assert.match(thrown.message, CJK, '错误文案应为可理解中文（R6）');
  assert.ok(thrown.message.includes(employeeNo), `错误文案应点出冲突工号 ${employeeNo}：${thrown.message}`);
  return thrown;
}

// ---------- 场景 1：同 employee_no 重复建档被拒且 conflictRef 命中（AC-002） ----------

test('T-09/AC-002：同 employee_no 重复建档被拒——duplicate_employee_no 且 conflictRef 指向被占用工号', () => {
  const { store, context } = makeStore();
  const first = createPerson(store, validInput(), context);
  const personsBefore = store.countPersons();
  const assignmentsBefore = store.countAssignments();
  const recordsBefore = store.countChangeRecords();
  assert.equal(personsBefore, 1, '前置：已建档一名在册人员');

  // 第二次提交姓名/雇佣类型/部门/岗位/生效日期全部不同，但工号仍为 EMP-0001
  const error = expectDuplicateEmployeeNo(
    () =>
      createPerson(
        store,
        validInput({
          fullName: '李四',
          employmentType: 'contract',
          departmentId: 'DEPT-PRODUCT',
          departmentName: '产品部',
          positionName: '产品经理',
          employmentStartDate: '2026-03-01',
          effectiveFrom: '2026-03-01',
        }),
        context,
      ),
    'EMP-0001',
  );

  // 契约错误形状：code/message/conflictRef 齐备、映射 HTTP 409（architecture Failure Model）
  const response = error.toErrorResponse();
  assert.deepEqual(Object.keys(response).sort(), [...ERROR_RESPONSE_FIELDS].sort());
  assert.equal(response.code, 'duplicate_employee_no');
  assert.equal(response.conflictRef, 'EMP-0001');
  assert.equal(response.fieldErrors, null, '冲突不是字段校验失败，不应携带 fieldErrors');
  assert.equal(PERSONNEL_ERROR_HTTP_STATUS[response.code], 409);

  // 冲突发生在事务内并整体回滚：无半写人员/任职/审计（F1/R2 基座，R1 由唯一约束镜像拒绝）
  assert.equal(store.countPersons(), personsBefore, '被拒的建档不得留下人员行');
  assert.equal(store.countAssignments(), assignmentsBefore, '被拒的建档不得留下任职半写行');
  assert.equal(store.countChangeRecords(), recordsBefore, '被拒的建档不得留下审计半写');
  const survivor = store.findPersonById(first.personId);
  assert.equal(survivor.status, 'active');
  assert.equal(survivor.full_name, '张三', '被占用档案本身不受任何改动');
  assert.equal(store.findPersonByEmployeeNo('EMP-0001').id, first.personId);

  // 不同工号正常建档：守护只拦重复工号，不拦正常创建
  const second = createPerson(
    store,
    validInput({
      employeeNo: 'EMP-0002',
      fullName: '李四',
      employmentType: 'contract',
      departmentId: 'DEPT-PRODUCT',
      departmentName: '产品部',
    }),
    context,
  );
  assert.equal(second.employeeNo, 'EMP-0002');
  assert.equal(store.countPersons(), 2);

  // 第二个工号再被重复使用同样被拒：唯一性对每条档案成立，不只首条
  expectDuplicateEmployeeNo(() => createPerson(store, validInput({ employeeNo: 'EMP-0002', fullName: '王五' }), context), 'EMP-0002');
  assert.equal(store.countPersons(), 2);
  assert.equal(store.countChangeRecords(), recordsBefore + 6, '仅两次成功建档留有审计');
});

// ---------- 场景 2：首条停用后重复建档仍被拒（R1 停用后不复用） ----------

test('T-10/AC-002/R1：首条停用后以同 employee_no 重复建档仍被拒——工号停用后不复用', () => {
  const { store, context } = makeStore();
  const created = createPerson(store, validInput(), context);
  deactivateAsPersistedByF4(store, created.personId, '个人原因离职', DEACTIVATION_DATE);
  assert.equal(store.findPersonById(created.personId).status, 'inactive', '前置：首条档案已处于停用态');
  const personsBefore = store.countPersons();
  const assignmentsBefore = store.countAssignments();
  const recordsBefore = store.countChangeRecords();

  // 停用者仍占用工号：连续两次重复建档尝试均被拒，conflictRef 命中旧工号
  for (const attempt of [1, 2]) {
    expectDuplicateEmployeeNo(
      () => createPerson(store, validInput({ fullName: `冒用者${attempt}`, employmentType: 'intern' }), context),
      'EMP-0001',
    );
  }

  // 被拒后：档案数不变，停用者的状态、停用原因与区间、审计均未被改动（不复用亦不覆盖）
  assert.equal(store.countPersons(), personsBefore);
  assert.equal(store.countAssignments(), assignmentsBefore);
  assert.equal(store.countChangeRecords(), recordsBefore);
  const kept = store.findPersonById(created.personId);
  assert.equal(kept.status, 'inactive');
  assert.equal(kept.deactivation_reason, '个人原因离职');
  assert.equal(kept.deactivated_on, DEACTIVATION_DATE);
  assert.equal(store.findPersonByEmployeeNo('EMP-0001').full_name, '张三', '工号仍指向停用原主');
  const assignments = store.listAssignmentsByPerson(created.personId);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].status, 'closed');
  assert.equal(assignments[0].effective_to, DEACTIVATION_DATE);

  // 停用后以新工号仍可正常建档（R1 只禁止复用旧工号，不阻塞创建路径）
  const successor = createPerson(store, validInput({ employeeNo: 'EMP-0002', fullName: '继任者' }), context);
  assert.equal(store.countPersons(), personsBefore + 1);
  assert.equal(store.findPersonByEmployeeNo('EMP-0002').id, successor.personId);

  // 之后再次尝试旧工号仍被拒：R1 的「不复用」对历史停用档案持续成立
  expectDuplicateEmployeeNo(() => createPerson(store, validInput({ fullName: '第三次尝试' }), context), 'EMP-0001');
  assert.equal(store.countPersons(), personsBefore + 1);
});

// ---------- 补强：全表唯一（跨状态）与存储层镜像约束的原子回滚（T-09/R1） ----------

test('T-09/R1：工号唯一为全表跨状态（草稿同样占用）；存储层 employee_no 写入路径被拒并整体回滚', () => {
  const { store, context } = makeStore();
  const active = createPerson(store, validInput(), context); // EMP-0001，在职
  const other = createPerson(
    store,
    validInput({ employeeNo: 'EMP-0002', fullName: '李四', departmentId: 'DEPT-PRODUCT', departmentName: '产品部' }),
    context,
  );
  const personsBefore = store.countPersons();
  const recordsBefore = store.countChangeRecords();

  // 草稿档案同样占用工号：唯一性不区分状态（R1 全表唯一，非「仅在册唯一」）
  store.transaction((tx) => {
    tx.insertPerson(draftRow('p-draft-0007', 'EMP-0007', '待入职'));
  });
  expectDuplicateEmployeeNo(() => createPerson(store, validInput({ employeeNo: 'EMP-0007', fullName: '冒名入职' }), context), 'EMP-0007');
  assert.equal(store.findPersonById('p-draft-0007').status, 'draft', '被拒建档不得改动草稿占用者');

  // 存储层直插重复工号：被拒且快照回滚，幽灵行不残留（UNIQUE 索引全表镜像）
  expectDuplicateEmployeeNo(
    () =>
      store.transaction((tx) => {
        tx.insertPerson(draftRow('p-ghost', 'EMP-0001', '幽灵行'));
      }),
    'EMP-0001',
  );
  assert.equal(store.findPersonById('p-ghost'), null, '回滚后不得残留被拒行');

  // updatePerson 把既有工号改成他人占用的值：同样 duplicate_employee_no，回滚后 EMP-0002 不变
  const otherRow = store.findPersonById(other.personId);
  expectDuplicateEmployeeNo(
    () =>
      store.transaction((tx) => {
        tx.updatePerson({ ...otherRow, employee_no: 'EMP-0001' });
      }),
    'EMP-0001',
  );
  assert.equal(store.findPersonById(other.personId).employee_no, 'EMP-0002', '回滚后第二条工号保持原值');

  // 全部失败尝试之后：人员数与审计条数只反映成功写入
  assert.equal(store.countPersons(), personsBefore + 1);
  assert.equal(store.countChangeRecords(), recordsBefore, '直插/直改路径失败不应产生审计半写');
  assert.equal(store.findPersonById(active.personId).employee_no, 'EMP-0001');
});
