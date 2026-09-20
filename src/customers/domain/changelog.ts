/** T-21：客户变更留痕值对象；敏感值在构造时完成脱敏。 */

import { redactCustomerValue } from '../support/redaction.js';

export const CUSTOMER_CHANGE_FIELDS = [
  'name',
  'contactPerson',
  'phone',
  'email',
  'company',
  'note',
] as const;

export type CustomerChangeField = (typeof CUSTOMER_CHANGE_FIELDS)[number];

export interface ChangeLogInput {
  readonly field: CustomerChangeField;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly changedBy: string;
  readonly changedAt: string | Date;
  readonly requestId?: string | null;
}

export interface ChangeLogEntry {
  readonly field: CustomerChangeField;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly requestId: string | null;
}

const FIELD_SET: ReadonlySet<string> = new Set(CUSTOMER_CHANGE_FIELDS);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export class ChangeLogValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ChangeLogValidationError';
    this.field = field;
  }
}

export function createChangeLogEntry(input: ChangeLogInput): ChangeLogEntry {
  if (!FIELD_SET.has(input.field)) {
    throw new ChangeLogValidationError('field', `不支持的变更字段: ${String(input.field)}`);
  }
  if (typeof input.changedBy !== 'string' || input.changedBy.trim() === '') {
    throw new ChangeLogValidationError('changedBy', '变更人不能为空。');
  }
  const changedAt = input.changedAt instanceof Date ? input.changedAt.toISOString() : input.changedAt;
  if (typeof changedAt !== 'string' || !ISO_TIMESTAMP.test(changedAt)) {
    throw new ChangeLogValidationError('changedAt', '变更时间必须是 UTC ISO-8601。');
  }
  if (input.requestId !== undefined && input.requestId !== null && typeof input.requestId !== 'string') {
    throw new ChangeLogValidationError('requestId', 'requestId 必须是文本或 null。');
  }
  return Object.freeze({
    field: input.field,
    oldValue: redactCustomerValue(input.field, input.oldValue) ?? null,
    newValue: redactCustomerValue(input.field, input.newValue) ?? null,
    changedBy: input.changedBy,
    changedAt,
    requestId: input.requestId ?? null,
  });
}

/** 别名便于事务写入侧按值对象或工厂风格调用。 */
export const createChangeLog = createChangeLogEntry;
