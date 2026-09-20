/** T-29：客户变更历史分页读取（S-5；AC-009）。 */

import type { ChangeLogEntry } from '../domain/changelog.js';
import { CustomerNotFoundError } from './get-customer.js';
import type { CustomerChangeLogStore, CustomerRepository } from '../persistence/memory-customer-repository.js';

export interface CustomerChangePage {
  readonly items: readonly ChangeLogEntry[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface ListChangesDependencies {
  readonly repository: Pick<CustomerRepository, 'findById'> & CustomerChangeLogStore;
}

export async function listChanges(
  customerId: string,
  page: number,
  pageSize: number,
  dependencies: ListChangesDependencies,
): Promise<CustomerChangePage> {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error('page must be an integer >= 1');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('pageSize must be an integer from 1 to 100');
  }
  const customer = await dependencies.repository.findById(customerId);
  if (customer === null) throw new CustomerNotFoundError(customerId);
  const all = await dependencies.repository.listChanges(customerId);
  const start = (page - 1) * pageSize;
  return {
    items: all.slice(start, start + pageSize).map((entry) => ({ ...entry })),
    page,
    pageSize,
    total: all.length,
  };
}
