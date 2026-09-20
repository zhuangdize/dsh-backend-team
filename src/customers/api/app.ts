/**
 * T-04 loopback HTTP 应用（contract 层，customer-api 模块）。
 *
 * 职责（architecture.md「customer-api」边界、Failure Model）：
 *   1. 模块内路由挂载：createCustomersApp() 提供纯 stdlib（node:http）的
 *      requestListener，各端点模块（如 T-05 create-customer.ts）通过
 *      app.addRoute(method, template, handler) 注册处理器；模板使用契约风格
 *      占位符，如 `/api/v1/customers/{customerId}`。
 *   2. 统一错误结构：一切失败响应均序列化为 contracts/openapi.yaml 的
 *      Error / ValidationError 形态 —— code、message、requestId，
 *      可选 details（ConflictPayload 等）与 fieldErrors（仅非空时输出，
 *      满足 minItems: 1）。
 *   3. 沿用既有 HTTP 入口与错误映射边界（D-05）：本文件不引入任何第三方
 *      HTTP 框架依赖，既有服务入口可将 /api/v1/customers 前缀的请求直接委托
 *      给 app.requestListener（或用 tryHandleRequest 做前缀分流）；领域/应用层
 *      错误通过 app.registerErrorMapper 转为 HttpApiError 后统一序列化，
 *      未注册映射时按已定稿的约定错误类名（PhoneTaken、CustomerNotFound、
 *      VersionConflict 等，见 tasks.md T-08/T-22/T-24）兜底映射，契约层
 *      不读 SQL、不做业务判定。
 *
 * 实现口径（宿主 Node 24 直跑 + node:test loopback）：
 *   仅使用可擦除的 TypeScript 语法（无 enum/namespace/参数属性），
 *   仅依赖 node:http 与 node:crypto，测试可用 startLoopbackServer()
 *   在 127.0.0.1:0 启动同进程 loopback 实例。
 *
 * 读码确认记录（D-05，按本任务可读范围）：decisions.md 与既有入口文件不在
 * 本任务 readPaths 内，未越权读取；故以「框架无关委托点 + 可注册错误映射」
 * 的最小边界落地，真实入口接线由主机集成验证（test-plan 主机延后项）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/** 模块内 API 前缀（openapi servers: / ，路径前缀 /api/v1/customers）。 */
export const CUSTOMERS_API_PREFIX = "/api/v1/customers";

/** 客户编号形状（openapi components.parameters.CustomerIdPath.schema.pattern）。 */
export const CUSTOMER_ID_PATTERN: RegExp = /^[A-Z]{2,4}-[0-9A-Za-z-]{6,32}$/;

const LOOPBACK_ORIGIN = "http://127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 65_536;
const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 字段级错误项（openapi components.schemas.FieldError）。 */
export interface FieldError {
  field: string;
  code: "REQUIRED" | "TOO_LONG" | "INVALID_FORMAT" | "DUPLICATED" | "IMMUTABLE";
  message: string;
}

/** 统一错误响应体（openapi components.schemas.Error；422 时附 fieldErrors）。 */
export interface ErrorPayload {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
  fieldErrors?: FieldError[];
}

/**
 * 机器可读错误码。其中 409 的两个取值与 openapi ConflictPayload.code 的
 * enum 完全一致（CUSTOMER_PHONE_TAKEN / CUSTOMER_VERSION_CONFLICT）；
 * 其余码为契约未枚举位置的稳定实现码（Error.code 允许任意字符串）。
 */
export const ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CUSTOMER_NOT_FOUND: "CUSTOMER_NOT_FOUND",
  CUSTOMER_PHONE_TAKEN: "CUSTOMER_PHONE_TAKEN",
  CUSTOMER_VERSION_CONFLICT: "CUSTOMER_VERSION_CONFLICT",
  PRECONDITION_FAILED: "PRECONDITION_FAILED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

/** 契约层的 HTTP 失败：状态码 + 机器码 + 使用者可读中文提示（+ 可选明细）。 */
export class HttpApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly fieldErrors?: FieldError[];

  constructor(
    status: number,
    code: string,
    message: string,
    init?: { details?: Record<string, unknown>; fieldErrors?: FieldError[] },
  ) {
    super(message);
    this.name = "HttpApiError";
    this.status = status;
    this.code = code;
    this.details = init?.details;
    this.fieldErrors = init?.fieldErrors;
  }

  /** 序列化为 openapi Error/ValidationError 形态（requestId 注入，空明细省略）。 */
  toPayload(requestId: string): ErrorPayload {
    const payload: ErrorPayload = { code: this.code, message: this.message, requestId };
    if (this.details !== undefined) {
      payload.details = this.details;
    }
    if (this.fieldErrors !== undefined && this.fieldErrors.length > 0) {
      payload.fieldErrors = [...this.fieldErrors];
    }
    return payload;
  }
}

/** 每个请求交给端点处理器的上下文。 */
export interface RequestContext {
  requestId: string;
  method: string;
  pathname: string;
  /** 路径占位符捕获值（已 URL 解码）。 */
  params: Record<string, string>;
  /** 查询参数（同名取首次出现）。 */
  query: Record<string, string>;
  header(name: string): string | undefined;
  /** 读取并解析 application/json 请求体（限长；语法错 → 400）。 */
  readJson(): Promise<unknown>;
  /** 中间件（如 T-36 认证守卫）向处理器传递的状态（Principal 等）。 */
  state: Record<string, unknown>;
}

/** 端点处理器的成功返回：状态码、响应头（如 Location/ETag）与响应体。 */
export interface RouteResult {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type RouteHandler = (ctx: RequestContext) => RouteResult | Promise<RouteResult>;
export type Middleware = (ctx: RequestContext) => void | Promise<void>;
export type ErrorMapper = (error: unknown, requestId: string) => HttpApiError | null | undefined;

export interface CustomersApp {
  /** 模块内路由挂载；模板占位符写作 {name}，重复挂载视为实现错误。 */
  addRoute(method: string, template: string, handler: RouteHandler): void;
  /** 路由命中后、处理器执行前运行；抛 HttpApiError 即短路（供 T-36 守卫）。 */
  use(middleware: Middleware): void;
  /** 既有/领域错误 → HttpApiError 的映射器；按注册顺序取首个非空结果。 */
  registerErrorMapper(mapper: ErrorMapper): void;
  /** 供既有 HTTP 入口直接委托的监听器（沿用其 (req, res) 形态）。 */
  requestListener(req: IncomingMessage, res: ServerResponse): void;
  /** 前缀分流入口：仅处理 /api/v1/customers 下请求，否则返回 false 交回外层。 */
  tryHandleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export interface AppOptions {
  /** JSON 请求体上限字节数（默认 64 KiB）。 */
  maxBodyBytes?: number;
}

interface CompiledRoute {
  method: string;
  template: string;
  regex: RegExp;
  names: string[];
  handler: RouteHandler;
}

const PLACEHOLDER_PATTERN: RegExp = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTemplate(template: string): { regex: RegExp; names: string[] } {
  if (!template.startsWith("/")) {
    throw new Error(`route template must start with "/": ${template}`);
  }
  const names: string[] = [];
  let pattern = "";
  let cursor = 0;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = PLACEHOLDER_PATTERN.exec(template);
  while (match !== null) {
    const name = match[1];
    if (name === undefined) {
      throw new Error(`invalid route placeholder in template: ${template}`);
    }
    pattern += escapeRegExp(template.slice(cursor, match.index));
    pattern += "([^/]+)";
    names.push(name);
    cursor = match.index + match[0].length;
    match = PLACEHOLDER_PATTERN.exec(template);
  }
  pattern += escapeRegExp(template.slice(cursor));
  return { regex: new RegExp(`^${pattern}/?$`), names };
}

function headerValue(
  raw: string | string[] | undefined,
): string | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined) {
    return undefined;
  }
  return first.trim();
}

function resolveRequestId(req: IncomingMessage): string {
  const incoming = headerValue(req.headers[REQUEST_ID_HEADER]);
  if (incoming !== undefined && REQUEST_ID_PATTERN.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, "路径包含非法的百分号编码");
  }
}

/** 约定错误名 → HTTP 状态与机器码（映射器未注册或返回空时的兜底边界）。 */
const FALLBACK_ERROR_BY_NAME: Readonly<Record<string, { status: number; code: string }>> = {
  CustomerNotFound: { status: 404, code: ERROR_CODES.CUSTOMER_NOT_FOUND },
  NotFound: { status: 404, code: ERROR_CODES.NOT_FOUND },
  PhoneTaken: { status: 409, code: ERROR_CODES.CUSTOMER_PHONE_TAKEN },
  VersionConflict: { status: 409, code: ERROR_CODES.CUSTOMER_VERSION_CONFLICT },
  Unauthenticated: { status: 401, code: ERROR_CODES.UNAUTHENTICATED },
  Forbidden: { status: 403, code: ERROR_CODES.FORBIDDEN },
  ServiceUnavailable: { status: 503, code: ERROR_CODES.DEPENDENCY_UNAVAILABLE },
  BadRequest: { status: 400, code: ERROR_CODES.BAD_REQUEST },
  PreconditionFailed: { status: 412, code: ERROR_CODES.PRECONDITION_FAILED },
};

function fallbackMapError(error: unknown): HttpApiError | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    existingCustomer?: unknown;
    fieldErrors?: unknown;
  };
  if (Array.isArray(candidate.fieldErrors) && candidate.fieldErrors.length > 0) {
    return new HttpApiError(422, ERROR_CODES.VALIDATION_ERROR, "输入未通过字段校验", {
      fieldErrors: candidate.fieldErrors as FieldError[],
    });
  }
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const fallback = FALLBACK_ERROR_BY_NAME[name];
  if (fallback === undefined) {
    return null;
  }
  const message =
    typeof candidate.message === "string" && candidate.message !== ""
      ? candidate.message
      : "请求未能完成";
  const details =
    typeof candidate.existingCustomer === "object" && candidate.existingCustomer !== null
      ? { existingCustomer: candidate.existingCustomer as Record<string, unknown> }
      : undefined;
  return new HttpApiError(fallback.status, fallback.code, message, { details });
}

/** 创建模块内 HTTP 应用（框架无关，可被既有入口或 loopback 测试服务承载）。 */
export function createCustomersApp(options: AppOptions = {}): CustomersApp {
  const maxBodyBytes = Math.max(
    64,
    Math.trunc(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
  );
  const routes: CompiledRoute[] = [];
  const middlewares: Middleware[] = [];
  const errorMappers: ErrorMapper[] = [];

  function addRoute(method: string, template: string, handler: RouteHandler): void {
    const normalizedMethod = method.toUpperCase();
    const { regex, names } = compileTemplate(template);
    for (const existing of routes) {
      if (existing.method === normalizedMethod && existing.template === template) {
        throw new Error(`duplicate route: ${normalizedMethod} ${template}`);
      }
    }
    routes.push({ method: normalizedMethod, template, regex, names, handler });
  }

  function matchRoute(
    method: string,
    pathname: string,
  ): { route: CompiledRoute; params: Record<string, string> } | null {
    for (const route of routes) {
      const captured = route.regex.exec(pathname);
      if (captured === null || route.method !== method) {
        continue;
      }
      const params: Record<string, string> = {};
      route.names.forEach((name, index) => {
        params[name] = decodeParam(captured[index + 1] ?? "");
      });
      return { route, params };
    }
    return null;
  }

  function toHttpApiError(error: unknown, requestId: string): HttpApiError {
    for (const mapper of errorMappers) {
      const mapped = mapper(error, requestId);
      if (mapped !== null && mapped !== undefined) {
        return mapped;
      }
    }
    if (error instanceof HttpApiError) {
      return error;
    }
    const fallback = fallbackMapError(error);
    if (fallback !== null) {
      return fallback;
    }
    if (error instanceof SyntaxError) {
      return new HttpApiError(400, ERROR_CODES.BAD_REQUEST, "请求语法不合法");
    }
    // 不向使用者泄露未知异常的原始信息（防敏感值入响应），排障依赖 requestId。
    void requestId;
    return new HttpApiError(500, ERROR_CODES.INTERNAL_ERROR, "服务器内部错误，请稍后重试");
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): void {
    if (body === undefined || status === 204) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      ...headers,
      "content-length": payload.byteLength,
    });
    res.end(payload);
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const contentEncoding = headerValue(req.headers["content-encoding"]);
    if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== "identity") {
      throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, "不支持的 content-encoding");
    }
    const contentType = headerValue(req.headers["content-type"]);
    if (contentType !== undefined) {
      const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
      if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
        throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, "请求体必须是 application/json");
      }
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.byteLength;
      if (received > maxBodyBytes) {
        throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, "请求体超出允许大小");
      }
      chunks.push(buf);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text === "") {
      throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, "请求体必须是 JSON 对象");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, "请求体不是合法 JSON");
    }
    return parsed;
  }

  function buildContext(
    req: IncomingMessage,
    requestId: string,
    method: string,
    url: URL,
    params: Record<string, string>,
  ): RequestContext {
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in query)) {
        query[key] = value;
      }
    }
    return {
      requestId,
      method,
      pathname: url.pathname,
      params,
      query,
      header: (name: string) => headerValue(req.headers[name.toLowerCase()]),
      readJson: () => readJsonBody(req),
      state: {},
    };
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const requestId = resolveRequestId(req);
    try {
      const method = (req.method ?? "GET").toUpperCase();
      const matched = matchRoute(method, url.pathname);
      if (matched === null) {
        throw new HttpApiError(404, ERROR_CODES.NOT_FOUND, "请求的资源不存在");
      }
      const ctx = buildContext(req, requestId, method, url, matched.params);
      for (const middleware of middlewares) {
        await middleware(ctx);
      }
      const result = await matched.route.handler(ctx);
      sendJson(res, result.status ?? 200, result.body, {
        [REQUEST_ID_HEADER]: requestId,
        ...(result.headers ?? {}),
      });
    } catch (error) {
      const mapped = toHttpApiError(error, requestId);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, mapped.status, mapped.toPayload(requestId), {
        [REQUEST_ID_HEADER]: requestId,
      });
    }
  }

  function parseRequestUrl(req: IncomingMessage): URL {
    return new URL(req.url ?? "/", LOOPBACK_ORIGIN);
  }

  function ownsPath(pathname: string): boolean {
    return (
      pathname === CUSTOMERS_API_PREFIX || pathname.startsWith(`${CUSTOMERS_API_PREFIX}/`)
    );
  }

  return {
    addRoute,
    use(middleware: Middleware): void {
      middlewares.push(middleware);
    },
    registerErrorMapper(mapper: ErrorMapper): void {
      errorMappers.push(mapper);
    },
    requestListener(req: IncomingMessage, res: ServerResponse): void {
      void handle(req, res, parseRequestUrl(req));
    },
    async tryHandleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = parseRequestUrl(req);
      if (!ownsPath(url.pathname)) {
        return false;
      }
      await handle(req, res, url);
      return true;
    },
  };
}

/**
 * 在 127.0.0.1 的随机端口启动 loopback 实例（node:test 允许的 loopback 范围）。
 * close() 会关闭空闲/活动连接并释放端口，避免测试进程挂起。
 */
export class LoopbackServer {
  readonly server: Server;
  readonly port: number;
  readonly origin: string;

  private constructor(server: Server, port: number) {
    this.server = server;
    this.port = port;
    this.origin = `${LOOPBACK_ORIGIN}:${port}`;
  }

  static async start(app: CustomersApp): Promise<LoopbackServer> {
    const server = createServer((req, res) => {
      app.requestListener(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: 0, host: "127.0.0.1" }, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("loopback server failed to bind an IPv4 port");
    }
    return new LoopbackServer(server, address.port);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    server.removeAllListeners("request");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

/** startLoopbackServer 的便捷别名（供 T-05/T-06 起的测试与集成使用）。 */
export async function startLoopbackServer(app: CustomersApp): Promise<LoopbackServer> {
  return await LoopbackServer.start(app);
}

/** 整数查询参数解析：缺省取默认值，非数字或越界 → 400（分页参数口径）。 */
export function parseIntegerParam(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new HttpApiError(400, ERROR_CODES.BAD_REQUEST, `参数 ${name} 必须是整数`);
  }
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new HttpApiError(
      400,
      ERROR_CODES.BAD_REQUEST,
      `参数 ${name} 超出允许范围（${minimum}–${maximum}）`,
    );
  }
  return value;
}

/** 请求体顶层是否为 JSON 对象（数组/null/标量一律按 400 拒绝的辅助判定）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
