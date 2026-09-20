/**
 * 人员管理契约 DTO 与字段白名单（T-01 / AC-001 / AC-009）。
 *
 * 与 `contracts/openapi.yaml` 的 components.schemas 字段一一对应：
 * PersonCreateRequest / PersonUpdateRequest / ContactInfo / PersonDetail / Assignment
 * （并附带同契约的 PersonSummary / AssignmentCreateRequest / StatusTransitionRequest / ChangeRecord；
 * ErrorResponse / FieldError 的结构定义在 `./errors.ts`，此处一并登记进白名单供遍历核对）。
 * 字段范围严守 Q4（仅基础与雇佣信息）：显式排除 idNumber、salary、bankAccount
 * 及常见别名（见 FORBIDDEN_SENSITIVE_FIELD_NAMES / FORBIDDEN_SENSITIVE_NAME_TOKENS /
 * FORBIDDEN_SENSITIVE_NAME_TOKENS_CN）。
 *
 * 契约按原文镜像，不静默改写：ChangeRecord 的 personId 不在契约响应字段内，
 * 因此契约类型 ChangeRecord 不含该键，仅在内部类型 PersonChangeRecord 中扩展。
 *
 * 运行约束：仅可擦除 TypeScript 语法（无 enum/装饰器/参数属性/namespace），
 * 相对导入带 `.ts` 后缀，供 Node 24 type stripping 直跑。
 */

import {
  ERROR_RESPONSE_FIELDS,
  ERROR_RESPONSE_REQUIRED_FIELDS,
  FIELD_ERROR_FIELDS,
  FIELD_ERROR_REQUIRED_FIELDS,
} from './errors.ts';

export type PersonStatus = 'draft' | 'active' | 'inactive';
export const PERSON_STATUSES: readonly PersonStatus[] = ['draft', 'active', 'inactive'] as const;

export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern' | 'other';
export const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'full_time',
  'part_time',
  'contract',
  'intern',
  'other',
] as const;

export type AssignmentStatus = 'pending' | 'current' | 'closed' | 'retracted';
export const ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'pending',
  'current',
  'closed',
  'retracted',
] as const;

/** 契约 PersonStatus / EmploymentType / AssignmentStatus 的字符串联合，供入参校验使用。 */
export function isPersonStatus(value: unknown): value is PersonStatus {
  return typeof value === 'string' && (PERSON_STATUSES as readonly string[]).includes(value);
}
export function isEmploymentType(value: unknown): value is EmploymentType {
  return typeof value === 'string' && (EMPLOYMENT_TYPES as readonly string[]).includes(value);
}
export function isAssignmentStatus(value: unknown): value is AssignmentStatus {
  return typeof value === 'string' && (ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

/** 联系方式（Q4：仅此，不含证件号/薪酬/银行账户）。 */
export interface ContactInfo {
  mobile?: string | null;
  email?: string | null;
}
export const CONTACT_INFO_FIELDS = ['mobile', 'email'] as const;
export const CONTACT_INFO_REQUIRED_FIELDS: readonly string[] = [] as const;

/** F1 建档入参；8 个必填字段见 PERSON_CREATE_REQUIRED_FIELDS。 */
export interface PersonCreateRequest {
  employeeNo: string;
  fullName: string;
  contact?: ContactInfo;
  employmentType: EmploymentType;
  employmentStartDate: string;
  employmentEndDate?: string | null;
  departmentId: string;
  departmentName: string;
  positionId?: string;
  positionName: string;
  reportsToPersonId?: string | null;
  effectiveFrom: string;
}
export const PERSON_CREATE_REQUEST_FIELDS = [
  'employeeNo',
  'fullName',
  'contact',
  'employmentType',
  'employmentStartDate',
  'employmentEndDate',
  'departmentId',
  'departmentName',
  'positionId',
  'positionName',
  'reportsToPersonId',
  'effectiveFrom',
] as const;

/** test-plan personnel-validation 的 8 个必填字段清单（AC-001 / 契约 required）。 */
export const PERSON_CREATE_REQUIRED_FIELDS = [
  'employeeNo',
  'fullName',
  'employmentType',
  'employmentStartDate',
  'departmentId',
  'departmentName',
  'positionName',
  'effectiveFrom',
] as const;

/** F3 在职变更入参：仅基础与雇佣信息字段（组织/岗位走任职接口）。 */
export interface PersonUpdateRequest {
  fullName?: string;
  contact?: ContactInfo;
  employmentType?: EmploymentType;
  employmentStartDate?: string;
  employmentEndDate?: string | null;
}
export const PERSON_UPDATE_REQUEST_FIELDS = [
  'fullName',
  'contact',
  'employmentType',
  'employmentStartDate',
  'employmentEndDate',
] as const;
export const PERSON_UPDATE_REQUIRED_FIELDS: readonly string[] = [] as const;

/** 契约 PersonUpdateRequest 的 minProperties: 1 —— 空补丁不合法。 */
export function isPersonUpdatePayloadEmpty(update: PersonUpdateRequest): boolean {
  return findDeclaredFieldNames(PERSON_UPDATE_REQUEST_FIELDS, Object.keys(update)).length === 0;
}

/** 任职区间（部门/岗位/汇报关系 + 生效期间）。 */
export interface Assignment {
  assignmentId: string;
  personId: string;
  departmentId: string;
  departmentName: string;
  positionId?: string;
  positionName: string;
  reportsToPersonId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  status: AssignmentStatus;
}
export const ASSIGNMENT_FIELDS = [
  'assignmentId',
  'personId',
  'departmentId',
  'departmentName',
  'positionId',
  'positionName',
  'reportsToPersonId',
  'effectiveFrom',
  'effectiveTo',
  'status',
] as const;
export const ASSIGNMENT_REQUIRED_FIELDS = [
  'assignmentId',
  'personId',
  'departmentId',
  'departmentName',
  'positionName',
  'effectiveFrom',
  'status',
] as const;

/** 人员详情视图（含当前任职，字段级过滤在服务端完成）。 */
export interface PersonDetail {
  personId: string;
  employeeNo: string;
  fullName: string;
  contact?: ContactInfo;
  employmentType: EmploymentType;
  employmentStartDate: string;
  employmentEndDate?: string | null;
  status: PersonStatus;
  deactivationReason?: string | null;
  currentAssignment?: Assignment | null;
  createdAt: string;
  updatedAt?: string;
}
export const PERSON_DETAIL_FIELDS = [
  'personId',
  'employeeNo',
  'fullName',
  'contact',
  'employmentType',
  'employmentStartDate',
  'employmentEndDate',
  'status',
  'deactivationReason',
  'currentAssignment',
  'createdAt',
  'updatedAt',
] as const;
export const PERSON_DETAIL_REQUIRED_FIELDS = [
  'personId',
  'employeeNo',
  'fullName',
  'status',
  'employmentType',
  'employmentStartDate',
  'createdAt',
] as const;

/** 在册列表摘要（F2）。 */
export interface PersonSummary {
  personId: string;
  employeeNo: string;
  fullName: string;
  status: PersonStatus;
  departmentId?: string;
  departmentName?: string;
  positionName?: string;
}
export const PERSON_SUMMARY_FIELDS = [
  'personId',
  'employeeNo',
  'fullName',
  'status',
  'departmentId',
  'departmentName',
  'positionName',
] as const;
export const PERSON_SUMMARY_REQUIRED_FIELDS = ['personId', 'employeeNo', 'fullName', 'status'] as const;

/** 任职变更入参（F3）。 */
export interface AssignmentCreateRequest {
  departmentId: string;
  departmentName: string;
  positionId?: string;
  positionName: string;
  reportsToPersonId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
}
export const ASSIGNMENT_CREATE_REQUEST_FIELDS = [
  'departmentId',
  'departmentName',
  'positionId',
  'positionName',
  'reportsToPersonId',
  'effectiveFrom',
  'effectiveTo',
] as const;
export const ASSIGNMENT_CREATE_REQUIRED_FIELDS = [
  'departmentId',
  'departmentName',
  'positionName',
  'effectiveFrom',
] as const;

/** 状态流转入参（F4）。停用需原因由 F4 规则给出中文提示。 */
export interface StatusTransitionRequest {
  toStatus: 'active' | 'inactive';
  reason?: string | null;
  effectiveFrom: string;
}
export const STATUS_TRANSITION_FIELDS = ['toStatus', 'reason', 'effectiveFrom'] as const;
export const STATUS_TRANSITION_REQUIRED_FIELDS = ['toStatus', 'effectiveFrom'] as const;
export const STATUS_TRANSITION_TARGET_STATUSES = ['active', 'inactive'] as const;
export const STATUS_TRANSITION_REASON_MAX_LENGTH = 200;

/**
 * 字段级历史与审计记录（F5/R7）。
 * 形状与契约 ChangeRecord 完全一致：历史记录在契约中按人员维度查询，
 * personId 属查询维度而非响应字段（内部需要时用 PersonChangeRecord）。
 */
export interface ChangeRecord {
  recordId: string;
  action:
    | 'create'
    | 'update'
    | 'assignment_change'
    | 'assignment_retract'
    | 'status_change'
    | 'delete_attempt';
  fieldName: string;
  oldValue?: string | null;
  newValue?: string | null;
  operatorId: string;
  operatorName?: string | null;
  occurredAt: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}
export const CHANGE_RECORD_FIELDS = [
  'recordId',
  'action',
  'fieldName',
  'oldValue',
  'newValue',
  'operatorId',
  'operatorName',
  'occurredAt',
  'effectiveFrom',
  'effectiveTo',
] as const;
export const CHANGE_RECORD_REQUIRED_FIELDS = [
  'recordId',
  'action',
  'fieldName',
  'operatorId',
  'occurredAt',
] as const;
export const CHANGE_RECORD_ACTIONS = [
  'create',
  'update',
  'assignment_change',
  'assignment_retract',
  'status_change',
  'delete_attempt',
] as const;

/** 内部（非契约响应）历史记录形状：按人员维度分组时携带 personId。 */
export interface PersonChangeRecord extends ChangeRecord {
  personId: string;
}

/**
 * 本迭代禁止出现的敏感字段名（Q4 / AC-009）：证件号、薪酬、银行账户及常见别名。
 * 比较前先 normalizeFieldName（小写并去除 `_`/`-`/空白）。
 */
export const FORBIDDEN_SENSITIVE_FIELD_NAMES = [
  // 证件号
  'idNumber',
  'idCardNumber',
  'idCard',
  'idCardNo',
  'identityNumber',
  'identityCard',
  'nationalId',
  'nationalIdNumber',
  'citizenId',
  'citizenIdNumber',
  'idNo',
  'idDocument',
  'idDocumentNo',
  'documentNo',
  'documentNumber',
  'certNo',
  'certNumber',
  'certificateNumber',
  'passportNo',
  'passportNumber',
  'ssn',
  'socialSecurityNo',
  'socialSecurityNumber',
  // 薪酬
  'salary',
  'salaryAmount',
  'monthlySalary',
  'annualSalary',
  'baseSalary',
  'basicSalary',
  'wage',
  'wages',
  'pay',
  'payRate',
  'income',
  'compensation',
  'remuneration',
  'bonus',
  'allowance',
  // 银行账户
  'bankAccount',
  'bankAccountNo',
  'bankAccountNumber',
  'bankBranch',
  'bankName',
  'bankCard',
  'bankCardNo',
  'bankCardNumber',
  'accountNumber',
  'accountNo',
  'iban',
  'bic',
  'swiftCode',
  'routingNumber',
  'sortCode',
] as const;

/**
 * 命中即拒绝的高置信片段（防止仅加前后缀的变体绕过别名清单）。
 * 片段均在归一化（小写、去 `_`/`-`/空白）后做子串判断；已核对不与任何契约字段冲突。
 */
export const FORBIDDEN_SENSITIVE_NAME_TOKENS = [
  'idnumber',
  'idcard',
  'identitycard',
  'identitynumber',
  'iddocument',
  'documentnumber',
  'nationalid',
  'citizenid',
  'certnumber',
  'certificate',
  'passport',
  'socialsecurity',
  'salary',
  'remuneration',
  'compensation',
  'bankaccount',
  'bankcard',
  'bankbranch',
  'bankname',
  'accountnumber',
  'routingnumber',
  'sortcode',
  'swift',
  'iban',
  // 拼音别名（常见列名习惯）
  'shenfenzheng',
  'shenfenzhenghao',
  'sfzh',
  'sfzhm',
  'gongzi',
  'xinzhi',
  'xinzijin',
  'jiangjin',
  'yinhangka',
  'yinhangzhanghao',
  'yinhangzh',
] as const;

/** 中文别名片段（字段名以中文书写时的同样拒绝；子串匹配）。 */
export const FORBIDDEN_SENSITIVE_NAME_TOKENS_CN = [
  '身份证',
  '证件号',
  '证件编号',
  '护照',
  '社保号',
  '社会保障',
  '薪酬',
  '薪水',
  '工资',
  '薪资',
  '薪金',
  '奖金',
  '补贴',
  '银行',
  '银行卡',
  '账户号',
  '帐号',
] as const;

export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[_\s-]/g, '');
}

export function isForbiddenSensitiveFieldName(name: string): boolean {
  const normalized = normalizeFieldName(name);
  if (normalized === '') return false;
  for (const forbidden of FORBIDDEN_SENSITIVE_FIELD_NAMES) {
    if (normalizeFieldName(forbidden) === normalized) return true;
  }
  for (const token of FORBIDDEN_SENSITIVE_NAME_TOKENS) {
    if (normalized.includes(token)) return true;
  }
  for (const token of FORBIDDEN_SENSITIVE_NAME_TOKENS_CN) {
    if (name.includes(token) || normalized.includes(normalizeFieldName(token))) return true;
  }
  return false;
}

/** 返回给定字段名清单中命中的敏感字段（用于契约核对与入参拒绝）。 */
export function findForbiddenFieldNames(names: readonly string[]): string[] {
  return names.filter((name) => isForbiddenSensitiveFieldName(name));
}

/** 全部契约 DTO 的字段白名单，供测试遍历断言无敏感字段（AC-009）。 */
export const DTO_FIELD_WHITELISTS: Readonly<Record<string, readonly string[]>> = {
  ErrorResponse: ERROR_RESPONSE_FIELDS,
  FieldError: FIELD_ERROR_FIELDS,
  ContactInfo: CONTACT_INFO_FIELDS,
  PersonCreateRequest: PERSON_CREATE_REQUEST_FIELDS,
  PersonUpdateRequest: PERSON_UPDATE_REQUEST_FIELDS,
  PersonDetail: PERSON_DETAIL_FIELDS,
  Assignment: ASSIGNMENT_FIELDS,
  PersonSummary: PERSON_SUMMARY_FIELDS,
  AssignmentCreateRequest: ASSIGNMENT_CREATE_REQUEST_FIELDS,
  StatusTransitionRequest: STATUS_TRANSITION_FIELDS,
  ChangeRecord: CHANGE_RECORD_FIELDS,
};

/** 各契约 DTO 的 required 字段清单（镜像 openapi.yaml 的 required）。 */
export const DTO_REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ErrorResponse: ERROR_RESPONSE_REQUIRED_FIELDS,
  FieldError: FIELD_ERROR_REQUIRED_FIELDS,
  ContactInfo: CONTACT_INFO_REQUIRED_FIELDS,
  PersonCreateRequest: PERSON_CREATE_REQUIRED_FIELDS,
  PersonUpdateRequest: PERSON_UPDATE_REQUIRED_FIELDS,
  PersonDetail: PERSON_DETAIL_REQUIRED_FIELDS,
  Assignment: ASSIGNMENT_REQUIRED_FIELDS,
  PersonSummary: PERSON_SUMMARY_REQUIRED_FIELDS,
  AssignmentCreateRequest: ASSIGNMENT_CREATE_REQUIRED_FIELDS,
  StatusTransitionRequest: STATUS_TRANSITION_REQUIRED_FIELDS,
  ChangeRecord: CHANGE_RECORD_REQUIRED_FIELDS,
};

/** T-01 落地的六个契约 schema 名。 */
export const T01_CONTRACT_SCHEMA_NAMES = [
  'PersonCreateRequest',
  'PersonUpdateRequest',
  'ContactInfo',
  'PersonDetail',
  'Assignment',
  'ErrorResponse',
] as const;

/** 对象属性值引用的嵌套 schema 名，用于逐层校验白名单（如入参里的 contact）。 */
export const NESTED_DTO_SCHEMAS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  PersonCreateRequest: { contact: 'ContactInfo' },
  PersonUpdateRequest: { contact: 'ContactInfo' },
  PersonDetail: { contact: 'ContactInfo', currentAssignment: 'Assignment' },
};

/** 数组属性元素引用的嵌套 schema 名（如 ErrorResponse.fieldErrors 的每一项）。 */
export const NESTED_DTO_ARRAY_SCHEMAS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ErrorResponse: { fieldErrors: 'FieldError' },
};

/** 契约中显式声明的文本长度上限（仅此四处，其余字段契约未给长度）。 */
export const CONTRACT_FIELD_MAX_LENGTHS: Readonly<Record<string, number>> = {
  employeeNo: 32,
  fullName: 64,
  mobile: 32,
  reason: STATUS_TRANSITION_REASON_MAX_LENGTH,
};

/** 契约声明的文本长度下限（employeeNo 1–32、fullName 1–64）。 */
export const CONTRACT_FIELD_MIN_LENGTHS: Readonly<Record<string, number>> = {
  employeeNo: 1,
  fullName: 1,
};

/** 契约声明为 date 的字段（校验 YYYY-MM-DD）。 */
export const CONTRACT_DATE_FIELDS = [
  'employmentStartDate',
  'employmentEndDate',
  'effectiveFrom',
  'effectiveTo',
] as const;

/** 契约声明为 uuid 的字段（校验 UUID 文本格式）。 */
export const CONTRACT_UUID_FIELDS = [
  'personId',
  'assignmentId',
  'recordId',
  'reportsToPersonId',
] as const;

/** 契约声明为 date-time 的字段。 */
export const CONTRACT_DATE_TIME_FIELDS = ['createdAt', 'updatedAt', 'occurredAt'] as const;

export function isDeclaredDtoField(schemaName: string, name: string): boolean {
  const whitelist = DTO_FIELD_WHITELISTS[schemaName];
  return whitelist !== undefined && whitelist.includes(name);
}

/** 取 payload 键名中属于白名单的部分（白名单交集）。 */
export function findDeclaredFieldNames(
  whitelist: readonly string[],
  names: readonly string[],
): string[] {
  return names.filter((name) => whitelist.includes(name));
}

/** 返回 payload 键名中不在白名单内的部分（未知字段，Q4 白名单外一律拒绝）。 */
export function findUnknownFieldNames(
  whitelist: readonly string[],
  names: readonly string[],
): string[] {
  return names.filter((name) => !whitelist.includes(name));
}

/** 递归收集对象/数组中出现的全部键名（深度防御：嵌套体也不得携带敏感字段）。 */
export function collectPayloadFieldNames(payload: unknown, depth = 0): string[] {
  if (depth > 5 || payload === null || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) {
    const nested: string[] = [];
    for (const item of payload) nested.push(...collectPayloadFieldNames(item, depth + 1));
    return nested;
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  const nested: string[] = [];
  for (const key of keys) nested.push(...collectPayloadFieldNames(record[key], depth + 1));
  return [...keys, ...nested];
}

/** 入参任意层级命中的敏感字段名（AC-009：不接受证件号/薪酬/银行账户）。 */
export function findSensitivePayloadFieldNames(payload: unknown): string[] {
  const unique: string[] = [];
  for (const name of collectPayloadFieldNames(payload)) {
    if (isForbiddenSensitiveFieldName(name) && !unique.includes(name)) unique.push(name);
  }
  return unique;
}

/**
 * 按 schema 名核对入参键名，逐层展开嵌套对象与对象数组，返回未知字段名
 * （含契约白名单外的任何键，敏感字段必然落在此集合）。
 * 空数组即表示入参完全落在契约白名单内。
 */
export function findUndeclaredPayloadFieldNames(
  schemaName: string,
  payload: Record<string, unknown>,
): string[] {
  const whitelist = DTO_FIELD_WHITELISTS[schemaName];
  if (whitelist === undefined) return Object.keys(payload);
  const unknown = findUnknownFieldNames(whitelist, Object.keys(payload));
  const nested = NESTED_DTO_SCHEMAS[schemaName] ?? {};
  for (const field of Object.keys(nested)) {
    const value = payload[field];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      unknown.push(
        ...findUndeclaredPayloadFieldNames(nested[field], value as Record<string, unknown>),
      );
    }
  }
  const nestedArray = NESTED_DTO_ARRAY_SCHEMAS[schemaName] ?? {};
  for (const field of Object.keys(nestedArray)) {
    const value = payload[field];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        unknown.push(
          ...findUndeclaredPayloadFieldNames(
            nestedArray[field],
            item as Record<string, unknown>,
          ),
        );
      }
    }
  }
  return unknown;
}

/** 白名单与逐字段类型的对照说明（供契约一致性核对与文档，不含行为）。 */
export interface DtoSchemaDescriptor {
  schemaName: string;
  fields: readonly string[];
  required: readonly string[];
}

export const T01_DTO_SCHEMA_DESCRIPTORS: readonly DtoSchemaDescriptor[] = T01_CONTRACT_SCHEMA_NAMES.map(
  (schemaName) => ({
    schemaName,
    fields: DTO_FIELD_WHITELISTS[schemaName] ?? [],
    required: DTO_REQUIRED_FIELDS[schemaName] ?? [],
  }),
);

/** 全部已知 schema 的白名单敏感字段核对结果（应为空数组，AC-009 自检）。 */
export function findSensitiveWhitelistFieldNames(): string[] {
  const hits: string[] = [];
  for (const schemaName of Object.keys(DTO_FIELD_WHITELISTS)) {
    for (const name of findForbiddenFieldNames(DTO_FIELD_WHITELISTS[schemaName])) {
      if (!hits.includes(name)) hits.push(name);
    }
  }
  return hits;
}
