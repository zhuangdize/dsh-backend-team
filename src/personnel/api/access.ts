import type { ErrorResponse } from '../contract/errors.ts';
import { PersonnelError } from '../contract/errors.ts';

export interface PersonnelActor {
  authenticated: boolean;
  role?: string | null;
  operatorId?: string;
  operatorName?: string;
}

export function isHrAdmin(actor: PersonnelActor): boolean {
  return actor.authenticated && actor.role === 'hr_admin';
}

function unauthorized(): PersonnelError {
  return new PersonnelError('unauthorized', '请先完成身份认证');
}

function forbidden(): PersonnelError {
  return new PersonnelError('forbidden', '当前账号没有人员管理权限');
}

function notFound(): PersonnelError {
  return new PersonnelError('not_found', '人员资源不存在');
}

/** 集合查询与写操作：非 HR 统一返回 403，不携带人员数据。 */
export function requireHrCollection(actor: PersonnelActor): void {
  if (!actor.authenticated) throw unauthorized();
  if (!isHrAdmin(actor)) throw forbidden();
}

/** 人员维度资源：非 HR 统一伪装为 404，避免泄露记录是否存在。 */
export function requireHrPersonResource(actor: PersonnelActor): void {
  if (!actor.authenticated) throw unauthorized();
  if (!isHrAdmin(actor)) throw notFound();
}

export const PERSONNEL_HTTP_STATUS: Readonly<Record<string, number>> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  duplicate_employee_no: 409,
  overlapping_assignment: 409,
  invalid_report_line: 409,
  invalid_status_transition: 409,
  not_yet_retractable: 409,
  referenced_by_business: 409,
  conflict: 409,
  internal_error: 500,
};

export function personnelErrorResponse(error: unknown, requestId?: string): { status: number; body: ErrorResponse } {
  const personnelError = error instanceof PersonnelError ? error : new PersonnelError('internal_error', '服务暂时不可用');
  const body = personnelError.toErrorResponse();
  if (requestId !== undefined) body.requestId = requestId;
  return { status: PERSONNEL_HTTP_STATUS[personnelError.code] ?? 500, body };
}
