import type { PersonStatus, PersonSummary } from '../contract/dto.ts';
import { PersonnelError } from '../contract/errors.ts';
import { personDetailFromRows } from './service.ts';
import type { AssignmentRow, PersonnelDatabase, PersonRow } from './store.ts';

export interface RosterQuery {
  name?: string;
  employeeNo?: string;
  departmentId?: string;
  status?: PersonStatus;
  page?: number;
  pageSize?: number;
  asOf?: string;
}

export interface RosterPage {
  items: PersonSummary[];
  page: number;
  pageSize: number;
  total: number;
}

function asOfDate(value?: string): string {
  return value ?? new Date().toISOString().slice(0, 10);
}

function assertPagination(page: number, pageSize: number): void {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new PersonnelError('validation_failed', '分页参数不合法：page 必须从 1 开始，pageSize 须在 1–200 之间', {
      fieldErrors: [
        { field: 'page', message: '页码必须是大于等于 1 的整数' },
        { field: 'pageSize', message: '每页条数必须是 1–200 的整数' },
      ],
    });
  }
}

export function effectiveAssignment(
  assignments: readonly AssignmentRow[],
  personId: string,
  asOf: string,
): AssignmentRow | null {
  return (
    assignments
      .filter(
        (assignment) =>
          assignment.person_id === personId &&
          assignment.status !== 'retracted' &&
          assignment.effective_from <= asOf &&
          (assignment.effective_to === null || asOf < assignment.effective_to),
      )
      .sort((left, right) => right.effective_from.localeCompare(left.effective_from))[0] ?? null
  );
}

function toSummary(person: PersonRow, assignment: AssignmentRow | null): PersonSummary {
  const summary: PersonSummary = {
    personId: person.id,
    employeeNo: person.employee_no,
    fullName: person.full_name,
    status: person.status,
  };
  if (assignment !== null) {
    summary.departmentId = assignment.department_id;
    summary.departmentName = assignment.department_name;
    summary.positionName = assignment.position_name;
  }
  return summary;
}

export function listPersons(db: PersonnelDatabase, query: RosterQuery = {}): RosterPage {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  assertPagination(page, pageSize);
  const asOf = asOfDate(query.asOf);
  const status = query.status ?? 'active';
  const name = query.name?.trim().toLocaleLowerCase();
  const employeeNo = query.employeeNo?.trim().toLocaleLowerCase();
  const departmentId = query.departmentId?.trim().toLocaleLowerCase();
  const assignments = db.listAssignments();

  const filtered = db
    .listPersons()
    .filter((person) => person.status === status)
    .map((person) => ({ person, assignment: effectiveAssignment(assignments, person.id, asOf) }))
    .filter(({ person, assignment }) => {
      // 默认在册视图（以及显式 status=active）只展示当前基准日已生效的任职人员。
      // 在职但任职区间尚未开始或已结束的档案，不能进入在册结果。
      if (status === 'active' && assignment === null) return false;
      if (name !== undefined && !person.full_name.toLocaleLowerCase().includes(name)) return false;
      if (employeeNo !== undefined && !person.employee_no.toLocaleLowerCase().includes(employeeNo)) return false;
      if (
        departmentId !== undefined &&
        (assignment === null || !assignment.department_id.toLocaleLowerCase().includes(departmentId))
      ) {
        return false;
      }
      return true;
    });

  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize).map(({ person, assignment }) => toSummary(person, assignment)),
    page,
    pageSize,
    total: filtered.length,
  };
}

export function listAssignablePersons(db: PersonnelDatabase, asOf?: string): PersonSummary[] {
  const date = asOfDate(asOf);
  const assignments = db.listAssignments();
  return db
    .listPersons()
    .filter((person) => person.status === 'active')
    .map((person) => ({ person, assignment: effectiveAssignment(assignments, person.id, date) }))
    .filter(({ assignment }) => assignment !== null)
    .map(({ person, assignment }) => toSummary(person, assignment));
}

export function getPerson(db: PersonnelDatabase, personId: string, asOf?: string) {
  const person = db.findPersonById(personId);
  if (person === null) throw new PersonnelError('not_found', `人员档案 ${personId} 不存在`);
  const assignment = effectiveAssignment(db.listAssignments(), personId, asOfDate(asOf));
  return personDetailFromRows(person, assignment);
}
