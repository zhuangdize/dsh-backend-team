# Decisions: Greeting Demo 开源选型决策记录

编号 `ADR-xx` 对应 `research.md` 的 R-xx 研究条目。状态含义：`已采纳（用户确认）`＝用户已裁决，作为结论写入；`已采纳`＝在现有约束下无需再议。Q1/Q2/Q3 均已裁决，未决清单只剩真实运行环境核对项。

## ADR-01 运行时底座：仅使用 Node.js 内置能力（已采纳）

- **背景**: 约束 5「只用 Node.js 自带能力，不新增第三方依赖」+ 约束 4「不修改任何已有文件」+ AC-009。
- **决策**: HTTP 服务端用 `node:http`；URL/参数用 `URL` + `URLSearchParams`；断言用 `node:test` + `node:assert/strict`；端到端客户端用内置全局 `fetch`；序列化用 `JSON.stringify`；手工验证用 `curl`。
- **备选与放弃原因**: Express / Fastify / Koa / Hono / supertest / zod / pino —— 引入即需新增依赖（含锁文件或 `package.json` 变更），与约束冲突；Go / Python / Rust 方案改变技术栈与构建配置，超出交付边界。
- **权衡**: 无框架路由与校验便利，契约一致性靠手写 `openapi.yaml` 与测试断言保证；对单接口演示规模可接受。
- **证据强度**: 决策依据是 spec 约束（本地证据），非任何外部调研；本任务未联网，未核对任何第三方项目现状、许可证或维护状态。

## ADR-02 承载方式：`src/greeting-demo/` 内独立监听（已采纳，用户确认）

- **决策**: `server.mjs` 提供 `startDemoServer({host:'127.0.0.1', port:0})` 与 CLI main；`http.createServer` 绑定 `127.0.0.1`，`port: 0` 由 OS 分配临时端口，启动后读回真实端口。
- **理由**: 既有服务入口不可修改 → 新路由无法被现有进程加载；用户已明确接受「演示接口与既有健康检查不在同一端口」的代价。
- **备选（裁决弃用）**: B＝既有服务插件式自动发现加载（仓库中未见该机制，属假设）；C＝仅导出 handler 不提供监听（用户无法手工访问，与演示意图不符）。

## ADR-03 重复 `name` 参数：取第一个值（已采纳，用户确认维持）

- **依据**: FR-006 / AC-007（clarification D-1，Q1 已裁决）。
- **实现口径**: `searchParams.getAll('name')[0]`；长度 > 1 不报错。

## ADR-04 空白与默认值规则：trim 后为空即「访客」（已采纳）

- **依据**: FR-002 / FR-003，AC-002~AC-005。中间空白原样保留；不做大小写或全半角归一（未要求，不臆造）。

## ADR-05 非 GET 访问 `/greeting`：返回 404（已采纳，用户确认）

- **决策**: 404，且不写 `Allow` 头（Q3 裁决）。
- **备选（裁决弃用）**: B＝405 + `Allow: GET`（更合 HTTP 语义，需额外分支与断言）；C＝不纳入范围。

## ADR-06 响应格式与编码（已采纳）

- 200 + `Content-Type: application/json; charset=utf-8` + `Content-Length`（UTF-8 字节长度）+ 单字段体（FR-005 / AC-006）；中文经 URL 解码后原样回显（FR-004）。
- 异常兜底：handler 内 try/catch → 500 + 固定文案 `{"message":"服务暂时不可用"}`，错误体与进程输出均不含 `name`。

## ADR-07 可观测性与隐私（已采纳）

- 不引入日志框架或指标；仅打印实际监听地址与不含用户输入的简述（D-4）。不记录原始 `name`。不设定吞吐/延迟目标（D-5）。

## ADR-08 验证口径与边界证明（已采纳）

- **验收**: `node --test test/greeting-demo/` 全绿 + 一次手工 `curl`。测试文件固定为 3 个（`format` / `handler` / `server`），不新增边界审计类文件。
- **测试硬性限制**: 不得调用 Git；不得启动子进程（禁 `node:child_process` 及 spawn/exec 等外部命令）；不得读取本功能未声明的既有文件（import 静态检查只读本次交付的新文件）。
- **AC-008 / AC-009**: 由宿主证据 `greeting-workspace-boundary`（本次交付与宿主开发前工作区快照比较）证明，范围仅限「既有文件未被修改/删除、新增路径全部位于两个交付目录」；AC-008 验收表述收窄为「既有文件未改动 + 本功能代码路径不导入、不触碰既有接口」，**不声明健康检查运行时响应已实测一致**。
- **AC-010**: 由 3 个测试文件对 `src/greeting-demo/`、`test/greeting-demo/` 的 import 做静态检查（仅 `node:` 内建与相对路径）证明。
- **门禁**: Q2/Q3 不再是前置条件；修订后的设计须经展示并获用户明确确认后方可进入编码；文档改动不得顺带触碰业务代码。

## 未决与二次核对清单

1. `node --version` 实际值（内置 `fetch`、`node:test` 可用性为先验假设，未核实；假设 ≥ 18）。
2. `package.json` 的 `"type"` 值（影响 `.mjs` 运行方式；不为此修改已有文件）。
