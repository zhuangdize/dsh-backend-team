/**
 * personnel-access（T-19 / AC-008，覆盖 T-17 门禁与 T-18 框架无关处理器的状态映射）。
 *
 * 以非 HR 身份遍历集合查询与契约全部人员维度操作（详情/变更/删除/任职新增/任职撤销/
 * 状态流转/历史），断言 forbidden/not_found 分类、响应体不含任何人员数据、
 * 门禁先于校验与用例执行，且「无权」与「记录不存在」的响应深度相等（同码同结构）。
 * 经真实挂载路由与会话的端到端越权验证属宿主 deferred 项（见 test-plan.md）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { handlePersonnelRequest } from '../src/personnel/api/routes.ts';
import { InMemoryPersonnelStore } from '../src/personnel/domain/store.ts';

const HR = { authenticated: true, role: 'hr_admin', operatorId: 'hr-1', operatorName: 'HR 管理员' };
const NON_HR_ROLES = ['employee', 'manager', 'finance', 'dept_head'];
const ERROR_KEYS = ['code', 'conflictRef', 'fieldErrors', 'message', 'requestId'];

function input() {
  return {
    employeeNo: 'EMP-001',
    fullName: '张三',
    employmentType: 'full_time',
    employmentStartDate: '2026-01-01',
    departmentId: 'DEPT-TECH',
    departmentName: '研发部',
    positionName: '工程师',
    effectiveFrom: '2026-01-01',
  };
}

function actorOf(role) {
  return role === null
    ? { authenticated: true, operatorId: 'user-no-role' }
    : { authenticated: true, role, operatorId: `user-${role}` };
}

/** 建档一条含敏感可读数据的人员；返回仓储、路由选项与真实 personId。 */
function seed() {
  const store = new InMemoryPersonnelStore();
  let nextId = 0;
  const options = {
    idFactory: () => `person-${++nextId}`,
    clock: () => '2026-09-10T00:00:00.000Z',
    today: '2026-09-12',
  };
  const created = handlePersonnelRequest(store, { method: 'POST', path: '/persons', actor: HR, body: input() }, options);
  assert.equal(created.status, 201);
  return { store, options, personId: created.body.personId };
}

/** 契约 7 类人员维度操作（对应 openapi operationId 中除集合外的全部端点）。 */
function personScopedRequests(personId) {
  return [
    ['详情 GET', { method: 'GET', path: `/persons/${personId}` }],
    ['基础变更 PATCH', { method: 'PATCH', path: `/persons/${personId}`, body: { fullName: '越权改名' } }],
    ['删除 DELETE', { method: 'DELETE', path: `/persons/${personId}` }],
    ['任职新增 POST', {
      method: 'POST',
      path: `/persons/${personId}/assignments`,
      body: { departmentId: 'DEPT-PRIV', departmentName: '越权部门', positionName: '越权岗位', effectiveFrom: '2026-11-01' },
    }],
    ['任职撤销 POST', { method: 'POST', path: `/persons/${personId}/assignments/asg-not-visible/retract`, body: {} }],
    ['状态流转 POST', {
      method: 'POST',
      path: `/persons/${personId}/status-transitions`,
      body: { toStatus: 'inactive', reason: '越权停用', effectiveFrom: '2026-09-12' },
    }],
    ['历史 GET', { method: 'GET', path: `/persons/${personId}/history` }],
  ];
}

function assertOnlyErrorShape(body) {
  assert.deepEqual(Object.keys(body).sort(), ERROR_KEYS, '拒绝响应只能是契约 ErrorResponse 结构');
  for (const key of ['personId', 'fullName', 'employeeNo', 'contact', 'assignmentId', 'recordId', 'items', 'person']) {
    assert.equal(Object.hasOwn(body, key), false, `响应体不应包含人员字段 ${key}`);
  }
}

function assertNoPersonnelData(body) {
  assertOnlyErrorShape(body);
  const serialized = JSON.stringify(body);
  for (const marker of ['EMP-001', '张三', 'DEPT-TECH', '研发部', 'person-1', '越权']) {
    assert.equal(serialized.includes(marker), false, `响应体泄露人员数据：${marker}`);
  }
}

test('T-17/AC-008：非 HR 的集合查询与建档写操作返回 forbidden，且不含任何人员数据；未认证返回 401', () => {
  const { store, options } = seed();
  for (const role of [...NON_HR_ROLES, null]) {
    const actor = actorOf(role);
    const list = handlePersonnelRequest(store, { method: 'GET', path: '/persons?status=inactive&page=1&pageSize=5', actor }, options);
    const create = handlePersonnelRequest(store, { method: 'POST', path: '/persons', actor, body: input() }, options);
    assert.equal(list.status, 403, `role=${role} 的集合查询应被拒绝`);
    assert.equal(create.status, 403, `role=${role} 的建档写操作应被拒绝`);
    assert.equal(list.body.code, 'forbidden');
    assert.equal(create.body.code, 'forbidden');
    assertNoPersonnelData(list.body);
    assertNoPersonnelData(create.body);
    assert.equal(Object.hasOwn(list.body, 'items'), false);
    assert.equal(Object.hasOwn(create.body, 'personId'), false);
  }
  // 同一请求 HR 与匿名者的分类差异：HR 200 / 匿名 401 / 非 HR 403
  const hrList = handlePersonnelRequest(store, { method: 'GET', path: '/persons', actor: HR }, options);
  assert.equal(hrList.status, 200);
  assert.equal(hrList.body.items.length, 1);
  assert.equal(hrList.body.items[0].fullName, '张三');
  const { personId } = seed();
  for (const path of ['/persons', `/persons/${personId}`]) {
    const anonymous = handlePersonnelRequest(store, { method: 'GET', path, actor: { authenticated: false } }, options);
    assert.equal(anonymous.status, 401, `${path} 未认证应返回 401`);
    assert.equal(anonymous.body.code, 'unauthorized');
    assertNoPersonnelData(anonymous.body);
  }
});

test('T-17/AC-008：非 HR 的人员维度 7 类操作一律伪装为 not_found；无权与不存在深度相等，跨操作同码同构', () => {
  const { store, options, personId } = seed();
  for (const role of [...NON_HR_ROLES, null]) {
    const actor = actorOf(role);
    let reference = null;
    for (const [name, request] of personScopedRequests(personId)) {
      const denied = handlePersonnelRequest(store, { ...request, actor }, options);
      const ghost = handlePersonnelRequest(
        store,
        { ...request, actor, path: request.path.replace(personId, 'person-ghost') },
        options,
      );
      assert.equal(denied.status, 404, `${name} 对非 HR 应伪装为 404 而非 403`);
      assert.equal(denied.body.code, 'not_found');
      assertNoPersonnelData(denied.body);
      // 存在与不存在不可区分（不泄露存在性）
      assert.deepEqual(denied, ghost, `${name}：无权访问与记录不存在的响应必须深度相等`);
      if (reference === null) reference = denied;
      else assert.deepEqual(denied, reference, `${name}：人员维度拒绝响应应跨操作同码同结构`);
    }
  }
});

test('T-18/AC-008：门禁先于入参校验与用例执行；被拒写操作不改动仓储（不依赖界面隐藏）', () => {
  const { store, options, personId } = seed();
  const actor = actorOf('employee');
  const badCreate = handlePersonnelRequest(store, { method: 'POST', path: '/persons', actor, body: { nope: true } }, options);
  assert.equal(badCreate.status, 403, '集合写：门禁先于校验，返回 403 而非 400');
  assert.equal(badCreate.body.code, 'forbidden');
  const badPatch = handlePersonnelRequest(
    store,
    { method: 'PATCH', path: `/persons/${personId}`, actor, body: { idNumber: 'X', salary: 'Y' } },
    options,
  );
  assert.equal(badPatch.status, 404, '人员维度写：非法入参同样被伪装为 404，不泄露权限差异');
  assert.equal(badPatch.body.code, 'not_found');
  const badTransition = handlePersonnelRequest(
    store,
    { method: 'POST', path: `/persons/${personId}/status-transitions`, actor, body: '非法请求体' },
    options,
  );
  assert.equal(badTransition.status, 404);
  // 被拒请求未触达任何用例：仓储状态保持建档后的原样
  assert.equal(store.countPersons(), 1);
  assert.equal(store.countAssignments(), 1);
  const person = store.findPersonById(personId);
  assert.equal(person.full_name, '张三');
  assert.equal(person.status, 'active');
});

test('T-17/T-18：拒绝伪装与真实「记录不存在」同码同结构；requestId 原样透传', () => {
  const { store, options, personId } = seed();
  store.transaction((tx) =>
    tx.insertPerson({
      id: 'person-bare',
      employee_no: 'EMP-999',
      full_name: '待删除',
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
    }));
  const gateDenied = handlePersonnelRequest(store, { method: 'GET', path: `/persons/${personId}`, actor: actorOf('manager') }, options);
  const hrMissing = handlePersonnelRequest(store, { method: 'GET', path: '/persons/person-missing', actor: HR }, options);
  assert.equal(hrMissing.status, 404);
  assertOnlyErrorShape(hrMissing.body);
  assert.equal(hrMissing.body.code, gateDenied.body.code, '同码：not_found');
  assert.deepEqual(Object.keys(hrMissing.body).sort(), Object.keys(gateDenied.body).sort(), '同结构：字段集合一致');
  const traced = handlePersonnelRequest(store, { method: 'GET', path: '/persons', actor: actorOf('employee'), requestId: 'req-1' }, options);
  assert.equal(traced.status, 403);
  assert.equal(traced.body.requestId, 'req-1');
});

test('T-18：HR 经门禁后 7 类操作映射 200/201/204/409；入站校验映射 400、工号冲突映射 409', () => {
  const { store, options, personId } = seed();
  const detail = handlePersonnelRequest(store, { method: 'GET', path: `/persons/${personId}`, actor: HR }, options);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.fullName, '张三');
  const patched = handlePersonnelRequest(
    store,
    { method: 'PATCH', path: `/persons/${personId}`, actor: HR, body: { fullName: '张三丰' } },
    options,
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.fullName, '张三丰');
  const pending = handlePersonnelRequest(store, {
    method: 'POST',
    path: `/persons/${personId}/assignments`,
    actor: HR,
    body: { departmentId: 'DEPT-PROD', departmentName: '产品部', positionName: '产品经理', effectiveFrom: '2026-10-01' },
  }, options);
  assert.equal(pending.status, 201);
  assert.equal(pending.body.status, 'pending');
  const retracted = handlePersonnelRequest(
    store,
    { method: 'POST', path: `/persons/${personId}/assignments/${pending.body.assignmentId}/retract`, actor: HR },
    options,
  );
  assert.equal(retracted.status, 200);
  assert.equal(retracted.body.status, 'retracted');
  const history = handlePersonnelRequest(store, { method: 'GET', path: `/persons/${personId}/history`, actor: HR }, options);
  assert.equal(history.status, 200);
  assert.ok(history.body.total >= 8, `建档+变更+任职+撤销至少 8 条字段级记录，实际 ${history.body.total}`);
  const deactivated = handlePersonnelRequest(store, {
    method: 'POST',
    path: `/persons/${personId}/status-transitions`,
    actor: HR,
    body: { toStatus: 'inactive', reason: '本人离职', effectiveFrom: '2026-09-12' },
  }, options);
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.status, 'inactive');
  const blockedDelete = handlePersonnelRequest(store, { method: 'DELETE', path: `/persons/${personId}`, actor: HR }, options);
  assert.equal(blockedDelete.status, 409);
  assert.equal(blockedDelete.body.code, 'referenced_by_business');
  const invalid = handlePersonnelRequest(store, { method: 'POST', path: '/persons', actor: HR, body: {} }, options);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'validation_failed');
  assert.ok(Array.isArray(invalid.body.fieldErrors) && invalid.body.fieldErrors.length > 0);
  const duplicate = handlePersonnelRequest(store, { method: 'POST', path: '/persons', actor: HR, body: input() }, options);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'duplicate_employee_no');
  assert.equal(duplicate.body.conflictRef, 'EMP-001');
  store.transaction((tx) =>
    tx.insertPerson({
      id: 'person-bare',
      employee_no: 'EMP-999',
      full_name: '待删除',
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
    }));
  const removed = handlePersonnelRequest(store, { method: 'DELETE', path: '/persons/person-bare', actor: HR }, options);
  assert.equal(removed.status, 204);
  assert.equal(removed.body, undefined, '204 无响应体');
  const gone = handlePersonnelRequest(store, { method: 'GET', path: '/persons/person-bare', actor: HR }, options);
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, 'not_found');
});
