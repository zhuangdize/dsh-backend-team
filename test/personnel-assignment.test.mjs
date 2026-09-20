import test from 'node:test';
import assert from 'node:assert/strict';

import { applyDueAssignments, createAssignment, retractAssignment } from '../src/personnel/domain/assignment.ts';
import { getPerson } from '../src/personnel/domain/roster.ts';
import { createPerson } from '../src/personnel/domain/service.ts';
import { transitionPersonStatus } from '../src/personnel/domain/status.ts';
import { InMemoryPersonnelStore } from '../src/personnel/domain/store.ts';

function input(employeeNo, fullName, overrides = {}) {
  return {
    employeeNo,
    fullName,
    employmentType: 'full_time',
    employmentStartDate: '2026-01-01',
    departmentId: 'DEPT-TECH',
    departmentName: '研发部',
    positionName: '工程师',
    effectiveFrom: '2026-01-01',
    ...overrides,
  };
}

function context(overrides = {}) {
  let id = 0;
  return {
    idFactory: () => `id-${++id}`,
    clock: () => '2026-09-10T00:00:00.000Z',
    today: '2026-09-10',
    operatorId: 'hr-1',
    ...overrides,
  };
}

test('AC-004：未来调岗推进后显示新组织岗位，旧区间关闭且历史含前后值与生效期间', () => {
  const store = new InMemoryPersonnelStore();
  const ctx = context();
  const person = createPerson(store, input('EMP-001', '张三'), ctx);
  const manager = createPerson(store, input('EMP-002', '李四'), ctx);
  const next = createAssignment(store, person.personId, {
    departmentId: 'DEPT-PRODUCT',
    departmentName: '产品部',
    positionName: '产品工程师',
    effectiveFrom: '2026-10-01',
    reportsToPersonId: manager.personId,
  }, ctx);
  assert.equal(next.status, 'pending');

  applyDueAssignments(store, '2026-10-01', ctx);
  const detail = getPerson(store, person.personId, '2026-10-02');
  assert.equal(detail.currentAssignment.departmentId, 'DEPT-PRODUCT');
  assert.equal(detail.currentAssignment.positionName, '产品工程师');
  assert.equal(detail.currentAssignment.reportsToPersonId, manager.personId);
  const closed = store.listAssignmentsByPerson(person.personId).find((row) => row.id !== next.assignmentId);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.effective_to, '2026-10-01');
  const history = store.listChangeRecords(person.personId).filter((record) => record.action === 'assignment_change');
  assert.ok(history.some((record) => record.field_name === 'departmentId' && record.old_value === 'DEPT-TECH' && record.new_value === 'DEPT-PRODUCT' && record.effective_from === '2026-10-01'));
  assert.ok(history.some((record) => record.field_name === 'positionName' && record.old_value === '工程师' && record.new_value === '产品工程师' && record.effective_from === '2026-10-01'));
  assert.ok(history.some((record) => record.field_name === 'reportsToPersonId' && record.old_value === null && record.new_value === manager.personId && record.effective_from === '2026-10-01'));
});

test('AC-005：既有区间 [2026-01-01,2026-03-31] 上提交重叠的 [2026-03-15,2026-04-30] 被拒，conflictRef 指向冲突区间 id', () => {
  const store = new InMemoryPersonnelStore();
  const ctx = context({ clock: () => '2025-12-01T00:00:00.000Z', today: '2025-12-01' });
  const person = createPerson(store, input('EMP-001', '张三', { employmentStartDate: '2025-12-01', effectiveFrom: '2025-12-01' }), ctx);
  const existing = createAssignment(store, person.personId, {
    departmentId: 'DEPT-A',
    departmentName: 'A 部门',
    positionName: 'A 岗位',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-03-31',
  }, ctx);
  assert.equal(existing.status, 'pending');
  assert.throws(() => createAssignment(store, person.personId, {
    departmentId: 'DEPT-B',
    departmentName: 'B 部门',
    positionName: 'B 岗位',
    effectiveFrom: '2026-03-15',
    effectiveTo: '2026-04-30',
  }, ctx), (error) => error.code === 'overlapping_assignment' && error.conflictRef === existing.assignmentId);
  // 与被拒区间不重叠的后续区间仍可登记
  const after = createAssignment(store, person.personId, {
    departmentId: 'DEPT-C',
    departmentName: 'C 部门',
    positionName: 'C 岗位',
    effectiveFrom: '2026-04-01',
    effectiveTo: '2026-06-30',
  }, ctx);
  assert.equal(after.status, 'pending');
});

test('R4：禁止自引用、A→B→A 汇报环与不在可指派集合的上级，且仅 pending 任职可撤销', () => {
  const store = new InMemoryPersonnelStore();
  const ctx = context();
  const a = createPerson(store, input('EMP-001', '甲'), ctx);
  const b = createPerson(store, input('EMP-002', '乙'), ctx);
  assert.throws(() => createAssignment(store, a.personId, {
    departmentId: 'DEPT-A', departmentName: 'A 部门', positionName: 'A 岗位', effectiveFrom: '2026-09-10', reportsToPersonId: a.personId,
  }, ctx), (error) => error.code === 'invalid_report_line');
  createAssignment(store, b.personId, {
    departmentId: 'DEPT-B', departmentName: 'B 部门', positionName: 'B 岗位', effectiveFrom: '2026-09-10', reportsToPersonId: a.personId,
  }, ctx);
  assert.throws(() => createAssignment(store, a.personId, {
    departmentId: 'DEPT-A2', departmentName: 'A2 部门', positionName: 'A2 岗位', effectiveFrom: '2026-09-10', reportsToPersonId: b.personId,
  }, ctx), (error) => error.code === 'invalid_report_line');

  // 上级必须是可指派集合（在册在职人员）：不存在的 id 与停用人员均被拒
  assert.throws(() => createAssignment(store, a.personId, {
    departmentId: 'DEPT-G', departmentName: 'G 部门', positionName: 'G 岗位', effectiveFrom: '2026-09-10', reportsToPersonId: 'ghost-person-id',
  }, ctx), (error) => error.code === 'invalid_report_line');
  const c = createPerson(store, input('EMP-003', '丙'), ctx);
  transitionPersonStatus(store, c.personId, { toStatus: 'inactive', effectiveFrom: '2026-09-10', reason: '离职' }, ctx);
  assert.throws(() => createAssignment(store, a.personId, {
    departmentId: 'DEPT-I', departmentName: 'I 部门', positionName: 'I 岗位', effectiveFrom: '2026-09-10', reportsToPersonId: c.personId,
  }, ctx), (error) => error.code === 'invalid_report_line');

  const pending = createAssignment(store, a.personId, {
    departmentId: 'DEPT-FUTURE', departmentName: '未来部门', positionName: '未来岗位', effectiveFrom: '2027-01-01',
  }, ctx);
  assert.equal(retractAssignment(store, a.personId, pending.assignmentId, ctx).status, 'retracted');
  assert.throws(() => retractAssignment(store, a.personId, a.currentAssignment.assignmentId, ctx), (error) => error.code === 'not_yet_retractable');
});
