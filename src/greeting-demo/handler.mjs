/**
 * 证据 ID: greeting-handler 被测源码（test-plan.md）
 * 覆盖需求: AC-006 / AC-007
 *
 * 唯一依赖 ./format.mjs；不导入、不触碰任何既有服务入口与健康检查。
 * 路由：仅 pathname 为 /greeting 且 method 为 GET 返回问候；其余一律 404 且不写 Allow 头。
 * 同名 name 参数重复出现时取第一个值（AC-007）。
 * 意外异常兜底 500，固定文案，错误体不回显任何用户输入（D-4）。
 */
import { greetingMessage } from './format.mjs';

const NOT_FOUND_BODY = JSON.stringify({ message: '接口不存在' });
const INTERNAL_ERROR_BODY = JSON.stringify({ message: '服务暂时不可用' });
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * 创建可复用的问候请求处理函数。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createGreetingHandler() {
  return function handleGreetingRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      // URL 解析失败按契约走 404，不写 Allow，不回显输入
      writeJson(res, 404, NOT_FOUND_BODY);
      return;
    }

    if (url.pathname === '/greeting' && req.method === 'GET') {
      try {
        const names = url.searchParams.getAll('name');
        const first = names.length > 0 ? names[0] : undefined;
        const message = greetingMessage(first);
        writeJson(res, 200, JSON.stringify({ message }));
      } catch {
        // 兜底固定文案，错误体不含 name（D-4）
        writeJson(res, 500, INTERNAL_ERROR_BODY);
      }
      return;
    }

    writeJson(res, 404, NOT_FOUND_BODY);
  };
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', JSON_CONTENT_TYPE);
  res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
}
