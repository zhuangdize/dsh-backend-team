import { PersonnelError } from '../contract/errors.ts';
import type { PersonnelTransaction } from './store.ts';

/**
 * R1 工号守护：停用档案仍保留在 person 表，因此同一工号永远不可再次占用。
 * 该检查放在用例事务内，数据库 UNIQUE 约束作为并发场景的最终兜底。
 */
export function assertEmployeeNoAvailable(tx: PersonnelTransaction, employeeNo: string): void {
  const existing = tx.findPersonByEmployeeNo(employeeNo);
  if (existing !== null) throw PersonnelError.duplicateEmployeeNo(employeeNo);
}

export function employeeNoCanBeReused(tx: PersonnelTransaction, employeeNo: string): boolean {
  return tx.findPersonByEmployeeNo(employeeNo) === null;
}
