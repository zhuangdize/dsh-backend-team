# Architecture: Greeting Demo

对应规格：`spec.md`（AC-001 ~ AC-010）；契约：`contracts/openapi.yaml`。

## Context

新增只读演示接口 `GET /greeting?name=<值>`，返回 `{"message":"你好，<值>"}`。硬约束：只允许在 `src/greeting-demo/`、`test/greeting-demo/` 下新增文件；不得修改任何已有文件（含既有服务入口与健康检查）；只用 Node.js 原生能力（`node:http`、`node:test`、内置 `fetch`），零第三方依赖、无数据库。

已裁决结论（Q2）：因既有服务入口不可修改，新路由无法被现有进程加载，演示接口由 `src/greeting-demo/` 内的独立监听承载：`http.createServer` 绑定 `127.0.0.1`，`port: 0`（OS 分配临时端口）；用户已接受「演示接口与既有健康检查不在同一端口」的代价。非 GET 访问 `/greeting` 返回 404 且不写 `Allow`（Q3 已裁决）；重复 `name` 取第一个值（Q1，AC-007）。

## Module Boundaries

```
src/greeting-demo/
  format.mjs   greetingMessage(name?) -> string      纯函数，唯一业务逻辑，无 IO
  handler.mjs  createGreetingHandler() -> (req,res)  路由匹配 + 查询解析 + JSON 编码
  server.mjs   startDemoServer(options) / main       进程装配：http.createServer + listen
test/greeting-demo/
  format.test.mjs      纯函数边界（缺省 / 空 / 空白 / trim / 中间空白）
  handler.test.mjs     状态码、响应头、响应体结构
  server.test.mjs      端到端（ephemeral 端口 + 内置 fetch，AC-001~007）+ AC-010 import 静态检查
```

依赖方向单向：`server → handler → format`；`format.mjs` 不引用任何 Node API。每个模块只暴露一个入口，无共享可变状态（FR-007）。测试文件固定为上述 3 个，不新增边界审计类文件。测试硬性限制：不得调用 Git、不得启动子进程（禁 `node:child_process` 及 spawn/exec 等）、不得读取本功能未声明的既有文件（import 静态检查只读取本次交付的新文件）。AC-008/AC-009 不依赖测试内外部命令，由宿主开发前工作区快照证据 `greeting-workspace-boundary` 证明。

## Request Flow

1. `server.mjs` 用 `http.createServer(handler)` 监听，host 固定 `127.0.0.1`，port 默认 `0`（OS 分配，启动后读回真实端口）。
2. handler 用 `new URL(req.url, 'http://localhost')` 解析请求。
3. 路径判断：`pathname === '/greeting'` 且 `method === 'GET'` → 问候分支；否则 404（见 Failure Model）。
4. `searchParams.getAll('name')`：长度 > 1 时取 `[0]`（FR-006 / AC-007）；不存在则为 `undefined`。
5. `format.mjs` 对值执行 `trim()`：空字符串 → `访客`，否则 `你好，<trim 后原样值>`，中间空白保留（FR-003 / AC-005）。
6. 响应：`200` + `Content-Type: application/json; charset=utf-8` + `Content-Length`，body 为 `JSON.stringify({ message })`（单字段，FR-005 / AC-006）。URL 解码与 UTF-8 长度由 WHATWG URL 与 `Buffer.byteLength` 处理（FR-004）。

## API and Authentication

对外仅一个操作 `GET /greeting`；query 参数 `name` 为可选字符串，需求未要求任何长度限制，契约不声明长度约束；无请求体；响应仅 200 与 404。无鉴权：匿名、只读、无数据访问权限（spec Permissions），契约以 `security: []` 表示且无 `securitySchemes`（D-6：不臆造安全机制）。无跨域场景，不定义 CORS。既有健康检查接口不属于本契约，本设计不代理、不重定向、不覆盖它。AC-008 的验收限定为「既有文件未被修改/删除（宿主快照证明）+ 本功能代码路径不导入、不触碰既有接口」；既有健康检查的运行时响应等价未经实测，不作声明。

## Failure Model

| 情况 | 结果 |
| --- | --- |
| 非 GET 访问 `/greeting` | 404，不写 `Allow` 头（Q3 裁决已确认） |
| 其它路径 | 404，与既有服务无关（独立进程） |
| `name` 缺省 / 空 / 仅空白 | 200 + `你好，访客`（AC-002~004），不是错误 |
| 重复 `name` | 取第一个值，不报错（FR-006） |
| URL 无法解析 | try/catch → 404，不抛到顶层 |
| handler 内意外异常 | try/catch → 500 + `{"message":"服务暂时不可用"}`，进程存活，信息不含 `name` |
| 端口被占 / listen 失败 | CLI 路径打印错误并非 0 退出；测试用 `port: 0` 规避 |
| 慢客户端 / 请求体 | 不读取请求体，无缓冲与超时策略需求 |

## Observability

刻意最小化（Non-Goals）：不引入日志框架、指标、追踪、额外探针。仅两处输出：启动时打印实际监听地址（`port: 0` 需读回真实端口）；出错时打印不含用户输入的简述（D-4）。验收依赖「内置测试 runner 全绿 + 一次手工 curl」，不设性能目标。

## Alternatives

- **在既有入口注册路由**：违反「不修改已有文件」，排除。
- **仅导出 handler、不提供监听**（Q2 方案 C）：文件更少、无端口冲突，但用户无法手工访问，与「演示用接口」意图不符；Q2 裁决后弃用。
- **固定端口（如 3001）**：易与既有服务冲突，故已确认默认 `port: 0`。
- **自定义测试脚本 / express 等框架**：前者冗余，后者引入第三方依赖，违反约束。
- **在测试内用 git status/diff 或既有文件哈希做边界断言**：不作为测试手段；边界证明改由宿主提供的工作区快照证据承担。

## Risks

- 独立进程意味着演示时 `/greeting` 与健康检查不在同一端口（用户已接受）；若后续要求同端口，须放宽「不改已有文件」约束。
- 若仓库 `package.json` 为 `"type": "commonjs"`，需按 `.mjs` 显式运行，不为此改动已有文件。
- Node 版本需 ≥ 18（内置 `fetch` + 稳定 `node:test`）；过低时 `server.test.mjs` 改用 `node:http.request`，不改设计。
- `greeting-workspace-boundary` 只证明文件级边界（未改既有文件、新增路径合规），不证明既有接口运行时行为；若需运行时一致性证明，须另行安排，且不得通过测试内子进程获取。
