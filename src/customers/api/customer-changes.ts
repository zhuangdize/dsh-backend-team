/** T-30：GET /api/v1/customers/{customerId}/changes 变更历史端点。 */

import { ERROR_CODES, HttpApiError, type CustomersApp, type RequestContext, type RouteResult } from './app.js';
import { CustomerNotFoundError } from '../application/get-customer.js';
import type { CustomerChangePage } from '../application/list-changes.js';

export const CUSTOMER_CHANGES_PATH = '/api/v1/customers/{customerId}/changes';

export type ListChangesUseCase = (
  customerId: string,
  page: number,
  pageSize: number,
  context: Record<string, unknown>,
) => CustomerChangePage | Promise<CustomerChangePage>;

export interface CustomerChangesRouteOptions {
  readonly useCase?: ListChangesUseCase;
}

function parseInteger(name: 'page' | 'pageSize', raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, `${name} 参数必须是整数。`);
  }
  const value = Number(raw);
  const valid = name === 'page' ? value >= 1 : value >= 1 && value <= 100;
  if (!Number.isSafeInteger(value) || !valid) {
    throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, `${name} 参数超出允许范围。`);
  }
  return value;
}

export async function handleCustomerChanges(
  customerId: string,
  context: RequestContext,
  options: CustomerChangesRouteOptions = {},
): Promise<RouteResult> {
  if (options.useCase === undefined) {
    throw new HttpApiError(500, ERROR_CODES.INTERNAL_ERROR, '变更历史用例不可用。');
  }
  try {
    const page = parseInteger('page', context.query.page, 1);
    const pageSize = parseInteger('pageSize', context.query.pageSize, 20);
    const body = await options.useCase(customerId, page, pageSize, {
      requestId: context.requestId,
      principal: context.state.principal,
    });
    return { status: 200, body };
  } catch (error) {
    if (error instanceof CustomerNotFoundError) {
      throw new HttpApiError(404, ERROR_CODES.CUSTOMER_NOT_FOUND, '客户不存在。');
    }
    if (error instanceof Error && /^(page|pageSize) /.test(error.message)) {
      throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, error.message);
    }
    throw error;
  }
}

export function createCustomerChangesRoute(
  options: CustomerChangesRouteOptions = {},
): { method: 'GET'; path: typeof CUSTOMER_CHANGES_PATH; handler: (context: RequestContext) => Promise<RouteResult> } {
  return {
    method: 'GET',
    path: CUSTOMER_CHANGES_PATH,
    handler: (context) => handleCustomerChanges(context.params.customerId ?? '', context, options),
  };
}

export function mountCustomerChangesRoute(
  app: Pick<CustomersApp, 'addRoute'>,
  options: CustomerChangesRouteOptions = {},
): void {
  const route = createCustomerChangesRoute(options);
  app.addRoute(route.method, route.path, route.handler);
}
