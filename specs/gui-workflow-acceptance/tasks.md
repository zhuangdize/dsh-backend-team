# Tasks — GUI Workflow Acceptance (Local `GET /health`)

**Feature ID**: `gui-workflow-acceptance` · **Date**: 2026-09-07 · **Companions**: `spec.md`、`clarification.md`、`plan.md`、`architecture.md`、`data-model.md`、`contracts/openapi.yaml`、`test-plan.md`
范围：仅本清单所列实现与验证工作，交付 `src/health-decide.mjs`、`src/health-server.mjs`、`test/health.test.mjs`。无新增依赖、无安装步骤（AC-004）。本文件不声明任何 AC 已通过；通过与否只由下列任务产生的证据决定。

## Phase 1 — Contract baseline（无故事标签）

<!-- backend-team:task id=T-004 slice=S-health requirements=AC-004 owner=developer risk=low layer=contract files=test/health.test.mjs evidence=health-contract-parse -->
- [ ] 核查 `specs/gui-workflow-acceptance/contracts/openapi.yaml` 的约定结构：根级 `security: []` 且无 `securitySchemes`、`servers` 仅 `http://127.0.0.1:3001`、`paths` 仅 `/health` 下 7 个方法操作（`get`→200，`post/put/patch/delete/head/options`→405）、404 规则仅由 `x-unmatched-path-rule` 承载且 `components.responses.NotFound` 不被任何 path 引用；若使用方环境已自带 YAML/OpenAPI 校验工具（不得为此安装依赖，承 OSS-05/U-1）则同时记录该工具的解析结果。

## Phase 2 — Foundational：路由决策（无故事标签）

<!-- backend-team:task id=T-001 slice=S-health requirements=AC-001,AC-002,AC-003 owner=developer risk=standard layer=domain files=src/health-decide.mjs evidence=health-decide-domain-test -->
- [ ] 新建 `src/health-decide.mjs`，导出纯函数 `decide(method, path) → 200|404|405`：无 IO、无状态；比较为原始字符串精确、大小写敏感，不解码、不折叠尾斜杠（R-01、D-05）；顺序固定为「先路径后方法」，`path !== '/health'` 即 404，其后 `/health` 上任何非 `GET` 方法（含 HEAD、OPTIONS）为 405（D-02、D-03、Q-01、Q-02）。

## Phase 3 — HTTP 接口（无故事标签）

<!-- backend-team:task id=T-002 slice=S-health requirements=AC-001,AC-002,AC-003 owner=developer risk=standard layer=contract files=src/health-server.mjs depends=T-001 evidence=health-http-boundary-test -->
- [ ] 在 `src/health-server.mjs` 用 `node:http` 建 handler：从 `req.url` 取首个 `?` 前子串作路径（查询不参与路由，Q-06），调用 `decide` 得状态码；200 分支写 `Content-Type: application/json` 与 11 字节冻结字面量 `{"ok":true}` 不经 JSON 序列化器（R-02、D-04），404/405 分支只保证响应完整终止、不断言正文/`Allow`（Q-05）；任何分支都不回显请求内容（R-03）。

## Phase 4 — 启动与绑定（无故事标签）

<!-- backend-team:task id=T-003 slice=S-health requirements=AC-003,AC-004 owner=developer risk=standard layer=domain files=src/health-server.mjs depends=T-002 evidence=health-server-listen-domain-test -->
- [ ] 在 `src/health-server.mjs` 增加启动入口：host/port 取自代码常量 `127.0.0.1` 与 `3001`，仅经 `listen(3001, '127.0.0.1')` 绑定，不接受环境变量或 CLI 覆盖、不监听通配地址、不同时监听 `::1`（R-03、Q-07）；导出内部工厂供测试注入 `listen(0)` 临时端口（D-08）；`EADDRINUSE` 时非零退出、不重试、不改端口；`server.close()` 或进程停止即释放端口（F-03）。

## Phase 5 — 成功响应测试（US1：存活探测，AC-001）

<!-- backend-team:task id=T-101 slice=S-health requirements=AC-001 owner=qa risk=standard layer=test files=test/health.test.mjs depends=T-003 evidence=health-get-ok-test -->
- [ ] 在 `test/health.test.mjs` 用 `node:test` + `node:assert` 与 `node:http` 客户端（OSS-03）覆盖 V-01/V-02：对 `listen(0)` 临时端口发 `GET /health` 与 `GET /health?a=1`，断言 `status === 200`、`Buffer.compare(body, Buffer.from('{"ok":true}')) === 0`、`Buffer.byteLength(body) === 11`、`Content-Type` 小写去参后等于 `application/json`（容忍 charset，Q-04）、响应完整终止；重复两次并并发 10 路，断言应答逐字节一致且无请求内容回显。

## Phase 6 — 方法不允许测试（US2：405 与端口释放，AC-003）

<!-- backend-team:task id=T-102 slice=S-health requirements=AC-003 owner=qa risk=standard layer=test files=test/health.test.mjs depends=T-003 evidence=health-method-405-test -->
- [ ] 在 `test/health.test.mjs` 覆盖 V-05：`/health` 上 POST、PUT、PATCH、DELETE、HEAD、OPTIONS 逐一断言 `405`（HEAD/OPTIONS 不落 200，承 Q-01 的有意偏离），每例断言响应完整终止，不针对错误正文、`Content-Type`、`Allow` 写断言（Q-05）；并覆盖 V-08：`server.close()` 后对同一端口重新 `listen` 成功，确认端口已释放（F-03）。

## Phase 7 — 路径匹配与优先级测试（US3：404，AC-002）

<!-- backend-team:task id=T-103 slice=S-health requirements=AC-002 owner=qa risk=standard layer=test files=test/health.test.mjs depends=T-001,T-003 evidence=health-decide-unit-test -->
- [ ] 在 `test/health.test.mjs` 覆盖 V-03 的 `decide` 单测：对 `/`、`/health/`、`/HEALTH`、`/healthz`、`/health%20`、`%68ealth` 逐例断言返回 `404`，验证无归一化与大小写敏感（R-01、Q-06）。

<!-- backend-team:task id=T-104 slice=S-health requirements=AC-002 owner=qa risk=standard layer=test files=test/health.test.mjs depends=T-003 evidence=health-404-precedence-test -->
- [ ] 在 `test/health.test.mjs` 覆盖 V-04 的 HTTP 等价用例：`GET /`、`GET /health/`、`GET /HEALTH`、`GET /healthz` 与 `POST /nope` 全部断言 `404`（非 405），锁定 404 优先于 405 的固定规则（D-03、Q-02）。

## Phase 8 — 绑定与依赖面核查（AC-004）

<!-- backend-team:task id=T-105 slice=S-health requirements=AC-004 owner=qa risk=standard layer=test files=test/health.test.mjs depends=T-003 evidence=health-config-literal-test -->
- [ ] 在 `test/health.test.mjs` 覆盖 V-06/V-07 的配置与依赖面断言：解析 `src/health-server.mjs` 源码，断言 `listen` 调用含字面量 `127.0.0.1` 与 `3001`、文件中不存在 `0.0.0.0` 通配绑定与 `::1` 监听、不存在读取 `process.env` 或 CLI 参数以覆盖 host/port 的分支；断言 `src/health-decide.mjs` 与 `src/health-server.mjs` 的 import 目标仅为 `node:` 前缀内置模块或本特性交付的相对路径本地模块（例如 `./health-decide.mjs`），不引入第三方依赖。

<!-- backend-team:task id=T-106 slice=S-health requirements=AC-004 owner=qa risk=low layer=test files=src/health-server.mjs depends=T-003 evidence=health-loopback-smoke -->
- [ ] 准备可用于人工冒烟 V-06 的入口并检查代码；以下命令由宿主在 Agent 交付后执行，Agent 不得虚构执行结果：在工作区根运行 `node src/health-server.mjs`，确认 `curl -s http://127.0.0.1:3001/health` 返回 200 与 `{"ok":true}`、监听仅出现在回环接口、停止进程后端口释放；同时确认交付物无安装步骤（本特性不新增 `package.json` 依赖项，保留既有 `dependencies` 与 `devDependencies`，与执行前基线比较确认没有新增或删除依赖）；`::1` 连不上属预期且不计入验收（Q-07）。

## Phase 9 — Polish / 全量验证（AC-005）

<!-- backend-team:task id=T-107 slice=S-health requirements=AC-005 owner=qa risk=standard layer=test files=test/health.test.mjs depends=T-004,T-101,T-102,T-103,T-104,T-105,T-106 evidence=health-node-test-exit-code -->
- [ ] 先用 backend_team_test 工具运行 test/health.test.mjs 并记录真实退出码；宿主随后覆盖 V-09：在 Node.js 24 下运行 `node --test` 执行 `test/health.test.mjs` 全量用例，要求零失败并记录进程退出码为 `0`；若默认文件发现规则未选中该文件（U-2），改为显式文件参数 `node --test test/health.test.mjs`，不得为此新增依赖；把用例清单与退出码登记为 AC-005 证据。

## Dependencies

全部任务组成一个可独立验收的 S-health 功能单元，任务内部依赖由 metadata depends 描述。开发者完成接口与测试后运行测试工具，测试者独立复测。已审批的文档只读；写入范围仅三个交付文件。

## Execution

Agent 只使用 backend_team_read、backend_team_write、backend_team_test。原生 shell、文件和状态工具均未启用。只读声明的文档路径；输入哈希中的文件名是特性目录相对名。先创建缺失的交付文件再运行测试，测试中不创建子进程或写磁盘。正式入口人工冒烟和原始 node --test 命令由宿主执行，不能作为 Agent 已执行的证据。保留全部 AC-001–AC-005；在宿主补齐命令证据之前不宣称最终验收完成。

## 恢复执行说明

三个交付文件已有实现。本次先读取交付文件并运行 backend_team_test，依据实际失败或明确缺失的验收场景决定是否修改；不要仅为改写风格或重排相同用例重写通过的测试。先前测试结果不可代替本次执行。宿主负责的正式入口冒烟和原始命令验证应作为待宿主核查事项如实报告，不要尝试被禁用的工具。完成本角色范围后立即提交简洁的结果 JSON：引用工具返回的真实文件哈希及退出码，避免逐项重复整份设计文档。不能满足通过条件时返回真实的 blocked/failed，不等待预算耗尽。
