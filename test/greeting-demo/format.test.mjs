/**
 * 证据 ID: greeting-format（test-plan.md）
 * 覆盖需求: AC-002 / AC-003 / AC-004 / AC-005
 *
 * 纯函数边界用例：缺省 / 空字符串 / 仅空白 / trim / 中间空白保留。
 * 另含 T-1 环境事实断言（Node 主版本 >= 18），不读取 package.json，
 * 不调用子进程，无 IO、无网络；仅 import 被测源码与本任务已声明的 node 内建。
 * 执行：node --test test/greeting-demo/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { greetingMessage } from '../../src/greeting-demo/format.mjs';

// T-1 环境事实：本测试进程运行的 Node 主版本须 >= 18（不足则走降级路径）
test('greeting-format: 环境事实 Node 主版本 >= 18', () => {
  const major = Number(process.versions.node.split('.')[0]);
  console.log('# env: node=' + process.version);
  assert.ok(major >= 18, `需要 Node >= 18，实际为 ${process.version}`);
});

// AC-002：无 name 参数（undefined）→ 访客
test('greeting-format: 无参调用返回访客文案', () => {
  assert.equal(greetingMessage(), '你好，访客');
});

// AC-003：name 为空字符串 → 访客
test('greeting-format: 空字符串返回访客文案', () => {
  assert.equal(greetingMessage(''), '你好，访客');
});

// AC-004：仅空白字符 → 访客
test('greeting-format: 空格与制表/换行等空白字符返回访客文案', () => {
  assert.equal(greetingMessage('  '), '你好，访客');
  assert.equal(greetingMessage('\t\n'), '你好，访客');
});

// AC-005：首尾空白被去除
test('greeting-format: 首尾空白 trim 后拼问候语', () => {
  assert.equal(greetingMessage('  小明  '), '你好，小明');
});

// AC-005：中间空白原样保留
test('greeting-format: 中间空白保留原值', () => {
  assert.equal(greetingMessage('小 明'), '你好，小 明');
});
