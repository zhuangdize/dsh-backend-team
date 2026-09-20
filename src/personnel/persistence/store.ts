/**
 * 人员持久化边界（T-15）。
 *
 * 业务用例依赖 `PersonnelDatabase`，宿主可以把 Drizzle transaction 适配成
 * `PersonnelPersistenceDriver` 后注入本类；人员模块不直接持有连接串、凭据或
 * SQL 执行器，避免把数据库生命周期耦合进领域层。
 *
 * 该适配器刻意保持同步端口，与当前 Node 24 的内存 domain evidence 一致。
 * 真实 Drizzle 适配应在宿主已有数据库执行边界内实现 `PersonnelPersistenceDriver`，
 * 并把 change_record 的写操作限制为 INSERT。
 */

import type {
  AssignmentRow,
  ChangeRecordRow,
  PersonnelDatabase,
  PersonnelTransaction,
  PersonRow,
} from '../domain/store.ts';

export interface PersonnelPersistenceDriver extends PersonnelTransaction {
  transaction<T>(fn: (tx: PersonnelTransaction) => T): T;
}

export class PersonnelPersistenceStore implements PersonnelDatabase {
  constructor(private readonly driver: PersonnelPersistenceDriver) {}

  transaction<T>(fn: (tx: PersonnelTransaction) => T): T {
    return this.driver.transaction(fn);
  }

  insertPerson(row: PersonRow): void {
    this.driver.insertPerson(row);
  }

  insertAssignment(row: AssignmentRow): void {
    this.driver.insertAssignment(row);
  }

  updatePerson(row: PersonRow): void {
    this.driver.updatePerson(row);
  }

  updateAssignment(row: AssignmentRow): void {
    this.driver.updateAssignment(row);
  }

  insertChangeRecord(row: ChangeRecordRow): void {
    this.driver.insertChangeRecord(row);
  }

  deletePerson(id: string): void {
    this.driver.deletePerson(id);
  }

  findPersonById(id: string): PersonRow | null {
    return this.driver.findPersonById(id);
  }

  findPersonByEmployeeNo(employeeNo: string): PersonRow | null {
    return this.driver.findPersonByEmployeeNo(employeeNo);
  }

  findAssignmentById(id: string): AssignmentRow | null {
    return this.driver.findAssignmentById(id);
  }

  listPersons(): PersonRow[] {
    return this.driver.listPersons();
  }

  listAssignmentsByPerson(personId: string): AssignmentRow[] {
    return this.driver.listAssignmentsByPerson(personId);
  }

  listAssignments(): AssignmentRow[] {
    return this.driver.listAssignments();
  }

  listChangeRecords(personId: string): ChangeRecordRow[] {
    return this.driver.listChangeRecords(personId);
  }

  countPersons(): number {
    return this.driver.countPersons();
  }

  countAssignments(): number {
    return this.driver.countAssignments();
  }
}
