/** T-22：按客户编号读取详情（S-4；AC-007、AC-009）。 */

import type { CustomerRepository, CustomerRecord } from '../persistence/memory-customer-repository.js';
import type { ChangeLogEntry } from '../domain/changelog.js';

export interface CustomerDetail {
  readonly customerId: string;
  readonly name: string;
  readonly contactPerson: string | null;
  readonly phone: string;
  readonly email: string | null;
  readonly company: string | null;
  readonly note: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly recentChanges: readonly ChangeLogEntry[];
}

export interface GetCustomerDependencies {
  readonly repository: Pick<CustomerRepository, 'findById'>;
  readonly recentChanges?: (customerId: string) => readonly ChangeLogEntry[] | Promise<readonly ChangeLogEntry[]>;
}

export class CustomerNotFoundError extends Error {
  readonly code = 'CUSTOMER_NOT_FOUND';
  readonly customerId: string;

  constructor(customerId: string) {
    super(`客户 "${customerId}" 不存在。`);
    this.name = 'CustomerNotFound';
    this.customerId = customerId;
  }
}

function toDetail(record: CustomerRecord, recentChanges: readonly ChangeLogEntry[]): CustomerDetail {
  return {
    customerId: record.customer_id,
    name: record.name,
    contactPerson: record.contact_person,
    phone: record.phone,
    email: record.email,
    company: record.company,
    note: record.note,
    version: record.version,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    createdBy: record.created_by,
    updatedBy: record.updated_by,
    recentChanges: [...recentChanges],
  };
}

export async function getCustomer(
  customerId: string,
  dependencies: GetCustomerDependencies,
): Promise<CustomerDetail> {
  if (typeof customerId !== 'string' || customerId.trim() === '') {
    throw new CustomerNotFoundError(String(customerId));
  }
  const record = await dependencies.repository.findById(customerId);
  if (record === null) throw new CustomerNotFoundError(customerId);
  const recentChanges = dependencies.recentChanges === undefined
    ? []
    : await dependencies.recentChanges(customerId);
  return toDetail(record, recentChanges);
}
