/** T-24：客户局部更新用例（S-4；AC-006、AC-008、AC-009）。 */

import {
  Customer,
  type Clock,
  type CustomerActor,
  type CustomerPatchInput,
  type FieldError,
} from '../domain/customer.js';
import { createChangeLogEntry, type ChangeLogEntry } from '../domain/changelog.js';
import type {
  CustomerRecord,
  CustomerRepository,
  CustomerUpdateResult,
} from '../persistence/memory-customer-repository.js';
import { CustomerNotFoundError } from './get-customer.js';

export interface UpdateCustomerInput {
  readonly customerId: string;
  readonly expectedVersion: number;
  readonly patch: CustomerPatchInput;
}

export interface ChangeLogWriter {
  append(customerId: string, entries: readonly ChangeLogEntry[]): Promise<void>;
}

export interface UpdateCustomerDependencies {
  readonly repository: Pick<CustomerRepository, 'findById' | 'updateVersioned'> & {
    readonly updateVersionedWithChanges?: (
      input: Parameters<CustomerRepository['updateVersioned']>[0],
      changes: readonly ChangeLogEntry[],
    ) => Promise<CustomerUpdateResult>;
  };
  readonly actor: CustomerActor;
  readonly clock?: Clock;
  readonly phoneKeyFor?: (phone: string) => string;
  readonly changeLog?: ChangeLogWriter;
  readonly requestId?: string | null;
}

export interface UpdateCustomerResult {
  readonly customer: Customer;
  readonly changes: readonly ChangeLogEntry[];
}

export class UpdateCustomerValidationError extends Error {
  readonly fieldErrors: readonly FieldError[];

  constructor(fieldErrors: readonly FieldError[]) {
    super(`客户更新校验失败: ${fieldErrors.map((entry) => `${entry.field}(${entry.code})`).join(', ')}`);
    this.name = 'UpdateCustomerValidationError';
    this.fieldErrors = Object.freeze(fieldErrors.map((entry) => ({ ...entry })));
  }
}

export class CustomerVersionConflictError extends Error {
  readonly code = 'CUSTOMER_VERSION_CONFLICT';
  readonly customerId: string;
  readonly expectedVersion: number;

  constructor(customerId: string, expectedVersion: number) {
    super(`客户 "${customerId}" 已被其他操作修改，请刷新后重试。`);
    this.name = 'VersionConflict';
    this.customerId = customerId;
    this.expectedVersion = expectedVersion;
  }
}

function restore(record: CustomerRecord): Customer {
  return Customer.restore({
    customerId: record.customer_id,
    name: record.name,
    contactPerson: record.contact_person,
    phone: record.phone,
    email: record.email,
    company: record.company,
    note: record.note,
    version: record.version,
    createdBy: record.created_by,
    updatedBy: record.updated_by,
    createdAt: new Date(record.created_at),
    updatedAt: new Date(record.updated_at),
  });
}

function toPersistencePatch(
  changes: Partial<Record<'name' | 'contactPerson' | 'phone' | 'email' | 'company' | 'note', string | null>>,
  phoneKeyFor?: (phone: string) => string,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  if (Object.prototype.hasOwnProperty.call(changes, 'name')) patch.name = changes.name ?? null;
  if (Object.prototype.hasOwnProperty.call(changes, 'contactPerson')) {
    patch.contact_person = changes.contactPerson ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'phone')) {
    const phone = changes.phone ?? '';
    patch.phone = phone;
    patch.phone_key = phoneKeyFor?.(phone) ?? phone.replace(/[^0-9+]/g, '');
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'email')) patch.email = changes.email ?? null;
  if (Object.prototype.hasOwnProperty.call(changes, 'company')) patch.company = changes.company ?? null;
  if (Object.prototype.hasOwnProperty.call(changes, 'note')) patch.note = changes.note ?? null;
  return patch;
}

function buildChangeEntries(
  current: Customer,
  changes: Partial<Record<'name' | 'contactPerson' | 'phone' | 'email' | 'company' | 'note', string | null>>,
  actor: CustomerActor,
  changedAt: Date,
  requestId?: string | null,
): ChangeLogEntry[] {
  const previous: Record<string, string | null> = {
    name: current.name,
    contactPerson: current.contactPerson,
    phone: current.phone,
    email: current.email,
    company: current.company,
    note: current.note,
  };
  return (['name', 'contactPerson', 'phone', 'email', 'company', 'note'] as const)
    .filter((field) => Object.prototype.hasOwnProperty.call(changes, field))
    .map((field) =>
      createChangeLogEntry({
        field,
        oldValue: previous[field],
        newValue: changes[field] ?? null,
        changedBy: actor.userId,
        changedAt,
        requestId,
      }),
    );
}

export async function updateCustomer(
  input: UpdateCustomerInput,
  dependencies: UpdateCustomerDependencies,
): Promise<UpdateCustomerResult> {
  const currentRecord = await dependencies.repository.findById(input.customerId);
  if (currentRecord === null) throw new CustomerNotFoundError(input.customerId);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new UpdateCustomerValidationError([
      { field: 'expectedVersion', code: 'INVALID_FORMAT', message: '版本必须是大于等于 1 的整数。' },
    ]);
  }

  const current = restore(currentRecord);
  const attempted = current.attemptUpdate(input.patch);
  if (!attempted.ok) throw new UpdateCustomerValidationError(attempted.errors);
  if (Object.keys(attempted.changes).length === 0) {
    throw new UpdateCustomerValidationError([
      { field: '*', code: 'INVALID_FORMAT', message: '至少提交一个需要修改的字段。' },
    ]);
  }

  const updated = current.withAppliedUpdate(attempted.changes, dependencies.actor, dependencies.clock);
  const persistencePatch = toPersistencePatch(attempted.changes, dependencies.phoneKeyFor);
  const updateInput = {
    customerId: input.customerId,
    expectedVersion: input.expectedVersion,
    patch: persistencePatch,
    updatedBy: dependencies.actor.userId,
    updatedAt: updated.updatedAt.toISOString(),
  };
  const entries = buildChangeEntries(
    current,
    attempted.changes,
    dependencies.actor,
    updated.updatedAt,
    dependencies.requestId,
  );
  const atomic = dependencies.repository.updateVersionedWithChanges;
  const result = atomic === undefined
    ? await dependencies.repository.updateVersioned(updateInput)
    : await atomic.call(dependencies.repository, updateInput, entries);
  if (!result.applied) {
    if (!result.rowExists) throw new CustomerNotFoundError(input.customerId);
    throw new CustomerVersionConflictError(input.customerId, input.expectedVersion);
  }
  if (atomic === undefined && dependencies.changeLog !== undefined) {
    await dependencies.changeLog.append(input.customerId, entries);
  }
  return { customer: updated, changes: entries };
}

export const patchUpdate = updateCustomer;
