# Research: Greeting Demo 开源选型

输入：`spec.md`、`clarification.md`、`plan.md`、`architecture.md`。本文记录开源选型研究与证据来源限制，不记录本次文档工作的执行过程。

## 0. 来源与证据限制（先读）

- 本任务**无网络访问**（未授予 network 能力）：未浏览任何项目仓库、发行页、CHANGELOG、LICENSE 或安全公告。
- 因此对第三方项目的取舍依据只有两类：① spec 硬约束（不新增第三方依赖、只新增两个目录）；② 通用先验知识，属**假设**而非**证据**。任何当前版本号、维护状态、许可证条款、CVE 状况都需在具备网络的阶段重新核对。
- 本地未执行的事实核查（本文一律不声称已验证）：`node --version` 实际值；`package.json` 的 `"type"` 字段。
- AC-008 / AC-009 不再依赖自行采集的健康检查响应基线或既有文件哈希：改由宿主证据 `greeting-workspace-boundary`（本次交付与宿主开发前工作区快照比较）证明。其范围仅为「未修改/删除既有文件、新增路径全部落在 `src/greeting-demo/` 与 `test/greeting-demo/`」；**不声称既有健康检查接口的运行时响应已被实测**。

## 1. 约束驱动的主线

零新增依赖 + 不得修改既有入口 → 唯一可依赖的开源底座是 Node.js 运行时自身（Node.js 开源项目，许可证以仓库 `LICENSE` 为准，本文未核对）。以下决策均在此前提下展开。

### R-1 HTTP 服务端
- **Decision**: `node:http` 的 `http.createServer`。
- **Rationale**: 单个只读 GET 接口无需框架能力；不触碰任何既有配置或入口。
- **Alternatives**: Express / Fastify / Koa / Hono（均需新增依赖，违反约束 5）；Go `net/http`、Python FastAPI、Rust axum 等跨语言栈（改变构建与 CI 形态，超出「仅新增两个目录」）。
- **Tradeoff**: 放弃路由、中间件、请求校验生态；本接口只有一条路径与一种方法，代价可接受。

### R-2 URL 与查询参数解析
- **Decision**: WHATWG `URL` + `URLSearchParams`，重复参数取 `getAll('name')[0]`。
- **Rationale**: 百分号解码内置（FR-004），「取第一个值」（FR-006 / AC-007）写成显式一行，语义可测。
- **Alternatives**: `qs`（第三方）；`node:querystring`（历史模块，不推荐新代码使用，重复参数返回数组需额外分支）。
- **Tradeoff**: `URL` 需固定 baseURL 占位（`http://localhost`，不参与对外行为）。

### R-3 测试 runner 与断言
- **Decision**: `node:test` + `node:assert/strict`。
- **Alternatives**: Jest / Vitest / Mocha / tap（第三方依赖且需新增配置文件）；supertest（第三方）以内置 `fetch` 打真实 socket 替代。
- **Tradeoff**: 无开箱覆盖率、快照、并发分组能力；对固定的 3 个测试文件不构成阻碍。
- **假设（未核实）**: 所用 Node 版本中内置 test runner 可用且行为稳定（前置假设 Node ≥ 18）。

### R-4 端到端 HTTP 客户端
- **Decision**: Node 内置全局 `fetch` + ephemeral 端口真实回环请求；手工验证用 `curl -i`。
- **Alternatives**: axios / got（依赖）；`node:http.request`（零依赖降级路径，见 architecture Risks）。
- **假设（未核实）**: 全局 `fetch` 在目标 Node 版本存在（先验知识为 Node 18 起）。

### R-5 JSON 序列化与响应头
- **Decision**: `JSON.stringify({ message })` + 手工 `Content-Type: application/json; charset=utf-8` 与 `Content-Length: Buffer.byteLength(body,'utf8')`。
- **Alternatives**: fast-json-stringify 等（依赖；单字段无收益）。

### R-6 API 契约文档
- **Decision**: 手写 `contracts/openapi.yaml` 文本，不引入 swagger / redoc / 代码生成工具链。
- **Tradeoff**: 契约与实现无自动一致性校验，存在漂移风险；以 handler / server 测试断言弥补。

### R-7 明确不引入项
日志框架（pino / winston）、鉴权（passport / jose）、schema 校验（zod / joi）、ORM 与迁移、Docker 与 CI 配置、格式化与 lint 工具链：均由 Non-Goals 或「不得修改已有文件」排除；引入即放大 AC-009 风险。

### R-8 边界与「零依赖」的证明手段
- **Decision**: AC-008/AC-009 用宿主工作区快照 `greeting-workspace-boundary`；AC-010 由 3 个测试文件对交付的 6 个文件做 import 静态检查（仅允许 `node:` 内建模块与相对路径），行为断言继续用真实回环 HTTP。
- **Alternatives**: 在测试内执行 `git status` / `git diff` 或读取既有入口文件 SHA-256 作断言——已被测试硬性限制排除：不得调用 Git、不得启动子进程（禁 `node:child_process` 及 spawn/exec 等）、不得读取本功能未声明的既有文件；依赖审计工具链（需新增依赖或改配置）。
- **Tradeoff**: 宿主快照不覆盖既有健康检查的运行时响应等价性；AC-008 验收因此收窄为文件级边界 + 代码路径不导入、不触碰既有接口，运行时回归须另行安排且不得借测试内子进程获取。

## 2. 对后续阶段的输入

- 需二次核对的开源事实仅剩两项环境事实：`node --version` 实际值（内置 `fetch`、`node:test` 可用性为先验假设，未核实）；`package.json` 的 `"type"`（若为 `commonjs` 以 `.mjs` 交付，不为此改已有文件）。既有健康检查响应基线不在采集范围内（由宿主快照承担文件级证明）。
- 产品裁决已全部落地为结论：Q2 = `src/greeting-demo/` 内独立监听（`127.0.0.1`、`port: 0`，用户接受与健康检查不同端口的代价）；Q3 = 非 GET 返回 404 且不写 `Allow`；Q1 = 重复 `name` 取第一个值（AC-007 维持）。选型层面无阻塞项。
