/**
 * 证据 ID: greeting-server（test-plan.md）
 * 覆盖需求: AC-001 ~ AC-006 / AC-010
 *
 * 端到端断言：startDemoServer 临时端口真实监听 + 内置 fetch 逐字节校验响应体；
 * 用例结束后 close 保证无残留句柄、进程正常退出。
 * 附加 import 静态检查：6 个交付文件的说明符仅为 node: 内建或 ./ 与 ../ 相对路径，
 * 且相对目标全部落在本交付 6 个文件内，未引用任何既有文件（支撑 AC-008 后半句）。
 * 限制：无子进程、不调用 Git、只读取本次交付的 6 个声明文件。
 * 执行：node --test test/greeting-demo/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDemoServer } from '../../src/greeting-demo/server.mjs';

const DELIVERED_FILES = [
  'src/greeting-demo/format.mjs',
  'src/greeting-demo/handler.mjs',
  'src/greeting-demo/server.mjs',
  'test/greeting-demo/format.test.mjs',
  'test/greeting-demo/handler.test.mjs',
  'test/greeting-demo/server.test.mjs',
];

const SPEC_PATTERNS = [
  /\bimport\s+(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/g,
  /\bexport\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// AC-001 ~ AC-006 端到端：编码、裸中文、无参、空值、纯空白、首尾空白
test('greeting-server: 端到端请求逐字节校验', async () => {
  const instance = await startDemoServer({ host: '127.0.0.1', port: 0 });
  try {
    assert.ok(Number.isInteger(instance.port) && instance.port > 0);
    assert.equal(instance.host, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${instance.port}/greeting`;

    const cases = [
      // AC-001 编码形式
      ['?name=%E5%B0%8F%E6%98%8E', '{"message":"你好，小明"}'],
      // AC-001 裸中文：验证 URL 解码与 UTF-8 回显（FR-004）
      ['?name=小明', '{"message":"你好，小明"}'],
      // AC-002 无参
      ['', '{"message":"你好，访客"}'],
      // AC-003 空值
      ['?name=', '{"message":"你好，访客"}'],
      // AC-004 仅空白
      ['?name=%20%20', '{"message":"你好，访客"}'],
      // AC-005 首尾空白 trim、编码中文
      ['?name=%20小明%20', '{"message":"你好，小明"}'],
    ];

    for (const [query, expectedBody] of cases) {
      const res = await fetch(baseUrl + query);
      assert.equal(res.status, 200, query);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', query);
      const raw = Buffer.from(await res.arrayBuffer());
      assert.deepEqual(raw, Buffer.from(expectedBody, 'utf8'), query);
      assert.equal(res.headers.get('content-length'), String(raw.byteLength), query);
    }

    // AC-006：响应体可解析且只含 message 一个键
    const check = await fetch(baseUrl);
    const parsed = await check.json();
    assert.deepEqual(Object.keys(parsed), ['message']);
  } finally {
    await instance.close();
    assert.equal(instance.server.address(), null);
  }
});

// AC-010 与边界：6 个交付文件存在，且 import 说明符仅为 node: 内建或相对路径
test('greeting-server: import 静态检查', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const deliveredSet = new Set(DELIVERED_FILES);

  for (const rel of DELIVERED_FILES) {
    const abs = path.join(repoRoot, rel);
    assert.ok(fs.existsSync(abs), rel + ' 应存在');
  }

  for (const rel of DELIVERED_FILES) {
    const source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const specifiers = [];
    for (const pattern of SPEC_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        specifiers.push(match[1]);
      }
    }
    // format.mjs 按设计为零导入的纯函数模块，故不要求说明符数量，只约束其形态

    for (const spec of specifiers) {
      const isBuiltin = spec.startsWith('node:');
      const isRelative = spec.startsWith('./') || spec.startsWith('../');
      assert.ok(
        isBuiltin || isRelative,
        `${rel} 的说明符 ${spec} 必须为 node: 内建或相对路径`,
      );
      if (isRelative) {
        const resolved = path
          .relative(repoRoot, path.resolve(path.dirname(path.join(repoRoot, rel)), spec))
          .split(path.sep)
          .join('/');
        assert.ok(
          deliveredSet.has(resolved),
          `${rel} 的相对说明符 ${spec} 解析到 ${resolved}，必须位于本交付 6 个文件内`,
        );
      }
    }
  }
});
