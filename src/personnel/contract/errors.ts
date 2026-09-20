/**
 * 人员管理统一错误结构（T-01 / AC-001 / AC-009）。
 *
 * 与 `contracts/openapi.yaml` components.schemas.ErrorResponse 一一对应：
 * code（枚举）、中文 message、fieldErrors（{field,message}[]）、conflictRef（+ requestId）。
 * HTTP 状态映射沿用 architecture.md 的 Failure Model：
 * validation_failed→400；unauthorized→401；forbidden→403；not_found→404；
 * duplicate_employee_no / overlapping_assignment / invalid_report_line /
 * invalid_status_transition / not_yet_retractable / referenced_by_business / conflict→409；
 * internal_error→500。
 *
 * 契约按原文镜像，不静默改写：`not_yet_retractable` 的码名与「仅 pending 可撤销」语义相反，
 * 保留契约码名，实现为「变更已生效、不可撤销」时返回（见 tasks.md 契约核对与下方中文文案）。
 *
 * 运行约束：仅可擦除 TypeScript 语法（无 enum/装饰器/参数属性/namespace），
 * 相对导入带 `.ts` 后缀，供 Node 24 type stripping 直跑。
 */

/** ErrorResponse.code 的枚举值（契约原文，不静默改写）。 */
export type PersonnelErrorCode =
  | 'validation_failed'
  | 'duplicate_employee_no'
  | 'overlapping_assignment'
  | 'invalid_report_line'
  | 'invalid_status_transition'
  | 'not_yet_retractable'
  | 'referenced_by_business'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'internal_error';

export const PERSONNEL_ERROR_CODES: readonly PersonnelErrorCode[] = [
  'validation_failed',
  'duplicate_employee_no',
  'overlapping_assignment',
  'invalid_report_line',
  'invalid_status_transition',
  'not_yet_retractable',
  'referenced_by_business',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'internal_error',
] as const;

export function isPersonnelErrorCode(value: unknown): value is PersonnelErrorCode {
  return typeof value === 'string' && (PERSONNEL_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 各错误码的默认中文提示（R6：可理解中文；调用方可按上下文给出更具体的 message）。
 */
export const PERSONNEL_ERROR_MESSAGES: Readonly<Record<PersonnelErrorCode, string>> = {
  validation_failed: '输入校验未通过，请修正标出的字段后重试。',
  duplicate_employee_no: '工号已被占用：工号全表唯一且停用后不复用。',
  overlapping_assignment: '任职区间与该人员已有区间重叠，请调整生效日期。',
  invalid_report_line: '汇报关系不合法：不得自引用，上级须为在职人员，且不得形成环路。',
  invalid_status_transition: '状态流转不合法：仅允许 草稿 → 在职 → 停用 单向流转。',
  not_yet_retractable: '该任职变更已生效，不可撤销；请登记新的任职区间。',
  referenced_by_business: '该人员档案已被业务记录引用，不能物理删除；请改为停用。',
  unauthorized: '未认证或会话已失效，请重新登录。',
  forbidden: '无权限访问人员管理功能：仅 HR 管理员可操作。',
  not_found: '记录不存在或无权访问。',
  conflict: '操作与现有数据冲突，请刷新后重试。',
  internal_error: '服务暂时不可用，请稍后重试。',
};

/** 错误码到 HTTP 状态码的映射（architecture.md Failure Model；契约 responses 一致）。 */
export const PERSONNEL_ERROR_HTTP_STATUS: Readonly<Record<PersonnelErrorCode, number>> = {
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

/** fieldErrors 数组元素结构（契约 ErrorResponse.fieldErrors.items：required [field, message]）。 */
export interface FieldError {
  field: string;
  message: string;
}
export const FIELD_ERROR_FIELDS = ['field', 'message'] as const;
export const FIELD_ERROR_REQUIRED_FIELDS = ['field', 'message'] as const;

/** 契约 ErrorResponse：required [code, message]；其余为可选。 */
export interface ErrorResponse {
  code: PersonnelErrorCode;
  message: string;
  fieldErrors?: FieldError[] | null;
  conflictRef?: string | null;
  requestId?: string | null;
}
export const ERROR_RESPONSE_FIELDS = [
  'code',
  'message',
  'fieldErrors',
  'conflictRef',
  'requestId',
] as const;
export const ERROR_RESPONSE_REQUIRED_FIELDS = ['code', 'message'] as const;

export interface PersonnelErrorOptions {
  fieldErrors?: FieldError[];
  conflictRef?: string | null;
  requestId?: string | null;
}

/** 领域/用例层统一抛出的错误；HTTP 适配层据 code 映射状态码（见 PERSONNEL_ERROR_HTTP_STATUS）。 */
export class PersonnelError extends Error {
  readonly code: PersonnelErrorCode;
  readonly fieldErrors: FieldError[];
  readonly conflictRef: string | null;
  readonly requestId: string | null;

  constructor(code: PersonnelErrorCode, message?: string, options: PersonnelErrorOptions = {}) {
    super(message ?? PERSONNEL_ERROR_MESSAGES[code]);
    this.name = 'PersonnelError';
    this.code = code;
    this.fieldErrors = options.fieldErrors ?? [];
    this.conflictRef = options.conflictRef ?? null;
    this.requestId = options.requestId ?? null;
  }

  /** 对应契约 400 BadRequest：逐字段中文提示（AC-001 / R6）。 */
  static validationFailed(message: string, fieldErrors: FieldError[]): PersonnelError {
    return new PersonnelError('validation_failed', message, { fieldErrors });
  }

  /** 对应 AC-002 / R1：conflictRef 为被占用的工号。 */
  static duplicateEmployeeNo(employeeNo: string, message?: string): PersonnelError {
    return new PersonnelError(
      'duplicate_employee_no',
      message ?? `工号「${employeeNo}」已被占用；工号唯一且停用后不复用（R1）。`,
      { conflictRef: employeeNo },
    );
  }

  /** 对应 AC-005 / R3：conflictRef 为冲突的任职区间 id。 */
  static overlappingAssignment(assignmentId: string, message?: string): PersonnelError {
    return new PersonnelError(
      'overlapping_assignment',
      message ?? PERSONNEL_ERROR_MESSAGES.overlapping_assignment,
      { conflictRef: assignmentId },
    );
  }

  /** 对应 R4：自引用、上级非在职或汇报成环。 */
  static invalidReportLine(message?: string, conflictRef: string | null = null): PersonnelError {
    return new PersonnelError('invalid_report_line', message, { conflictRef });
  }

  /** 对应 R2 非法状态流转（如 草稿→停用、停用→在职）。 */
  static invalidStatusTransition(message?: string, conflictRef: string | null = null): PersonnelError {
    return new PersonnelError('invalid_status_transition', message, { conflictRef });
  }

  /** 契约码名保留；语义为「变更已生效，不可撤销」（R3，仅 pending 可撤销）。 */
  static notYetRetractable(assignmentId: string, message?: string): PersonnelError {
    return new PersonnelError('not_yet_retractable', message, { conflictRef: assignmentId });
  }

  /** 对应 AC-007 / R2：被业务引用的档案不可物理删除。 */
  static referencedByBusiness(conflictRef: string | null, message?: string): PersonnelError {
    return new PersonnelError('referenced_by_business', message, { conflictRef });
  }

  /** AC-008：已认证但非 HR 管理员；响应体不含任何人员数据。 */
  static forbidden(message?: string): PersonnelError {
    return new PersonnelError('forbidden', message);
  }

  /** AC-008：不存在与无权访问返回同构响应（同码同结构），不泄露存在性。 */
  static notFound(message?: string): PersonnelError {
    return new PersonnelError('not_found', message);
  }

  static unauthorized(message?: string): PersonnelError {
    return new PersonnelError('unauthorized', message);
  }

  static internalError(message?: string): PersonnelError {
    return new PersonnelError('internal_error', message);
  }

  /** 转为契约 ErrorResponse 结构（不含白名单外的字段）。 */
  toErrorResponse(): ErrorResponse {
    const response: ErrorResponse = {
      code: this.code,
      message: this.message,
    };
    response.fieldErrors =
      this.fieldErrors.length > 0
        ? this.fieldErrors.map((entry) => ({ field: entry.field, message: entry.message }))
        : null;
    response.conflictRef = this.conflictRef;
    response.requestId = this.requestId;
    return response;
  }
}

/** 按契约 ErrorResponse 结构直接构造响应体（适配层无异常路径时使用）。 */
export function toErrorResponse(input: {
  code: PersonnelErrorCode;
  message?: string;
  fieldErrors?: FieldError[] | null;
  conflictRef?: string | null;
  requestId?: string | null;
}): ErrorResponse {
  return new PersonnelError(input.code, input.message, {
    fieldErrors: input.fieldErrors ?? [],
    conflictRef: input.conflictRef ?? null,
    requestId: input.requestId ?? null,
  }).toErrorResponse();
}

/** 把「缺失/非法字段 + 中文提示」组装为 fieldErrors 列表（AC-001 逐条提示）。 */
export function toFieldErrors(entries: Readonly<Record<string, string>>): FieldError[] {
  return Object.keys(entries).map((field) => ({ field, message: entries[field] }));
}
