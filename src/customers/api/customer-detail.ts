/** T-23：GET /api/v1/customers/{customerId} 详情端点（AC-007、AC-009）。 */

import { ERROR_CODES, HttpApiError, type CustomersApp, type RequestContext, type RouteResult } from './app.js';
import { CustomerNotFoundError, type CustomerDetail } from '../application/get-customer.js';

export const CUSTOMER_DETAIL_PATH = '/api/v1/customers/{customerId}';

export type GetCustomerUseCase = (
  customerId: string,
  context: Record<string, unknown>,
) => CustomerDetail | Promise<CustomerDetail>;

export interface CustomerDetailRouteOptions {
  readonly useCase?: GetCustomerUseCase;
}

export async function handleCustomerDetail(
  customerId: string,
  context: RequestContext,
  options: CustomerDetailRouteOptions = {},
): Promise<RouteResult> {
  if (options.useCase === undefined) {
    throw new HttpApiError(
      500,
      ERROR_CODES.INTERNAL_ERROR,
      '详情用例不可用（应用层 getCustomer 未装配）。',
    );
  }
  try {
    const body = await options.useCase(customerId, {
      requestId: context.requestId,
      principal: context.state.principal,
    });
    return { status: 200, headers: { ETag: `"${body.version}"` }, body };
  } catch (error) {
    if (error instanceof CustomerNotFoundError) {
      throw new HttpApiError(404, ERROR_CODES.CUSTOMER_NOT_FOUND, '客户不存在。');
    }
    throw error;
  }
}

export function createCustomerDetailRoute(
  options: CustomerDetailRouteOptions = {},
): { method: 'GET'; path: typeof CUSTOMER_DETAIL_PATH; handler: (context: RequestContext) => Promise<RouteResult> } {
  return {
    method: 'GET',
    path: CUSTOMER_DETAIL_PATH,
    handler: (context) => handleCustomerDetail(context.params.customerId ?? '', context, options),
  };
}

export function mountCustomerDetailRoute(
  app: Pick<CustomersApp, 'addRoute'>,
  options: CustomerDetailRouteOptions = {},
): void {
  const route = createCustomerDetailRoute(options);
  app.addRoute(route.method, route.path, route.handler);
}
