import test from 'node:test';
import assert from 'node:assert/strict';

import { deletePerson, listPersonHistory } from '../src/personnel/domain/lifecycle.ts';
import { createPerson, updatePerson } from '../src/personnel/domain/service.ts';
import { transitionPersonStatus } from '../src/personnel/domain/status.ts';
import { InMemoryPersonnelStore } from '../src/personnel/domain/store.ts';

function input(employeeNo = 'EMP-001') {
  return {
    employeeNo,
    fullName: '张三',
    employmentType: 'full_time',
    employmentStartDate: '2026-01-01',
    departmentId: 'DEPT-TECH',
    departmentName: '研发部',
    positionName: '工程师',
    effectiveFrom: '2026-01-01',
  };
}

function context() {
  let id = 0;
  return {
    idFactory: () => `id-${++id}`,
    clock: () => '2026-09-10T00:00:00.000Z',
    operatorId: 'hr-1',
    deleteAuthorized: true,
  };
}

test('AC-010：新增、变更、停用均可按人员查到操作人、时间、前后值与生效期间', () => {
  const store = new InMemoryPersonnelStore();
  const ctx = context();
  const person = createPerson(store, input(), ctx);
  updatePerson(store, person.personId, { fullName: '李四' }, ctx);
  transitionPersonStatus(store, person.personId, { toStatus: 'inactive', reason: '离职', effectiveFrom: '2026-09-10' }, ctx);

  const page = listPersonHistory(store, person.personId);
  assert.ok(page.total >= 3);
  assert.ok(page.items.every((item) => item.operatorId === 'hr-1' && item.occurredAt === '2026-09-10T00:00:00.000Z'));
  assert.ok(page.items.some((item) => item.action === 'create'));
  assert.ok(page.items.some((item) => item.action === 'update' && item.fieldName === 'fullName' && item.oldValue === '张三' && item.newValue === '李四'));
  assert.ok(page.items.some((item) => item.action === 'status_change' && item.effectiveFrom === '2026-09-10'));
});

test('AC-007：有业务引用时拒绝物理删除并保留档案；无引用且获授权时允许删除', () => {
  const store = new InMemoryPersonnelStore();
  const ctx = context();
  const referenced = createPerson(store, input('EMP-001'), ctx);
  assert.throws(() => deletePerson(store, referenced.personId, { ...ctx, isReferenced: () => true }), (error) => error.code === 'referenced_by_business');
  assert.ok(store.findPersonById(referenced.personId));
  assert.ok(store.listChangeRecords(referenced.personId).some((record) => record.action === 'delete_attempt'));

  const free = new InMemoryPersonnelStore();
  const id = 'free-person';
  free.insertPerson({
    id,
    employee_no: 'EMP-FREE',
    full_name: '无任职人员',
    mobile: null,
    email: null,
    employment_type: 'full_time',
    employment_start_date: '2026-01-01',
    employment_end_date: null,
    status: 'inactive',
    deactivated_on: '2026-09-10',
    deactivation_reason: '测试',
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
  });
  deletePerson(free, id, { ...ctx, isReferenced: () => false });
  assert.equal(free.findPersonById(id), null);
});

test('R2：拒绝 draft→inactive 与 inactive→active，只允许单向流转', () => {
  const store = new InMemoryPersonnelStore();
  const ctx = context();
  const id = 'draft-person';
  store.insertPerson({
    id,
    employee_no: 'EMP-DRAFT',
    full_name: '草稿人员',
    mobile: null,
    email: null,
    employment_type: 'full_time',
    employment_start_date: '2026-01-01',
    employment_end_date: null,
    status: 'draft',
    deactivated_on: null,
    deactivation_reason: null,
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
  });
  assert.throws(() => transitionPersonStatus(store, id, { toStatus: 'inactive', reason: '离职', effectiveFrom: '2026-09-10' }, ctx), (error) => error.code === 'invalid_status_transition');
  transitionPersonStatus(store, id, { toStatus: 'active', effectiveFrom: '2026-09-10' }, ctx);
  transitionPersonStatus(store, id, { toStatus: 'inactive', reason: '离职', effectiveFrom: '2026-09-10' }, ctx);
  assert.throws(() => transitionPersonStatus(store, id, { toStatus: 'active', effectiveFrom: '2026-09-11' }, ctx), (error) => error.code === 'invalid_status_transition');
});
