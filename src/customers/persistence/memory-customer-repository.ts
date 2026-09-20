/**
 * T-02（切片 S-1）：客户内存假仓储。
 *
 * 对齐 data-model.md `crm.customer` 的表级语义，供 Node 测试运行器在无真实数据库时使用：
 * - insert：镜像新增路径（version=1；customer_id/created_at/created_by 由服务端赋值；
 *   created_at/updated_at 创建即固定、创建后不可变；两列在同一 INSERT 内取同一 now()）。
 *   本任务强制 PK(customer_id) 与 phone_key 唯一；电话冲突按 PhoneTaken 语义抛出
 *   带已有客户名称摘要的 PhoneTakenError。
 * - findById / count：只读，count 供"冲突后记录数不变"类断言使用。
 * - updateVersioned：镜像
 *   `UPDATE crm.customer SET <提交字段>, version = version + 1, updated_by = $u,
 *    updated_at = now() WHERE customer_id = $1 AND version = $2`；
 *   影响 0 行时以 rowExists 区分，由应用层判定 404 或 409 CUSTOMER_VERSION_CONFLICT。
 *   customer_id、version、created_at、created_by、updated_by、updated_at 永不进入更新集（不可变列守卫）。
 *
 * 边界：
 * - 行以 data-model.md 的 snake_case 列名为准（契约 camelCase 映射属 api 层）。
 * - 时间戳为 UTC ISO-8601（'Z'，可含小数秒），字符串序即时间序，保证
 *   (updated_at desc, customer_id asc) 排序键稳定（供 T-15 检索复用）。
 * - 仓储只执行表级守卫（NOT NULL/CHECK 型：长度、非空、编号形状、版本与时间形状、
 *   列不可变性、PK 唯一）；字段业务格式规则属领域层（T-01），不在此重复判定。
 * - 所有出入参均深拷贝且存储行冻结，外部对象无法改写或伪造创建事实。
 * - phone_key 语义：构造注入 phoneKeyFor（T-07 归一化实现）时按 STORED 生成列处理——
 *   随 phone 提交自动重算并校验与派生值一致；未注入时按退化口径要求调用方随行提交
 *   （数据模型允许的"应用层写入 phone_key 并保留唯一索引兜底"路径）。
 */

import type { ChangeLogEntry } from '../domain/changelog.js';

export const CUSTOMER_ID_PATTERN: RegExp = /^[A-Z]{2,4}-[0-9A-Za-z-]{6,32}$/;
const UTC_TIMESTAMP_PATTERN: RegExp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PHONE_KEY_PATTERN: RegExp = /^[0-9+]{1,20}$/;

/** 一行 crm.customer（生成列 phone_key 已按归一化值物化）。 */
export interface CustomerRecord {
  readonly customer_id: string;
  readonly name: string;
  readonly contact_person: string | null;
  readonly phone: string;
  readonly phone_key: string;
  readonly email: string | null;
  readonly company: string | null;
  readonly note: string | null;
  readonly version: number;
  readonly created_by: string;
  readonly updated_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 新增行入参；缺列/形状错误按表级 CHECK 报错，version 缺省即 DEFAULT 1。 */
export type CustomerInsertInput = Partial<CustomerRecord>;

const MUTABLE_COLUMNS = ['name', 'contact_person', 'phone', 'phone_key', 'email', 'company', 'note'] as const;
const IMMUTABLE_COLUMNS = ['customer_id', 'version', 'created_by', 'created_at', 'updated_by', 'updated_at'] as const;
const KNOWN_COLUMNS: readonly string[] = [...MUTABLE_COLUMNS, ...IMMUTABLE_COLUMNS];

type MutableColumn = (typeof MUTABLE_COLUMNS)[number];

/** 局部更新提交的列；undefined（含未提交）= 不改，null = 清空（可空列）。 */
export interface CustomerVersionedPatch {
  readonly name?: string | undefined;
  readonly contact_person?: string | null | undefined;
  readonly phone?: string | undefined;
  readonly phone_key?: string | undefined;
  readonly email?: string | null | undefined;
  readonly company?: string | null | undefined;
  readonly note?: string | null | undefined;
}

/** 版本条件更新的调用参数（updatedBy/updatedAt 由用例的 Clock 提供，对应 $u 与 now()）。 */
export interface CustomerVersionedUpdateInput {
  readonly customerId: string;
  readonly expectedVersion: number;
  readonly patch: CustomerVersionedPatch;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** UPDATE 的结果按"影响行数"表达；0 行时由应用层依 rowExists 判 404 / 版本冲突 409。 */
export type CustomerUpdateResult =
  | { readonly applied: true; readonly rowCount: 1; readonly record: CustomerRecord }
  | { readonly applied: false; readonly rowCount: 0; readonly rowExists: boolean };

/** 关键词查询结果；items 保持持久化行形状，由应用层映射为契约摘要。 */
export interface CustomerSearchResult {
  readonly items: readonly CustomerRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** 归一化函数端口：由 T-07 的 phone-key 实现在构造时注入（同 STORED 生成列表达式）。 */
export type PhoneKeyDeriver = (phone: string) => string;

export interface MemoryCustomerRepositoryOptions {
  readonly phoneKeyFor?: PhoneKeyDeriver | undefined;
}

/** 仓储端口：内存假实现与后续 Drizzle 适配仓储保持同一语义。 */
export interface CustomerRepository {
  insert(input: CustomerInsertInput): Promise<CustomerRecord>;
  findById(customerId: string): Promise<CustomerRecord | null>;
  count(): Promise<number>;
  search(keyword: string, page: number, pageSize: number): Promise<CustomerSearchResult>;
  updateVersioned(input: CustomerVersionedUpdateInput): Promise<CustomerUpdateResult>;
}

export interface CustomerChangeLogStore {
  listChanges(customerId: string): Promise<readonly ChangeLogEntry[]>;
}

export class CustomerSchemaError extends Error {
  readonly code: string = 'CUSTOMER_SCHEMA_VIOLATION';
  readonly column: string | null;

  constructor(message: string, column: string | null = null) {
    super(message);
    this.name = 'CustomerSchemaError';
    this.column = column;
  }
}

/** PK(customer_id) 冲突。 */
export class DuplicateCustomerIdError extends Error {
  readonly code: string = 'CUSTOMER_ID_CONFLICT';
  readonly customerId: string;

  constructor(customerId: string) {
    super(`customer_id "${customerId}" already exists (customer_pkey)`);
    this.name = 'DuplicateCustomerIdError';
    this.customerId = customerId;
  }
}

/** 电话归一化键冲突；用于映射契约的 CUSTOMER_PHONE_TAKEN/409。 */
export class PhoneTakenError extends Error {
  readonly code = 'CUSTOMER_PHONE_TAKEN';
  readonly phoneKey: string;
  readonly existingCustomer: Readonly<{
    customerId: string;
    name: string;
  }>;

  constructor(phoneKey: string, existing: Pick<CustomerRecord, 'customer_id' | 'name'>) {
    super(`phone_key "${phoneKey}" already belongs to customer "${existing.name}"`);
    this.name = 'PhoneTakenError';
    this.phoneKey = phoneKey;
    this.existingCustomer = Object.freeze({
      customerId: existing.customer_id,
      name: existing.name,
    });
  }
}

/** 不可变列出现在更新集中（customer_id、version、created_at、created_by、updated_by、updated_at）。 */
export class ImmutableCustomerColumnError extends Error {
  readonly code: string = 'CUSTOMER_IMMUTABLE_COLUMN';
  readonly columns: readonly string[];

  constructor(columns: readonly string[]) {
    super(`immutable column(s) cannot enter UPDATE: ${columns.join(', ')}`);
    this.name = 'ImmutableCustomerColumnError';
    this.columns = [...columns];
  }
}

function readRequiredText(value: unknown, column: string, max: number, nonBlank: boolean): string {
  if (typeof value !== 'string') {
    throw new CustomerSchemaError(`NOT NULL violated: ${column} must be a string`, column);
  }
  if (value.length === 0 || value.length > max) {
    throw new CustomerSchemaError(`CHECK violated: ${column} length must be 1..${max}`, column);
  }
  if (nonBlank && value.trim().length === 0) {
    throw new CustomerSchemaError(`CHECK violated: ${column} must not be blank after trim`, column);
  }
  return value;
}

function readNullableText(value: unknown, column: string, max: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return readRequiredText(value, column, max, false);
}

function readTimestamp(value: unknown, column: string): string {
  const text = readRequiredText(value, column, 40, true);
  if (!UTC_TIMESTAMP_PATTERN.test(text)) {
    throw new CustomerSchemaError(`CHECK violated: ${column} must be a UTC ISO-8601 timestamp with 'Z'`, column);
  }
  return text;
}

function sortedOffending(keys: readonly string[], set: readonly string[]): string[] {
  return keys.filter((key) => set.includes(key)).sort();
}

export class MemoryCustomerRepository implements CustomerRepository {
  readonly #rows = new Map<string, CustomerRecord>();
  readonly #changes = new Map<string, ChangeLogEntry[]>();
  readonly #phoneKeyFor: PhoneKeyDeriver | undefined;

  constructor(options: MemoryCustomerRepositoryOptions = {}) {
    this.#phoneKeyFor = options.phoneKeyFor;
  }

  /** 插入一行；校验全部通过后才写 Map，任何失败不产生半记录（整体回滚语义）。 */
  async insert(input: CustomerInsertInput): Promise<CustomerRecord> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new CustomerSchemaError('INSERT input must be a row object');
    }
    const keys = Object.keys(input);
    const unknown = sortedOffending(
      keys.filter((key) => !KNOWN_COLUMNS.includes(key)),
      keys,
    );
    if (unknown.length > 0) {
      throw new CustomerSchemaError(`unknown column(s) in INSERT: ${unknown.join(', ')}`, unknown[0] ?? null);
    }
    if (input.version !== undefined && (!Number.isInteger(input.version) || input.version !== 1)) {
      throw new CustomerSchemaError('INSERT requires version = 1 (data-model: NOT NULL DEFAULT 1)', 'version');
    }

    const customerId = readRequiredText(input.customer_id, 'customer_id', 40, true);
    if (!CUSTOMER_ID_PATTERN.test(customerId)) {
      throw new CustomerSchemaError(
        'customer_id must match ^[A-Z]{2,4}-[0-9A-Za-z-]{6,32}$ (server-generated, immutable after creation)',
        'customer_id',
      );
    }
    const createdBy = readRequiredText(input.created_by, 'created_by', 64, true);
    const updatedBy = readRequiredText(input.updated_by, 'updated_by', 64, true);
    const createdAt = readTimestamp(input.created_at, 'created_at');
    const updatedAt = readTimestamp(input.updated_at, 'updated_at');
    if (createdAt !== updatedAt) {
      throw new CustomerSchemaError(
        'created_at/updated_at are creation-time facts assigned once by the same INSERT now() and must be equal; immutability after creation is enforced by this repository',
        'updated_at',
      );
    }

    const columns = this.#resolveColumns(null, {
      name: input.name,
      contact_person: input.contact_person,
      phone: input.phone,
      phone_key: input.phone_key,
      email: input.email,
      company: input.company,
      note: input.note,
    });

    const row: CustomerRecord = Object.freeze({
      customer_id: customerId,
      name: columns.name,
      contact_person: columns.contact_person,
      phone: columns.phone,
      phone_key: columns.phone_key,
      email: columns.email,
      company: columns.company,
      note: columns.note,
      version: 1,
      created_by: createdBy,
      updated_by: updatedBy,
      created_at: createdAt,
      updated_at: updatedAt,
    });

    if (this.#rows.has(row.customer_id)) {
      throw new DuplicateCustomerIdError(row.customer_id);
    }
    const phoneOwner = [...this.#rows.values()].find((stored) => stored.phone_key === row.phone_key);
    if (phoneOwner !== undefined) {
      throw new PhoneTakenError(row.phone_key, phoneOwner);
    }
    this.#rows.set(row.customer_id, row);
    return { ...row };
  }

  /** 主键读取；未命中返回 null（customer_pkey）。 */
  async findById(customerId: string): Promise<CustomerRecord | null> {
    const row = this.#rows.get(customerId);
    return row === undefined ? null : { ...row };
  }

  /** 全表行数（唯一冲突后计数不变的断言入口）。 */
  async count(): Promise<number> {
    return this.#rows.size;
  }

  /**
   * 关键词分页：名称/联系人大小写不敏感包含匹配，电话按归一化键包含匹配；
   * 固定 updated_at DESC、customer_id ASC 排序，避免翻页时重复或遗漏。
   */
  async search(keyword: string, page: number, pageSize: number): Promise<CustomerSearchResult> {
    if (!Number.isInteger(page) || page < 1) {
      throw new CustomerSchemaError('page must be an integer >= 1', 'page');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new CustomerSchemaError('pageSize must be an integer from 1 to 100', 'pageSize');
    }
    if (typeof keyword !== 'string') {
      throw new CustomerSchemaError('keyword must be a string', 'keyword');
    }

    const trimmed = keyword.trim();
    const folded = trimmed.toLowerCase();
    const phoneKeyword = this.#phoneKeyFor?.(trimmed) ?? trimmed.replace(/[^0-9+]/g, '');
    const matched = [...this.#rows.values()].filter((row) => {
      if (folded.length === 0) return true;
      if (row.name.toLowerCase().includes(folded)) return true;
      if (row.contact_person?.toLowerCase().includes(folded)) return true;
      return phoneKeyword.length > 0 && row.phone_key.includes(phoneKeyword);
    });
    matched.sort((left, right) => {
      const byUpdatedAt = right.updated_at.localeCompare(left.updated_at);
      return byUpdatedAt !== 0 ? byUpdatedAt : left.customer_id.localeCompare(right.customer_id);
    });
    const start = (page - 1) * pageSize;
    return {
      items: matched.slice(start, start + pageSize).map((row) => ({ ...row })),
      page,
      pageSize,
      total: matched.length,
    };
  }

  /** 详情用例读取的内存留痕；结果按最新时间倒序且为副本。 */
  async listChanges(customerId: string): Promise<readonly ChangeLogEntry[]> {
    const entries = this.#changes.get(customerId) ?? [];
    return entries
      .slice()
      .sort((left, right) => right.changedAt.localeCompare(left.changedAt))
      .map((entry) => ({ ...entry }));
  }

  /** 更新与留痕的内存原子组合；Map 写入本身不再引入第二个失败点。 */
  async updateVersionedWithChanges(
    input: CustomerVersionedUpdateInput,
    changes: readonly ChangeLogEntry[],
  ): Promise<CustomerUpdateResult> {
    const result = await this.updateVersioned(input);
    if (result.applied && changes.length > 0) {
      const previous = this.#changes.get(input.customerId) ?? [];
      this.#changes.set(input.customerId, [
        ...previous,
        ...changes.map((entry) => ({ ...entry })),
      ]);
    }
    return result;
  }

  /**
   * 版本条件更新：WHERE customer_id = $1 AND version = $2。
   * SET 子句先行解析（未知/不可变列在任何匹配前即报错，与 PG 语义一致），
   * 成功时仅 version、updated_by、updated_at 与提交列变化，created_at、created_by、customer_id 原样保留。
   */
  async updateVersioned(input: CustomerVersionedUpdateInput): Promise<CustomerUpdateResult> {
    const customerId = readRequiredText(input.customerId, 'customer_id', 40, true);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new CustomerSchemaError('expectedVersion must be an integer >= 1 (version CHECK >= 1)', 'version');
    }
    const updatedBy = readRequiredText(input.updatedBy, 'updated_by', 64, true);
    const updatedAt = readTimestamp(input.updatedAt, 'updated_at');
    if (input.patch === null || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
      throw new CustomerSchemaError('patch must be an object of submitted mutable columns', 'patch');
    }
    this.#assertPatchKeys(input.patch);

    const stored = this.#rows.get(customerId);
    if (stored === undefined) {
      return { applied: false, rowCount: 0, rowExists: false };
    }

    const columns = this.#resolveColumns(stored, input.patch);

    if (stored.version !== input.expectedVersion) {
      return { applied: false, rowCount: 0, rowExists: true };
    }

    const next: CustomerRecord = Object.freeze({
      customer_id: stored.customer_id,
      name: columns.name,
      contact_person: columns.contact_person,
      phone: columns.phone,
      phone_key: columns.phone_key,
      email: columns.email,
      company: columns.company,
      note: columns.note,
      version: stored.version + 1,
      created_by: stored.created_by,
      updated_by: updatedBy,
      created_at: stored.created_at,
      updated_at: updatedAt,
    });
    const phoneOwner = [...this.#rows.values()].find(
      (candidate) =>
        candidate.customer_id !== stored.customer_id && candidate.phone_key === next.phone_key,
    );
    if (phoneOwner !== undefined) {
      throw new PhoneTakenError(next.phone_key, phoneOwner);
    }
    this.#rows.set(customerId, next);
    return { applied: true, rowCount: 1, record: { ...next } };
  }

  #assertPatchKeys(patch: CustomerVersionedPatch): void {
    const keys = Object.keys(patch);
    const immutableHits = sortedOffending(keys, IMMUTABLE_COLUMNS);
    if (immutableHits.length > 0) {
      throw new ImmutableCustomerColumnError(immutableHits);
    }
    const unknown = sortedOffending(
      keys.filter((key) => !MUTABLE_COLUMNS.includes(key as MutableColumn)),
      keys,
    );
    if (unknown.length > 0) {
      throw new CustomerSchemaError(`unknown column(s) in UPDATE SET: ${unknown.join(', ')}`, unknown[0] ?? null);
    }
  }

  #resolveColumns(stored: CustomerRecord | null, patch: CustomerVersionedPatch): Pick<CustomerRecord, MutableColumn> {
    const name = submitted(patch, 'name');
    const contactPerson = submitted(patch, 'contact_person');
    const phone = submitted(patch, 'phone');
    const phoneKey = submitted(patch, 'phone_key');
    const email = submitted(patch, 'email');
    const company = submitted(patch, 'company');
    const note = submitted(patch, 'note');

    const submittedCount = [name, contactPerson, phone, phoneKey, email, company, note].filter(
      (value) => value !== undefined,
    ).length;
    if (submittedCount === 0) {
      throw new CustomerSchemaError('UPDATE must submit at least one mutable column (CustomerUpdateRequest minProperties: 1)');
    }
    if (phone === undefined && phoneKey !== undefined) {
      throw new CustomerSchemaError('phone_key is a generated column; it changes only together with phone', 'phone_key');
    }

    let nameValue: string;
    if (name !== undefined) {
      nameValue = readRequiredText(name, 'name', 100, true);
    } else if (stored !== null) {
      nameValue = stored.name;
    } else {
      throw new CustomerSchemaError('NOT NULL violated: name is required for INSERT', 'name');
    }

    let phoneValue: string;
    if (phone !== undefined) {
      phoneValue = readRequiredText(phone, 'phone', 20, true);
    } else if (stored !== null) {
      phoneValue = stored.phone;
    } else {
      throw new CustomerSchemaError('NOT NULL violated: phone is required for INSERT', 'phone');
    }

    const contactValue = contactPerson !== undefined ? readNullableText(contactPerson, 'contact_person', 50) : stored === null ? null : stored.contact_person;
    const emailValue = email !== undefined ? readNullableText(email, 'email', 100) : stored === null ? null : stored.email;
    const companyValue = company !== undefined ? readNullableText(company, 'company', 100) : stored === null ? null : stored.company;
    const noteValue = note !== undefined ? readNullableText(note, 'note', 1000) : stored === null ? null : stored.note;

    let phoneKeyValue: string;
    if (phone !== undefined) {
      if (this.#phoneKeyFor !== undefined) {
        const derived = this.#phoneKeyFor(phoneValue);
        if (typeof derived !== 'string' || !PHONE_KEY_PATTERN.test(derived)) {
          throw new CustomerSchemaError(
            'phoneKeyFor must return the normalized key (digits and "+", 1..20 chars), matching the STORED generated column expression',
            'phone_key',
          );
        }
        if (phoneKey !== undefined && phoneKey !== derived) {
          throw new CustomerSchemaError('phone_key is GENERATED ALWAYS; a submitted value must equal the derived key', 'phone_key');
        }
        phoneKeyValue = derived;
      } else {
        if (phoneKey === undefined || phoneKey === null) {
          throw new CustomerSchemaError(
            'INSERT or phone change requires phone_key: inject phoneKeyFor (T-07 normalizer) or submit the normalized key with phone',
            'phone_key',
          );
        }
        if (!PHONE_KEY_PATTERN.test(phoneKey)) {
          throw new CustomerSchemaError('CHECK violated: phone_key must contain only digits and "+", length 1..20', 'phone_key');
        }
        phoneKeyValue = phoneKey;
      }
    } else if (stored !== null) {
      phoneKeyValue = stored.phone_key;
    } else {
      throw new CustomerSchemaError('phone_key is required for INSERT', 'phone_key');
    }

    return {
      name: nameValue,
      contact_person: contactValue,
      phone: phoneValue,
      phone_key: phoneKeyValue,
      email: emailValue,
      company: companyValue,
      note: noteValue,
    };
  }
}

/** 提交判定：键存在且值非 undefined 视为"已提交"（JSON 无 undefined；null 表示清空）。 */
function submitted(patch: CustomerVersionedPatch, key: keyof CustomerVersionedPatch): string | null | undefined {
  return Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : undefined;
}
