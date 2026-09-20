/** T-16：客户关键词查询用例（S-3；AC-004、AC-005）。 */

import type { FieldError } from '../domain/customer.js';
import type {
  CustomerRecord,
  CustomerRepository,
  CustomerSearchResult,
} from '../persistence/memory-customer-repository.js';

export interface SearchCustomerRequest {
  readonly keyword?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

export interface CustomerSummary {
  readonly customerId: string;
  readonly name: string;
  readonly contactPerson: string | null;
  readonly phone: string;
  readonly company: string | null;
  readonly updatedAt: string;
}

export interface CustomerPage {
  readonly items: readonly CustomerSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface SearchCustomerDependencies {
  readonly repository: Pick<CustomerRepository, 'search'>;
}

/** 查询参数错误；契约层映射为 400 并保留逐字段提示。 */
export class SearchCustomerValidationError extends Error {
  readonly fieldErrors: readonly FieldError[];

  constructor(fieldErrors: readonly FieldError[]) {
    super(`客户查询参数无效: ${fieldErrors.map((entry) => `${entry.field}(${entry.code})`).join(', ')}`);
    this.name = 'SearchCustomerValidationError';
    this.fieldErrors = Object.freeze(fieldErrors.map((entry) => ({ ...entry })));
  }
}

function fieldError(field: string, code: FieldError['code'], message: string): FieldError {
  return { field, code, message };
}

function normalizeRequest(input: unknown): Required<SearchCustomerRequest> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new SearchCustomerValidationError([
      fieldError('*', 'INVALID_FORMAT', '查询参数必须是对象。'),
    ]);
  }
  const source = input as Record<string, unknown>;
  const errors: FieldError[] = [];

  let keyword = '';
  if (source.keyword !== undefined) {
    if (typeof source.keyword !== 'string') {
      errors.push(fieldError('keyword', 'INVALID_FORMAT', '关键词必须是文本。'));
    } else {
      keyword = source.keyword.trim();
      if (keyword.length > 100) {
        errors.push(fieldError('keyword', 'TOO_LONG', '关键词长度不能超过 100 个字符。'));
      }
    }
  }

  const page = source.page === undefined ? 1 : source.page;
  if (!Number.isInteger(page) || (page as number) < 1) {
    errors.push(fieldError('page', 'INVALID_FORMAT', '页码必须是大于等于 1 的整数。'));
  }

  const pageSize = source.pageSize === undefined ? 20 : source.pageSize;
  if (!Number.isInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > 100) {
    errors.push(fieldError('pageSize', 'INVALID_FORMAT', '每页条数必须是 1 到 100 的整数。'));
  }

  if (errors.length > 0) throw new SearchCustomerValidationError(errors);
  return { keyword, page: page as number, pageSize: pageSize as number };
}

function toSummary(record: CustomerRecord): CustomerSummary {
  return {
    customerId: record.customer_id,
    name: record.name,
    contactPerson: record.contact_person,
    phone: record.phone,
    company: record.company,
    updatedAt: record.updated_at,
  };
}

function toPage(result: CustomerSearchResult): CustomerPage {
  return {
    items: result.items.map(toSummary),
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
  };
}

export async function searchCustomers(
  input: unknown,
  dependencies: SearchCustomerDependencies,
): Promise<CustomerPage> {
  const request = normalizeRequest(input);
  const result = await dependencies.repository.search(
    request.keyword,
    request.page,
    request.pageSize,
  );
  return toPage(result);
}

/** 单数别名，兼容按 operationId 命名的调用方。 */
export const searchCustomer = searchCustomers;
