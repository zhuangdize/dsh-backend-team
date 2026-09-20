/**
 * T-05 合同层：POST /api/v1/customers（客户新增端点）
 *
 * 职责（architecture.md · customer-api）：请求解码、结构校验（必填存在性、
 * 类型、清单外字段显式拒绝）、调用 createCustomer 用例（T-03）、HTTP 状态/头部
 * 与统一错误结构映射；不在此做业务规则最终判定，领域字段错误在此并入 422。
 *
 * 对齐 contracts/openapi.yaml：
 * - 201 + Location（新客户详情地址）+ CustomerDetail；
 * - 422 + Error{code/message/requestId} + fieldErrors 逐项列出（AC-002）；
 * - CustomerCreateRequest additionalProperties=false：清单外字段一律显式拒绝、
 *   不静默写入（spec.md Rules、clarification Q1；服务端生成/只读字段以
 *   IMMUTABLE 错误项表达，普通未知字段以 INVALID_FORMAT 错误项表达）；
 * - 电话唯一冲突透传为 409 CUSTOMER_PHONE_TAKEN，并在可用时返回已有客户摘要；
 * - 失败一律不产生写入：结构/字段错误在进入用例前短路（422 时事务不启动）。
 *
 * 运行方式：宿主 Node 24 直跑（type stripping），动态解析应用层用例，
 * 便于测试注入（context.useCase / createCustomerNodeHandler(options)）。
 * 为保持零静态依赖（仅 node:crypto），HTTP 收发对象使用结构化最小类型，
 * 与 node:http 的 IncomingMessage/ServerResponse 实际形状兼容。
 */

import { randomUUID } from 'node:crypto';

/** node:http IncomingMessage 中被本模块使用的最小子集。 */
export interface HttpRequestLike {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  setEncoding(encoding: string): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'end' | 'error', listener: (err?: unknown) => void): unknown;
  destroy(error?: unknown): unknown;
}

/** node:http ServerResponse 中被本模块使用的最小子集。 */
export interface HttpResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: unknown): unknown;
}

export const CREATE_CUSTOMER_PATH = '/api/v1/customers';

/** 契约 CustomerCreateRequest 的允许字段（Q1 定稿最小集合）。 */
export const ALLOWED_CREATE_FIELDS: readonly string[] = [
  'name',
  'contactPerson',
  'phone',
  'email',
  'company',
  'note',
];

export type FieldErrorCode =
  | 'REQUIRED'
  | 'TOO_LONG'
  | 'INVALID_FORMAT'
  | 'DUPLICATED'
  | 'IMMUTABLE';

const FIELD_ERROR_CODES: readonly string[] = [
  'REQUIRED',
  'TOO_LONG',
  'INVALID_FORMAT',
  'DUPLICATED',
  'IMMUTABLE',
];

export interface FieldError {
  field: string;
  code: FieldErrorCode;
  message: string;
}

export interface PersonRefView {
  userId: string;
  displayName: string;
}

/** 契约 CustomerDetail 的序列化视图（camelCase）。 */
export interface CustomerDetailView {
  customerId: string;
  name: string;
  contactPerson: string | null;
  phone: string;
  email: string | null;
  company: string | null;
  note: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: PersonRefView;
  updatedBy: PersonRefView;
  recentChanges: unknown[];
}

/** 统一错误结构：code/message/requestId（+ 422 时的 fieldErrors）。 */
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
  fieldErrors?: FieldError[];
  details?: Record<string, unknown>;
}

export interface HttpOutcome {
  status: number;
  headers: Record<string, string>;
  body: CustomerDetailView | ApiErrorBody;
}

export interface CreateCustomerInput {
  name: string;
  phone: string;
  contactPerson: string | null;
  email: string | null;
  company: string | null;
  note: string | null;
}

export type CustomerUseCaseFn = (
  input: CreateCustomerInput,
  context: Record<string, unknown>,
) => unknown;

export interface RequestContext {
  requestId?: string;
  principal?: Record<string, unknown>;
  /** 测试/装配注入点：显式提供则跳过对应用层用例的动态解析。 */
  useCase?: CustomerUseCaseFn;
  [key: string]: unknown;
}

const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  contactPerson: '联系人',
  phone: '联系电话',
  email: '邮箱',
  company: '公司',
  note: '备注',
};

/** 服务端生成或只读的字段：客户端传入 → 显式拒绝（IMMUTABLE），绝不写入。 */
const IMMUTABLE_FIELD_HINTS: ReadonlySet<string> = new Set([
  'customerId',
  'customer_id',
  'id',
  'version',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'createdBy',
  'created_by',
  'updatedBy',
  'updated_by',
  'phoneKey',
  'phone_key',
  'recentChanges',
  'recent_changes',
]);

/** 契约 phone 正则：^[0-9()+ -]{6,20}$（展示值保留原始书写）。 */
const PHONE_PATTERN = /^[0-9()+ -]{6,20}$/;
/** 契约 email 基本格式：含 @ 与点、无空格。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function labelOf(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function jsonOutcome(
  status: number,
  body: CustomerDetailView | ApiErrorBody,
  extraHeaders: Record<string, string> = {},
): HttpOutcome {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
    body,
  };
}

function errorBody(
  code: string,
  message: string,
  requestId: string,
  extra?: { fieldErrors?: FieldError[]; details?: Record<string, unknown> },
): ApiErrorBody {
  const body: ApiErrorBody = { code, message, requestId };
  if (extra?.fieldErrors && extra.fieldErrors.length > 0) {
    body.fieldErrors = extra.fieldErrors;
  }
  if (extra?.details) {
    body.details = extra.details;
  }
  return body;
}

function validationOutcome(fieldErrors: FieldError[], requestId: string): HttpOutcome {
  return jsonOutcome(
    422,
    errorBody(
      'VALIDATION_FAILED',
      '部分字段不符合要求，请修正后重新提交；已提交内容未写入。',
      requestId,
      { fieldErrors: dedupeFieldErrors(fieldErrors) },
    ),
  );
}

function dedupeFieldErrors(errors: FieldError[]): FieldError[] {
  const seen = new Set<string>();
  const out: FieldError[] = [];
  for (const e of errors) {
    const key = `${e.field}|${e.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

function normalizeFieldErrors(list: unknown): FieldError[] {
  if (!Array.isArray(list)) return [];
  const out: FieldError[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push({ field: entry, code: 'INVALID_FORMAT', message: `字段 ${entry} 不合法` });
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const field = typeof e.field === 'string' && e.field.length > 0 ? e.field : '*';
    const code =
      typeof e.code === 'string' && FIELD_ERROR_CODES.includes(e.code)
        ? (e.code as FieldErrorCode)
        : 'INVALID_FORMAT';
    const message =
      typeof e.message === 'string' && e.message.length > 0
        ? e.message
        : `${labelOf(field)}不合法`;
    out.push({ field, code, message });
  }
  return out;
}

export interface StructuralValidationResult {
  /** 仅在无任何字段错误时为可入库输入。 */
  input: CreateCustomerInput | null;
  fieldErrors: FieldError[];
}

/**
 * 结构解码与字段校验（接口层，架构 §Request Flow 2）：
 * - 清单外字段 → 显式拒绝（IMMUTABLE/INVALID_FORMAT 错误项），不进入输入；
 * - 必填存在性（name/phone）→ REQUIRED；
 * - 类型/格式 → INVALID_FORMAT；长度 → TOO_LONG。
 * 领域层（T-01/T-03）仍是规则最终裁决；此处与其口径一致。
 */
export function validateCreateCustomerBody(
  raw: Record<string, unknown>,
): StructuralValidationResult {
  const fieldErrors: FieldError[] = [];
  const push = (field: string, code: FieldErrorCode, message: string): void => {
    fieldErrors.push({ field, code, message });
  };

  // 清单外字段：显式拒绝、不静默写入（additionalProperties=false）。
  for (const key of Object.keys(raw)) {
    if (ALLOWED_CREATE_FIELDS.includes(key)) continue;
    if (IMMUTABLE_FIELD_HINTS.has(key)) {
      push(
        key,
        'IMMUTABLE',
        `字段 "${key}" 由服务端生成或为只读字段，客户端不可指定，已拒绝。`,
      );
    } else {
      push(
        key,
        'INVALID_FORMAT',
        `字段 "${key}" 不在客户创建清单内，已显式拒绝、未写入。`,
      );
    }
  }

  let name: string | null = null;
  const rawName = raw.name;
  if (rawName === undefined || rawName === null) {
    push('name', 'REQUIRED', '名称为必填项。');
  } else if (typeof rawName !== 'string') {
    push('name', 'INVALID_FORMAT', '名称必须是字符串。');
  } else {
    const trimmed = rawName.trim();
    if (trimmed.length === 0) {
      push('name', 'REQUIRED', '名称去除首尾空格后不能为空。');
    } else if (trimmed.length > 100) {
      push('name', 'TOO_LONG', '名称长度不能超过 100 个字符。');
    } else {
      name = trimmed;
    }
  }

  let phone: string | null = null;
  const rawPhone = raw.phone;
  if (rawPhone === undefined || rawPhone === null) {
    push('phone', 'REQUIRED', '联系电话为必填项。');
  } else if (typeof rawPhone !== 'string') {
    push('phone', 'INVALID_FORMAT', '联系电话必须是字符串。');
  } else if (!PHONE_PATTERN.test(rawPhone)) {
    push(
      'phone',
      'INVALID_FORMAT',
      '联系电话格式不合法：仅允许数字与 + ( ) - 空格，长度 6–20。',
    );
  } else {
    phone = rawPhone;
  }

  const optionalString = (field: string, maxLength: number): string | null => {
    const v = raw[field];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') {
      push(field, 'INVALID_FORMAT', `${labelOf(field)}必须是字符串。`);
      return null;
    }
    if (v.length > maxLength) {
      push(field, 'TOO_LONG', `${labelOf(field)}长度不能超过 ${maxLength} 个字符。`);
      return null;
    }
    if (field === 'email') {
      if (v.trim().length === 0 || !EMAIL_PATTERN.test(v)) {
        push(field, 'INVALID_FORMAT', '邮箱格式不合法。');
        return null;
      }
    }
    return v;
  };

  const contactPerson = optionalString('contactPerson', 50);
  const email = optionalString('email', 100);
  const company = optionalString('company', 100);
  const note = optionalString('note', 1000);

  const input =
    fieldErrors.length === 0 && name !== null && phone !== null
      ? { name, phone, contactPerson, email, company, note }
      : null;
  return { input, fieldErrors };
}

/** 应用层用例（T-03）的动态解析：仅用相对 URL 运行时解析，避免编译期耦合。 */
let cachedUseCase: Promise<CustomerUseCaseFn | null> | null = null;

async function loadApplicationModule(): Promise<Record<string, unknown> | null> {
  try {
    const specifier = new URL('../application/create-customer.ts', import.meta.url).href;
    const mod: unknown = await import(specifier);
    return mod as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resolveCreateCustomerUseCase(): Promise<CustomerUseCaseFn | null> {
  cachedUseCase ??= (async (): Promise<CustomerUseCaseFn | null> => {
    const mod = await loadApplicationModule();
    if (mod === null) return null;
    const preferredKeys = [
      'createCustomer',
      'createCustomerUseCase',
      'execute',
      'handler',
      'default',
    ];
    for (const key of preferredKeys) {
      const fn = mod[key];
      if (typeof fn === 'function') return fn as CustomerUseCaseFn;
    }
    for (const key of Object.keys(mod)) {
      const fn = mod[key];
      if (typeof fn === 'function' && /create/i.test(key)) return fn as CustomerUseCaseFn;
    }
    return null;
  })();
  return cachedUseCase;
}

function actorOf(context: RequestContext): PersonRefView {
  const principal = context.principal;
  const userId =
    principal !== undefined && typeof principal.userId === 'string' && principal.userId.length > 0
      ? principal.userId
      : 'system';
  const displayName =
    principal !== undefined &&
    typeof principal.displayName === 'string' &&
    principal.displayName.length > 0
      ? principal.displayName
      : userId;
  return { userId, displayName };
}

function buildUseCaseContext(requestId: string, context: RequestContext): Record<string, unknown> {
  const actor = actorOf(context);
  return {
    ...context,
    requestId,
    actor,
    principal: context.principal ?? actor,
    clock: { now: () => new Date() },
  };
}

function normalizeExistingCustomer(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string' && v.length > 0) return { name: v };
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const customerId = o.customerId ?? o.customer_id;
    const name = o.name;
    const phone = o.phone;
    if (typeof customerId === 'string') out.customerId = customerId;
    if (typeof name === 'string') out.name = name;
    if (typeof phone === 'string') out.phone = phone;
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

/** 用例异常/失败结果 → HTTP 映射：字段错误 422；电话占用 409；其余 500（不吞异常）。 */
function outcomeFromFailureSource(
  source: Record<string, unknown>,
  requestId: string,
): HttpOutcome {
  const details =
    source.details !== null && typeof source.details === 'object'
      ? (source.details as Record<string, unknown>)
      : undefined;
  const errs = normalizeFieldErrors(
    source.fieldErrors ?? source.errors ?? details?.fieldErrors,
  );
  if (errs.length > 0) return validationOutcome(errs, requestId);

  const code = typeof source.code === 'string' ? source.code : '';
  const errName = typeof source.name === 'string' ? source.name : '';
  const message =
    typeof source.message === 'string' && source.message.length > 0
      ? source.message
      : '创建客户失败，请稍后重试。';

  if (
    code === 'CUSTOMER_PHONE_TAKEN' ||
    code === 'PHONE_TAKEN' ||
    /phone.?taken/i.test(errName)
  ) {
    const existing = normalizeExistingCustomer(
      source.existingCustomer ?? details?.existingCustomer ?? source.summary,
    );
    const existingName =
      existing !== null && typeof existing.name === 'string' ? existing.name : null;
    return jsonOutcome(
      409,
      errorBody(
        'CUSTOMER_PHONE_TAKEN',
        existingName !== null
          ? `联系电话已被客户「${existingName}」占用，未创建新记录。`
          : '联系电话已被占用，未创建新记录。',
        requestId,
        { details: existing !== null ? { existingCustomer: existing } : undefined },
      ),
    );
  }

  const rawStatus =
    typeof source.status === 'number' && source.status >= 400 && source.status <= 599
      ? source.status
      : 500;
  const status = rawStatus >= 500 ? 500 : rawStatus;
  if (status === 422) {
    return validationOutcome(
      [{ field: '*', code: 'INVALID_FORMAT', message }],
      requestId,
    );
  }
  return jsonOutcome(
    status,
    errorBody(code !== '' ? code : 'INTERNAL_ERROR', message, requestId),
  );
}

function extractCustomerRecord(result: unknown): Record<string, unknown> | null {
  let current: unknown = result;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current === null || typeof current !== 'object') return null;
    const o = current as Record<string, unknown>;
    if (
      o.customerId !== undefined ||
      o.customer_id !== undefined ||
      o.id !== undefined
    ) {
      return o;
    }
    const next = o.customer ?? o.value ?? o.record ?? o.data ?? o.result ?? o.entity;
    if (next === undefined) return null;
    current = next;
  }
  return null;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function pickIso(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = record[key];
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  }
  return null;
}

function pickPerson(v: unknown, fallback: PersonRefView): PersonRefView {
  if (typeof v === 'string' && v.length > 0) return { userId: v, displayName: v };
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const userId = typeof o.userId === 'string' && o.userId.length > 0 ? o.userId : null;
    if (userId !== null) {
      const displayName =
        typeof o.displayName === 'string' && o.displayName.length > 0 ? o.displayName : userId;
      return { userId, displayName };
    }
  }
  return fallback;
}

function toCustomerDetail(
  record: Record<string, unknown>,
  context: RequestContext,
): CustomerDetailView | null {
  const customerId = pickString(record, ['customerId', 'customer_id', 'id']);
  const name = pickString(record, ['name']);
  const phone = pickString(record, ['phone']);
  if (customerId === null || customerId.length === 0 || name === null || phone === null) {
    return null;
  }
  const actor = actorOf(context);
  const nowIso = new Date().toISOString();
  const recent = record.recentChanges ?? record.recent_changes;
  const createdBy = pickPerson(record.createdBy ?? record.created_by, actor);
  return {
    customerId,
    name,
    contactPerson: pickString(record, ['contactPerson', 'contact_person']),
    phone,
    email: pickString(record, ['email']),
    company: pickString(record, ['company']),
    note: pickString(record, ['note']),
    version: pickNumber(record, ['version']) ?? 1,
    createdAt: pickIso(record, ['createdAt', 'created_at']) ?? nowIso,
    updatedAt: pickIso(record, ['updatedAt', 'updated_at']) ?? nowIso,
    createdBy,
    updatedBy: pickPerson(record.updatedBy ?? record.updated_by, createdBy),
    recentChanges: Array.isArray(recent) ? recent : [],
  };
}

/**
 * 框架无关的端点处理：输入可以是 JSON 字符串或已解析对象。
 * 返回 {status, headers, body}；任何失败路径都不会调用写入或产生记录。
 */
export async function handleCreateCustomer(
  body: unknown,
  context: RequestContext = {},
): Promise<HttpOutcome> {
  const requestId =
    typeof context.requestId === 'string' && context.requestId.length > 0
      ? context.requestId
      : randomUUID();

  let payload: unknown = body;
  if (typeof body === 'string') {
    if (body.trim().length === 0) {
      return jsonOutcome(400, errorBody('BAD_REQUEST', '请求体不能为空。', requestId));
    }
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      return jsonOutcome(400, errorBody('MALFORMED_JSON', '请求体不是合法的 JSON。', requestId));
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonOutcome(400, errorBody('BAD_REQUEST', '请求体必须为 JSON 对象。', requestId));
  }

  const { input, fieldErrors } = validateCreateCustomerBody(
    payload as Record<string, unknown>,
  );
  if (input === null || fieldErrors.length > 0) {
    return validationOutcome(
      fieldErrors.length > 0
        ? fieldErrors
        : [{ field: '*', code: 'REQUIRED', message: '请求字段校验未通过。' }],
      requestId,
    );
  }

  const useCase = context.useCase ?? (await resolveCreateCustomerUseCase());
  if (useCase === null || useCase === undefined) {
    return jsonOutcome(
      500,
      errorBody(
        'CREATE_CUSTOMER_UNAVAILABLE',
        '创建用例不可用（应用层 createCustomer 未装配）。',
        requestId,
      ),
    );
  }

  const useCaseContext = buildUseCaseContext(requestId, context);
  let result: unknown;
  try {
    result = await useCase(input, useCaseContext);
    if (typeof result === 'function') {
      result = await (result as CustomerUseCaseFn)(input, useCaseContext);
    }
  } catch (err) {
    const source =
      err !== null && typeof err === 'object'
        ? (err as Record<string, unknown>)
        : { message: String(err) };
    return outcomeFromFailureSource(source, requestId);
  }

  if (result !== null && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r.ok === false || r.success === false) {
      return outcomeFromFailureSource(r, requestId);
    }
  }

  const record = extractCustomerRecord(result);
  if (record === null) {
    return jsonOutcome(
      500,
      errorBody('INVALID_USECASE_RESULT', '创建用例返回结果无法解析。', requestId),
    );
  }
  const detail = toCustomerDetail(record, context);
  if (detail === null) {
    return jsonOutcome(
      500,
      errorBody('INVALID_USECASE_RESULT', '创建用例返回结果缺少必要字段。', requestId),
    );
  }
  return jsonOutcome(201, detail, {
    Location: `${CREATE_CUSTOMER_PATH}/${encodeURIComponent(detail.customerId)}`,
  });
}

function firstHeaderValue(req: HttpRequestLike, name: string): string | undefined {
  const h = req.headers[name];
  if (Array.isArray(h)) return h[0];
  return typeof h === 'string' ? h : undefined;
}

function readRequestBody(req: HttpRequestLike, limitBytes = 1_048_576): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = '';
    let overflow = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (overflow) return;
      text += chunk;
      if (Buffer.byteLength(text, 'utf8') > limitBytes) {
        overflow = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (overflow) {
        reject(new Error('request body too large'));
      } else {
        resolve(text);
      }
    });
    req.on('error', () => reject(new Error('request body read error')));
  });
}

function writeOutcome(res: HttpResponseLike, outcome: HttpOutcome): void {
  res.statusCode = outcome.status;
  for (const [name, value] of Object.entries(outcome.headers)) {
    res.setHeader(name, value);
  }
  res.end(JSON.stringify(outcome.body));
}

/**
 * node:http 兼容处理器工厂：`app.post('/api/v1/customers', createCustomerNodeHandler())`
 * 或直接作为 (req, res) 监听器使用。options 可注入 useCase/principal。
 */
export function createCustomerNodeHandler(
  options: RequestContext = {},
): (req: HttpRequestLike, res: HttpResponseLike) => Promise<void> {
  return async (req, res) => {
    const requestId = firstHeaderValue(req, 'x-request-id') ?? randomUUID();
    if (typeof req.method === 'string' && req.method.toUpperCase() !== 'POST') {
      writeOutcome(res, {
        status: 405,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Allow: 'POST',
        },
        body: errorBody('METHOD_NOT_ALLOWED', '该端点仅支持 POST。', requestId),
      });
      return;
    }
    let text: string;
    try {
      text = await readRequestBody(req);
    } catch {
      writeOutcome(
        res,
        jsonOutcome(400, errorBody('BAD_REQUEST', '请求体读取失败或超出大小限制。', requestId)),
      );
      return;
    }
    const outcome = await handleCreateCustomer(text, {
      ...options,
      requestId,
      rawRequest: req,
    });
    writeOutcome(res, outcome);
  };
}

/** 常用别名，便于不同装配风格引用。 */
export const createCustomerHandler = createCustomerNodeHandler;
export const createCustomerRequestHandler = createCustomerNodeHandler;

export interface CreateCustomerRoute {
  method: 'POST';
  path: string;
  handler: (req: HttpRequestLike, res: HttpResponseLike) => Promise<void>;
}

export function createCustomerRoute(options: RequestContext = {}): CreateCustomerRoute {
  return {
    method: 'POST',
    path: CREATE_CUSTOMER_PATH,
    handler: createCustomerNodeHandler(options),
  };
}

/**
 * 兼容多种 T-04 应用形态的挂载辅助：
 * 数组路由表（push {method,path,handler}）或对象 app（.post/.addRoute/.route/.registerRoute）。
 * 返回是否成功挂载。
 */
export function registerCreateCustomerRoute(
  target: unknown,
  options: RequestContext = {},
): boolean {
  if (Array.isArray(target)) {
    target.push(createCustomerRoute(options));
    return true;
  }
  if (target !== null && typeof target === 'object') {
    const holder = target as Record<string, unknown>;
    const handler = createCustomerNodeHandler(options);
    if (typeof holder.post === 'function') {
      (holder.post as (path: string, h: typeof handler) => unknown).call(
        target,
        CREATE_CUSTOMER_PATH,
        handler,
      );
      return true;
    }
    for (const fnName of ['addRoute', 'route', 'registerRoute', 'handle'] as const) {
      const fn = holder[fnName];
      if (typeof fn === 'function') {
        (fn as (method: string, path: string, h: typeof handler) => unknown).call(
          target,
          'POST',
          CREATE_CUSTOMER_PATH,
          handler,
        );
        return true;
      }
    }
  }
  return false;
}

export default createCustomerNodeHandler;
