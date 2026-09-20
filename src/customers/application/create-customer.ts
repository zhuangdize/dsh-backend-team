/**
 * T-03 —— createCustomer 用例（垂直切片 S-1；AC-001、AC-002）。
 *
 * 应用层只编排边界：把已解码的请求交给 Customer 聚合校验和构建，
 * 再把聚合快照映射为 T-02 仓储的 snake_case 行。领域规则只存在于
 * T-01；本层不再复制一份校验逻辑。
 */

import {
  Customer,
  type CustomerActor,
  type CustomerCreateDeps,
  type CustomerInput,
  type CreateResult,
  type FieldError,
} from '../domain/customer.js';
import type {
  CustomerInsertInput,
  CustomerRecord,
  CustomerRepository,
} from '../persistence/memory-customer-repository.js';

export type { FieldError };
export type FieldErrorCode = FieldError['code'];
export type CustomerFieldName = string;

/** 请求体在 HTTP 解码后的形状；未知字段由契约层显式拒绝。 */
export type CreateCustomerDraft = Partial<CustomerInput> & Record<string, unknown>;

export interface CreateCustomerDependencies {
  readonly repository: Pick<CustomerRepository, 'insert'>;
  readonly actor: CustomerActor;
  /** 领域时钟、随机源和编号生成器只通过 T-01 注入。 */
  readonly domain?: CustomerCreateDeps;
  /** T-07 接入后可注入正式电话归一化器；当前使用数据模型的退化归一。 */
  readonly phoneKeyFor?: (phone: string) => string;
  /** 供 API 层把 422 关联到请求。 */
  readonly requestId?: string;
}

/** 字段校验失败；API 层可直接映射为 422 fieldErrors。 */
export class CreateCustomerValidationError extends Error {
  readonly fieldErrors: readonly FieldError[];
  readonly requestId: string | undefined;

  constructor(fieldErrors: readonly FieldError[], requestId?: string) {
    super(`客户字段校验失败: ${fieldErrors.map((entry) => `${entry.field}(${entry.code})`).join(', ')}`);
    this.name = 'CreateCustomerValidationError';
    this.fieldErrors = Object.freeze(fieldErrors.map((entry) => ({ ...entry })));
    this.requestId = requestId;
  }
}

/**
 * 兼容早期调用方的纯校验入口。实际校验仍由 Customer.create 执行，
 * 不在应用层维护第二套规则。
 */
export type NormalizedCreateCustomerInput = {
  readonly name: string;
  readonly phone: string;
  readonly contactPerson: string | null;
  readonly email: string | null;
  readonly company: string | null;
  readonly note: string | null;
};
export type NormalizeResult =
  | { readonly ok: true; readonly value: NormalizedCreateCustomerInput }
  | { readonly ok: false; readonly fieldErrors: readonly FieldError[] };

export function normalizeCreateCustomerDraft(draft: CreateCustomerDraft): NormalizeResult {
  const result = Customer.create(
    draft as CustomerInput,
    { userId: 'validation-probe' },
    {
      newCustomerId: () => 'CST-VALIDATION000',
      clock: { now: () => new Date(0) },
    },
  );
  if (!result.ok) return { ok: false, fieldErrors: result.errors };
  const snapshot = result.customer.snapshot();
  return {
    ok: true,
    value: {
      name: snapshot.name,
      phone: snapshot.phone,
      contactPerson: snapshot.contactPerson,
      email: snapshot.email,
      company: snapshot.company,
      note: snapshot.note,
    },
  };
}

/**
 * Convert the domain snapshot to the persistence row expected by T-02.
 * The repository receives one complete row only after domain creation has
 * succeeded, so validation and aggregate construction cannot leave a record.
 */
function toInsertInput(
  snapshot: ReturnType<Customer['snapshot']>,
  phoneKeyFor?: (phone: string) => string,
): CustomerInsertInput {
  const phoneKey = phoneKeyFor?.(snapshot.phone) ?? snapshot.phone.replace(/[\s().-]/g, '');
  return {
    customer_id: snapshot.customerId,
    name: snapshot.name,
    contact_person: snapshot.contactPerson,
    phone: snapshot.phone,
    phone_key: phoneKey,
    email: snapshot.email,
    company: snapshot.company,
    note: snapshot.note,
    version: snapshot.version,
    created_by: snapshot.createdBy,
    updated_by: snapshot.updatedBy,
    created_at: snapshot.createdAt.toISOString(),
    updated_at: snapshot.updatedAt.toISOString(),
  };
}

/**
 * 领域校验 → 聚合构建 → 单次仓储落库。
 *
 * `Customer.create` 返回失败结果时，仓储尚未被调用；仓储异常原样上抛，
 * 因而唯一的写入边界由仓储负责保持原子性。成功返回领域聚合，调用方可
 * 通过其快照或仓储返回的 CustomerRecord 生成契约响应。
 */
export async function createCustomer(
  draft: CreateCustomerDraft,
  dependencies: CreateCustomerDependencies,
): Promise<Customer> {
  const created: CreateResult = Customer.create(
    draft as CustomerInput,
    dependencies.actor,
    dependencies.domain,
  );
  if (!created.ok) {
    throw new CreateCustomerValidationError(created.errors, dependencies.requestId);
  }

  const input = toInsertInput(created.customer.snapshot(), dependencies.phoneKeyFor);
  await dependencies.repository.insert(input);
  return created.customer;
}

/** Shared mapping for API adapters that need the persisted row shape. */
export function customerRecordFromAggregate(
  customer: Customer,
  phoneKeyFor?: (phone: string) => string,
): CustomerRecord {
  return { ...toInsertInput(customer.snapshot(), phoneKeyFor) } as CustomerRecord;
}
