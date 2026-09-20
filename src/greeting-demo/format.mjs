/**
 * 证据 ID: greeting-format 被测源码（test-plan.md）
 * 覆盖需求: AC-002 / AC-003 / AC-004 / AC-005
 *
 * 唯一业务逻辑：把可选的 name 输入拼装为问候语。
 * 约束：纯函数、零 IO、不引用任何 Node API、不打印/记录原始 name（decisions.md D-4）。
 * 行为：String(name ?? '').trim() 为空 → `你好，访客`；否则 → `你好，<trim 后原值>`（中间空白原样保留）。
 */

const FALLBACK_NAME = '访客';

/**
 * @param {string} [name] 原始 name 输入（可为 undefined / null / 空 / 含空白）
 * @returns {string} 问候语，例如 `你好，小明` 或 `你好，访客`
 */
export function greetingMessage(name) {
  const trimmed = String(name ?? '').trim();
  if (trimmed === '') {
    return `你好，${FALLBACK_NAME}`;
  }
  return `你好，${trimmed}`;
}
