/** T-20：客户变更留痕的敏感字段脱敏。 */

export type RedactableCustomerField = 'phone' | 'email';

/** 手机号保留前三位和末四位，中间固定四个星号。 */
export function redactPhone(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return '****';
  if (digits.length <= 4) return '*'.repeat(digits.length);
  const prefixLength = Math.min(3, Math.max(1, digits.length - 4));
  return `${digits.slice(0, prefixLength)}****${digits.slice(-4)}`;
}

/** 邮箱保留本地部分首字符及完整域名。 */
export function redactEmail(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  const at = value.indexOf('@');
  if (at <= 0 || at === value.length - 1) return '***';
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

export function redactCustomerValue(
  field: string,
  value: string | null | undefined,
): string | null | undefined {
  if (field === 'phone') return redactPhone(value);
  if (field === 'email') return redactEmail(value);
  return value;
}
