/**
 * 证据 ID: greeting-server 被测源码（test-plan.md）
 * 覆盖需求: AC-001 ~ AC-006 / AC-010
 *
 * 独立演示服务：仅 node:http、node:url 内建与相对导入 ./handler.mjs。
 * 不导入、不触碰仓库既有的服务入口与健康检查。
 * 直接以 CLI 运行本文件时打印实际监听地址，SIGINT 优雅关停。
 * 测试从本文件 import 时不会执行 CLI 分支。
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createGreetingHandler } from './handler.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;

/**
 * 在回环地址启动演示服务；port 为 0 时由操作系统分配临时端口。
 * @param {{ host?: string, port?: number }} [options]
 * @returns {Promise<{ server: import('node:http').Server, host: string, port: number, url: string, close: () => Promise<void> }>}
 */
export async function startDemoServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const server = http.createServer(createGreetingHandler());

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const bound = server.address();
  return {
    server,
    host: bound.address,
    port: bound.port,
    url: `http://${bound.address}:${bound.port}/`,
    close() {
      return new Promise((resolve, reject) => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function isCliEntry() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function runCli() {
  let instance;
  try {
    instance = await startDemoServer({ host: DEFAULT_HOST, port: DEFAULT_PORT });
  } catch {
    // listen 失败：简述不含任何用户输入，非 0 退出
    process.stderr.write('greeting-demo: 服务启动失败\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`greeting-demo listening on ${instance.url}\n`);
  await new Promise((resolve) => {
    process.once('SIGINT', () => {
      instance.close().then(resolve, resolve);
    });
  });
}

if (isCliEntry()) {
  runCli().catch(() => {
    process.exitCode = 1;
  });
}
