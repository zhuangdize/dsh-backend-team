/** T-25：PATCH /api/v1/customers/{customerId} 更新端点（AC-006、AC-008）。 */

import { ERROR_CODES, HttpApiError, type CustomersApp, type RequestContext, type RouteResult } from './app.js';
import { CustomerNotFoundError } from '../application/get-customer.js';
import {
  CustomerVersionConflictError,
  UpdateCustomerValidationError,
  type UpdateCustomerInput,
  type UpdateCustomerResult,
} from '../application/update-customer.js';

export const UPDATE_CUSTOMER_PATH = '/api/v1/customers/{customerId}';

export type UpdateCustomerUseCase = (
  input: UpdateCustomerInput,
  context: Record<string, unknown>,
) => UpdateCustomerResult | Promise<UpdateCustomerResult>;

export interface UpdateCustomerRouteOptions {
  readonly useCase?: UpdateCustomerUseCase;
}

function parseIfMatch(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    throw new HttpApiError(412, ERROR_CODES.PRECONDITION_FAILED, '缺少 If-Match 版本条件。');
  }
  const value = raw.trim().replace(/^"|"$/g, '');
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new HttpApiError(412, ERROR_CODES.PRECONDITION_FAILED, 'If-Match 版本格式不正确。');
  }
  return Number(value);
}

function customerBody(result: UpdateCustomerResult): Record<string, unknown> {
  const snapshot = result.customer.snapshot();
  return {
    customerId: snapshot.customerId,
    name: snapshot.name,
    contactPerson: snapshot.contactPerson,
    phone: snapshot.phone,
    email: snapshot.email,
    company: snapshot.company,
    note: snapshot.note,
    version: snapshot.version,
    createdAt: snapshot.createdAt.toISOString(),
    updatedAt: snapshot.updatedAt.toISOString(),
    createdBy: { userId: snapshot.createdBy, displayName: snapshot.createdBy },
    updatedBy: { userId: snapshot.updatedBy, displayName: snapshot.updatedBy },
    recentChanges: result.changes,
  };
}

function updateValidationError(error: UpdateCustomerValidationError): HttpApiError {
  return new HttpApiError(422, ERROR_CODES.VALIDATION_ERROR, '输入未通过字段校验。', {
    fieldErrors: [...error.fieldErrors],
  });
}

function phoneTakenError(error: Record<string, unknown>): HttpApiError {
  const existing =
    error.existingCustomer !== null && typeof error.existingCustomer === 'object'
      ? (error.existingCustomer as Record<string, unknown>)
      : undefined;
  const existingName = typeof existing?.name === 'string' ? existing.name : null;
  return new HttpApiError(
    409,
    ERROR_CODES.CUSTOMER_PHONE_TAKEN,
    existingName === null
      ? '联系电话已被占用，未修改客户。'
      : `联系电话已被客户「${existingName}」占用，未修改客户。`,
    existing === undefined ? undefined : { details: { existingCustomer: existing } },
  );
}

export async function handleUpdateCustomer(
  customerId: string,
  body: unknown,
  context: RequestContext,
  options: UpdateCustomerRouteOptions = {},
): Promise<RouteResult> {
  if (options.useCase === undefined) {
    throw new HttpApiError(500, ERROR_CODES.INTERNAL_ERROR, '更新用例不可用（应用层 updateCustomer 未装配）。');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, '请求体必须是 JSON 对象。');
  }
  const expectedVersion = parseIfMatch(context.header('if-match'));
  try {
    const result = await options.useCase(
      { customerId, expectedVersion, patch: body as UpdateCustomerInput['patch'] },
      { requestId: context.requestId, principal: context.state.principal },
    );
    return {
      status: 200,
      headers: { ETag: `"${result.customer.version}"` },
      body: customerBody(result),
    };
  } catch (error) {
    if (error instanceof UpdateCustomerValidationError) throw updateValidationError(error);
    if (error instanceof CustomerNotFoundError) {
      throw new HttpApiError(404, ERROR_CODES.CUSTOMER_NOT_FOUND, '客户不存在。');
    }
    if (error instanceof CustomerVersionConflictError) {
      throw new HttpApiError(409, ERROR_CODES.CUSTOMER_VERSION_CONFLICT, error.message);
    }
    if (
      error !== null &&
      typeof error === 'object' &&
      (error as Record<string, unknown>).code === ERROR_CODES.CUSTOMER_PHONE_TAKEN
    ) {
      throw phoneTakenError(error as Record<string, unknown>);
    }
    throw error;
  }
}

export function createUpdateCustomerRoute(
  options: UpdateCustomerRouteOptions = {},
): { method: 'PATCH'; path: typeof UPDATE_CUSTOMER_PATH; handler: (context: RequestContext) => Promise<RouteResult> } {
  return {
    method: 'PATCH',
    path: UPDATE_CUSTOMER_PATH,
    handler: async (context) => handleUpdateCustomer(
      context.params.customerId ?? '',
      await context.readJson(),
      context,
      options,
    ),
  };
}

export function mountUpdateCustomerRoute(
  app: Pick<CustomersApp, 'addRoute'>,
  options: UpdateCustomerRouteOptions = {},
): void {
  const route = createUpdateCustomerRoute(options);
  app.addRoute(route.method, route.path, route.handler);
}
