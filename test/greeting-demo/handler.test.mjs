/**
 * 证据 ID: greeting-handler（test-plan.md）
 * 覆盖需求: AC-006 / AC-007
 *
 * 进程内 HTTP 断言：http.createServer + 临时监听（127.0.0.1, port 0），无第三方框架。
 * 另含 res 桩用例覆盖 handler 内意外异常的 500 兜底（真实 res 无法注入该异常）。
 * 无子进程、不调用 Git；仅 node: 内建与相对导入被测 handler。
 * 执行：node --test test/greeting-demo/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createGreetingHandler } from '../../src/greeting-demo/handler.mjs';

function requestOnce({ method, path }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createGreetingHandler());
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request(
        { host: '127.0.0.1', port, method, path, agent: false },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            server.close(() =>
              resolve({ statusCode: res.statusCode, headers: res.headers, body }),
            );
          });
        },
      );
      req.on('error', (err) => server.close(() => reject(err)));
      req.end();
    });
  });
}

// AC-006：200 + JSON 头（application/json 且含 charset=utf-8）+ 体仅含 message 一个键
test('greeting-handler: GET /greeting 返回 200 与合规 JSON 响应', async () => {
  const res = await requestOnce({
    method: 'GET',
    path: '/greeting?name=' + encodeURIComponent('小明'),
  });
  assert.equal(res.statusCode, 200);
  const contentType = res.headers['content-type'];
  assert.equal(typeof contentType, 'string');
  assert.ok(contentType.startsWith('application/json'), contentType);
  assert.ok(contentType.includes('charset=utf-8'), contentType);
  const body = JSON.parse(res.body);
  const keys = Object.keys(body);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], 'message');
  assert.equal(body.message, '你好，小明');
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body, 'utf8')));
});

// AC-002 交叉：无 name 参数 → 访客
test('greeting-handler: 无 name 参数返回访客文案', async () => {
  const res = await requestOnce({ method: 'GET', path: '/greeting' });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).message, '你好，访客');
});

// AC-007：同名参数重复出现时取第一个值（getAll 长度为 2）
test('greeting-handler: 重复 name 参数取第一个值', async () => {
  const repeatedPath =
    '/greeting?name=' + encodeURIComponent('张三') + '&name=' + encodeURIComponent('李四');
  assert.equal(new URL(repeatedPath, 'http://localhost').searchParams.getAll('name').length, 2);
  const res = await requestOnce({ method: 'GET', path: repeatedPath });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).message, '你好，张三');
});

// AC-006/AC-007 + 契约：POST /greeting → 404，无 Allow 头，固定错误体
test('greeting-handler: POST /greeting 返回 404 且响应头无 Allow', async () => {
  const res = await requestOnce({ method: 'POST', path: '/greeting?name=x' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['allow'], undefined);
  assert.equal(res.body, '{"message":"接口不存在"}');
});

// 非 /greeting 路径 → 404，无 Allow 头
test('greeting-handler: GET /other 返回 404 且响应头无 Allow', async () => {
  const res = await requestOnce({ method: 'GET', path: '/other' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['allow'], undefined);
  assert.equal(res.body, '{"message":"接口不存在"}');
});

// T-4 兜底：问候分支内的意外异常 → 500 + 固定文案，错误体不含 name（D-4），不写 Allow
test('greeting-handler: 意外异常兜底 500 且错误体不回显 name', () => {
  const handler = createGreetingHandler();
  const written = [];
  const headers = {};
  let succeedEnd = false;
  const res = {
    statusCode: 0,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      if (!succeedEnd) {
        // 模拟成功响应写入过程中的意外异常
        succeedEnd = true;
        throw new Error('模拟写入失败');
      }
      written.push(String(chunk));
    },
  };

  handler({ url: '/greeting?name=' + encodeURIComponent('敏感输入'), method: 'GET' }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(written, ['{"message":"服务暂时不可用"}']);
  assert.equal(headers['allow'], undefined);
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(
    headers['content-length'],
    String(Buffer.byteLength(written[0], 'utf8')),
  );
  assert.ok(!written[0].includes('敏感输入'));
});
