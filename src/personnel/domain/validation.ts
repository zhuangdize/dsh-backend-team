/**
 * 建档入参纯函数校验（T-02 / R6 / AC-001）。
 *
 * 规则：
 * - 8 个必填字段（employeeNo/fullName/employmentType/employmentStartDate/
 *   departmentId/departmentName/positionName/effectiveFrom）缺失时逐条输出中文提示；
 * - 长度：employeeNo 1–32，fullName 1–64，departmentId/departmentName/positionName ≤64；
 * - employmentType 必须为契约枚举值；
 * - 日期须为 YYYY-MM-DD 且为真实历法日期；employmentEndDate 不得早于 employmentStartDate；
 * - contact.mobile ≤32，contact.email 须为合法邮箱格式；
 * - 字段白名单之外（尤其敏感字段，Q4/AC-009）一律拒绝；
 * - 任一失败整体结果为 validation_failed（由调用方转 400）。
 */

import {
  EMPLOYMENT_TYPES,
  PERSON_CREATE_REQUEST_FIELDS,
  CONTACT_INFO_FIELDS,
  isForbiddenSensitiveFieldName,
  type ContactInfo,
  type EmploymentType,
  type PersonCreateRequest,
} from '../contract/dto.ts';
import type { FieldError } from '../contract/errors.ts';

export type ValidationOutcome =
  | { ok: true; value: PersonCreateRequest }
  | { ok: false; code: 'validation_failed'; message: string; fieldErrors: FieldError[] };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REQUIRED_FIELD_LABELS: Readonly<Record<string, string>> = {
  employeeNo: '工号',
  fullName: '姓名',
  employmentType: '雇佣类型',
  employmentStartDate: '雇佣开始日期',
  departmentId: '部门标识',
  departmentName: '部门名称',
  positionName: '岗位名称',
  effectiveFrom: '任职生效日期',
};

export function isIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missing(field: string): FieldError {
  return { field, message: `${REQUIRED_FIELD_LABELS[field] ?? field}（${field}）为必填项，不能缺失或为空` };
}

/** 取必填字符串字段：缺失/非字符串/空白返回 undefined，并记入逐条中文错误。 */
function requiredString(source: Record<string, unknown>, field: string, errors: FieldError[]): string | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) {
    errors.push(missing(field));
    return undefined;
  }
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${REQUIRED_FIELD_LABELS[field] ?? field}（${field}）必须是字符串` });
    return undefined;
  }
  if (raw.trim() === '') {
    errors.push(missing(field));
    return undefined;
  }
  return raw;
}

function checkMaxLength(value: string, field: string, max: number, label: string, errors: FieldError[]): void {
  if (value.length > max) {
    errors.push({ field, message: `${label}（${field}）长度不能超过 ${max} 个字符（当前 ${value.length}）` });
  }
}

function optionalNullableString(
  source: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): string | null | undefined {
  const raw = source[field];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    errors.push({ field: `contact.${field}`, message: `联系方式字段（contact.${field}）必须是字符串或 null` });
    return undefined;
  }
  return raw;
}

function validateContact(rawContact: unknown, errors: FieldError[]): ContactInfo | undefined {
  if (rawContact === undefined || rawContact === null) return undefined;
  if (!isPlainObject(rawContact)) {
    errors.push({ field: 'contact', message: '联系方式（contact）必须是对象' });
    return undefined;
  }
  for (const key of Object.keys(rawContact)) {
    if ((CONTACT_INFO_FIELDS as readonly string[]).includes(key)) continue;
    if (isForbiddenSensitiveFieldName(key)) {
      errors.push({
        field: `contact.${key}`,
        message: `联系方式中禁止出现超出本迭代范围的敏感字段（contact.${key}，Q4）`,
      });
    } else {
      errors.push({ field: `contact.${key}`, message: `联系方式中的字段（contact.${key}）不在契约允许范围内` });
    }
  }
  const contact: ContactInfo = {};
  let hasContactValue = false;
  const mobile = optionalNullableString(rawContact, 'mobile', errors);
  if (mobile !== undefined) {
    hasContactValue = true;
    if (typeof mobile === 'string') {
      if (mobile.length > 32) {
        errors.push({ field: 'contact.mobile', message: `手机号（contact.mobile）长度不能超过 32 个字符（当前 ${mobile.length}）` });
      } else if (mobile.trim() === '') {
        errors.push({ field: 'contact.mobile', message: '手机号（contact.mobile）如提供则不能为空白' });
      }
      contact.mobile = mobile;
    } else {
      contact.mobile = null;
    }
  }
  const email = optionalNullableString(rawContact, 'email', errors);
  if (email !== undefined) {
    hasContactValue = true;
    if (typeof email === 'string') {
      if (!EMAIL_PATTERN.test(email)) {
        errors.push({ field: 'contact.email', message: `邮箱（contact.email）格式不正确：「${email}」不是合法的邮箱地址` });
      }
      contact.email = email;
    } else {
      contact.email = null;
    }
  }
  return hasContactValue ? contact : undefined;
}

/**
 * 校验建档入参。纯函数：不读写外部状态，缺失项逐条输出中文提示（R6）。
 * 输入按 unknown 处理，供 API 层直接传入反序列化结果。
 */
export function validatePersonCreate(input: unknown): ValidationOutcome {
  const errors: FieldError[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      code: 'validation_failed',
      message: '输入校验未通过：请求体必须是一个 JSON 对象',
      fieldErrors: [{ field: 'request', message: '请求体必须是一个 JSON 对象' }],
    };
  }

  // 字段白名单 + 敏感字段显式拒绝（AC-009）
  for (const key of Object.keys(input)) {
    if ((PERSON_CREATE_REQUEST_FIELDS as readonly string[]).includes(key)) continue;
    if (isForbiddenSensitiveFieldName(key)) {
      errors.push({
        field: key,
        message: `字段（${key}）属于证件号/薪酬/银行账户等高敏感信息，超出本迭代字段范围（Q4），禁止提交`,
      });
    } else {
      errors.push({ field: key, message: `字段（${key}）不在契约 PersonCreateRequest 白名单内，请移除后重试` });
    }
  }

  const employeeNo = requiredString(input, 'employeeNo', errors);
  const fullName = requiredString(input, 'fullName', errors);
  const employmentTypeRaw = requiredString(input, 'employmentType', errors);
  const employmentStartDate = requiredString(input, 'employmentStartDate', errors);
  const departmentId = requiredString(input, 'departmentId', errors);
  const departmentName = requiredString(input, 'departmentName', errors);
  const positionName = requiredString(input, 'positionName', errors);
  const effectiveFrom = requiredString(input, 'effectiveFrom', errors);

  if (employeeNo !== undefined) checkMaxLength(employeeNo, 'employeeNo', 32, '工号', errors);
  if (fullName !== undefined) checkMaxLength(fullName, 'fullName', 64, '姓名', errors);
  if (departmentId !== undefined) checkMaxLength(departmentId, 'departmentId', 64, '部门标识', errors);
  if (departmentName !== undefined) checkMaxLength(departmentName, 'departmentName', 64, '部门名称', errors);
  if (positionName !== undefined) checkMaxLength(positionName, 'positionName', 64, '岗位名称', errors);

  let employmentType: EmploymentType | undefined;
  if (employmentTypeRaw !== undefined) {
    if ((EMPLOYMENT_TYPES as readonly string[]).includes(employmentTypeRaw)) {
      employmentType = employmentTypeRaw as EmploymentType;
    } else {
      errors.push({
        field: 'employmentType',
        message: `雇佣类型（employmentType）必须是 ${EMPLOYMENT_TYPES.join('、')} 之一，当前为「${employmentTypeRaw}」`,
      });
    }
  }

  if (employmentStartDate !== undefined && !isIsoCalendarDate(employmentStartDate)) {
    errors.push({ field: 'employmentStartDate', message: `雇佣开始日期（employmentStartDate）必须为 YYYY-MM-DD 格式的有效日期，当前为「${employmentStartDate}」` });
  }
  if (effectiveFrom !== undefined && !isIsoCalendarDate(effectiveFrom)) {
    errors.push({ field: 'effectiveFrom', message: `任职生效日期（effectiveFrom）必须为 YYYY-MM-DD 格式的有效日期，当前为「${effectiveFrom}」` });
  }

  let employmentEndDate: string | null | undefined;
  const rawEnd = input['employmentEndDate'];
  if (rawEnd === undefined) {
    employmentEndDate = undefined;
  } else if (rawEnd === null) {
    employmentEndDate = null;
  } else if (typeof rawEnd !== 'string' || !isIsoCalendarDate(rawEnd)) {
    errors.push({ field: 'employmentEndDate', message: '雇佣结束日期（employmentEndDate）必须为 YYYY-MM-DD 格式的有效日期或 null' });
    employmentEndDate = undefined;
  } else {
    employmentEndDate = rawEnd;
    if (employmentStartDate !== undefined && isIsoCalendarDate(employmentStartDate) && rawEnd < employmentStartDate) {
      errors.push({
        field: 'employmentEndDate',
        message: `雇佣结束日期（employmentEndDate=${rawEnd}）不得早于开始日期（${employmentStartDate}）`,
      });
    }
  }

  const contact = validateContact(input['contact'], errors);

  let reportsToPersonId: string | null | undefined;
  const rawReportsTo = input['reportsToPersonId'];
  if (rawReportsTo === undefined) {
    reportsToPersonId = undefined;
  } else if (rawReportsTo === null) {
    reportsToPersonId = null;
  } else if (typeof rawReportsTo !== 'string' || !UUID_PATTERN.test(rawReportsTo)) {
    errors.push({ field: 'reportsToPersonId', message: '汇报上级标识（reportsToPersonId）如提供则必须是合法的 UUID' });
    reportsToPersonId = undefined;
  } else {
    reportsToPersonId = rawReportsTo;
  }

  let positionId: string | undefined;
  const rawPositionId = input['positionId'];
  if (rawPositionId !== undefined) {
    if (typeof rawPositionId !== 'string') {
      errors.push({ field: 'positionId', message: '岗位标识（positionId）必须是字符串' });
    } else {
      checkMaxLength(rawPositionId, 'positionId', 64, '岗位标识', errors);
      positionId = rawPositionId;
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      code: 'validation_failed',
      message: `输入校验未通过：共 ${errors.length} 个问题，请逐项修正后重试（R6）`,
      fieldErrors: errors,
    };
  }

  const value: PersonCreateRequest = {
    employeeNo: employeeNo as string,
    fullName: fullName as string,
    employmentType: employmentType as EmploymentType,
    employmentStartDate: employmentStartDate as string,
    departmentId: departmentId as string,
    departmentName: departmentName as string,
    positionName: positionName as string,
    effectiveFrom: effectiveFrom as string,
  };
  if (contact !== undefined) value.contact = contact;
  if (employmentEndDate !== undefined) value.employmentEndDate = employmentEndDate;
  if (reportsToPersonId !== undefined) value.reportsToPersonId = reportsToPersonId;
  if (positionId !== undefined) value.positionId = positionId;
  return { ok: true, value };
}
