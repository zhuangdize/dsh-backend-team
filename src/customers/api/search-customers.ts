/** T-17：GET /api/v1/customers 查询端点（S-3；AC-004、AC-005）。 */

import { ERROR_CODES, HttpApiError, type CustomersApp, type RequestContext, type RouteResult } from './app.js';
import {
  SearchCustomerValidationError,
  type CustomerPage,
  type SearchCustomerRequest,
} from '../application/search-customers.js';

export const SEARCH_CUSTOMERS_PATH = '/api/v1/customers';

export type SearchCustomerUseCase = (
  input: SearchCustomerRequest,
  context: Record<string, unknown>,
) => CustomerPage | Promise<CustomerPage>;

export interface SearchCustomersRouteOptions {
  readonly useCase?: SearchCustomerUseCase;
}

function queryError(field: string, message: string): SearchCustomerValidationError {
  return new SearchCustomerValidationError([{ field, code: 'INVALID_FORMAT', message }]);
}

function parsePositiveInteger(
  name: 'page' | 'pageSize',
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw queryError(name, `${name === 'page' ? '页码' : '每页条数'}必须是整数。`);
  }
  const value = Number(raw);
  const valid = name === 'page' ? value >= 1 : value >= 1 && value <= 100;
  if (!Number.isSafeInteger(value) || !valid) {
    throw queryError(
      name,
      name === 'page'
        ? '页码必须是大于等于 1 的整数。'
        : '每页条数必须是 1 到 100 的整数。',
    );
  }
  return value;
}

export function parseSearchQuery(query: Record<string, string>): SearchCustomerRequest {
  const keyword = query.keyword ?? '';
  if (keyword.length > 100) {
    throw queryError('keyword', '关键词长度不能超过 100 个字符。');
  }
  return {
    keyword: keyword.trim(),
    page: parsePositiveInteger('page', query.page, 1),
    pageSize: parsePositiveInteger('pageSize', query.pageSize, 20),
  };
}

function validationErrorOutcome(error: SearchCustomerValidationError): HttpApiError {
  return new HttpApiError(400, ERROR_CODES.BAD_REQUEST, '查询参数无效。', {
    fieldErrors: [...error.fieldErrors],
  });
}

export async function handleSearchCustomers(
  query: Record<string, string>,
  context: RequestContext,
  options: SearchCustomersRouteOptions = {},
): Promise<RouteResult> {
  const useCase = options.useCase;
  if (useCase === undefined) {
    throw new HttpApiError(
      500,
      ERROR_CODES.INTERNAL_ERROR,
      '查询用例不可用（应用层 searchCustomers 未装配）。',
    );
  }
  let input: SearchCustomerRequest;
  try {
    input = parseSearchQuery(query);
    const body = await useCase(input, {
      requestId: context.requestId,
      principal: context.state.principal,
    });
    return { status: 200, body };
  } catch (error) {
    if (error instanceof SearchCustomerValidationError) {
      throw validationErrorOutcome(error);
    }
    throw error;
  }
}

export function createSearchCustomersRoute(
  options: SearchCustomersRouteOptions = {},
): { method: 'GET'; path: typeof SEARCH_CUSTOMERS_PATH; handler: (context: RequestContext) => Promise<RouteResult> } {
  return {
    method: 'GET',
    path: SEARCH_CUSTOMERS_PATH,
    handler: (context) => handleSearchCustomers(context.query, context, options),
  };
}

/** 将查询端点挂载到既有 loopback 应用。 */
export function mountSearchCustomersRoute(
  app: Pick<CustomersApp, 'addRoute'>,
  options: SearchCustomersRouteOptions = {},
): void {
  const route = createSearchCustomersRoute(options);
  app.addRoute(route.method, route.path, route.handler);
}
