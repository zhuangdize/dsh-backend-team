# Test Plan — GUI Workflow Acceptance (Local `GET /health`)

**Feature ID**: `gui-workflow-acceptance` · **Companions**: `spec.md`、`architecture.md`、`data-model.md`、`contracts/openapi.yaml`
本计划把已批准的 AC-001–AC-005 映射到可执行场景。前置：Node.js 24（`node --version` 期望 `v24.x`）、零安装步骤、仅 `node:*` 内置模块。行为用例走 `listen(0)` 临时回环端口，真端口 `127.0.0.1:3001` 只用于人工冒烟与配置断言（Q-09）。建议测试文件 `test/health.test.mjs`，入口 `node --test`（实现轮产物，本阶段不存在）。

## Requirement ID

| 用例 | 需求 | 覆盖点 |
|---|---|---|
| V-01 / V-02 | AC-001 | 200 + 逐字节常量体 + 完整终止；查询串不参与路由（R-02、Q-03、Q-04、Q-06） |
| V-03 / V-04 | AC-002 | 精确路径匹配、无归一化；404 优先于 405（R-01、Q-02、D-03） |
| V-05 / V-08 | AC-003 | 已知资源上的 6 个非 GET 方法，含 HEAD/OPTIONS（Q-01）；进程停止释放端口（F-03） |
| V-06 / V-07 | AC-004 | 仅回环绑定、代码字面量 host/port、零新增依赖（R-03、Q-07） |
| V-09 | AC-005 | `node --test` 全绿且退出码 0 |
| V-10 | 契约合法性 | 已落盘 `openapi.yaml` 可被解析（plan.md T-00） |

## Evidence Type

| 用例 | 证据类型 |
|---|---|
| V-01、V-02、V-04、V-05、V-08 | `node:test` 自动化断言（HTTP 客户端实际响应） |
| V-03 | 决策纯函数单测（`decide(method, path)`）+ HTTP 等价用例 |
| V-06 | 配置断言（解析 listen 调用字面量）+ 冒烟观察 |
| V-07 | 静态清单核查（import 语句仅 `node:*`；安装步骤列表为空） |
| V-09 | 命令退出码 + 测试汇总输出 |
| V-10 | 解析工具/库的语法与结构校验结果 |
| PG-01…PG-05 | 不适用（无持久化），核查方式为文档一致性而非运行时证据 |

## Command or Scenario

| 用例 | 命令或场景（提案，未执行） |
|---|---|
| V-01 | `node --test`：对临时端口 `GET /health`，断言 `status===200`、`Buffer.compare(body, Buffer.from('{"ok":true}'))===0`、`Buffer.byteLength(body)===11`，媒体类型小写去参后 `=== 'application/json'`（容忍 charset），并断言响应完整终止 |
| V-02 | `node --test`：`GET /health?a=1` 与 `GET /health` 逐字节同结果；两次重复 + 10 路并发应答一致且无请求内容回显 |
| V-03 | `node --test`（纯函数）：`/`、`/health/`、`/HEALTH`、`/healthz`、`/health%20`、`%68ealth` → `404` |
| V-04 | `node --test`：`POST /nope` → `404`（非 405），验证路径判定先于方法判定 |
| V-05 | `node --test`：`/health` 上 POST/PUT/PATCH/DELETE/HEAD/OPTIONS 逐一 → `405`；不断言正文、`Content-Type`、`Allow`（Q-05） |
| V-06 | 源码字面量断言 host=`127.0.0.1`、port=`3001`；人工冒烟 `node src/health-server.mjs` + `curl -s http://127.0.0.1:3001/health`；非回环连接被拒 |
| V-07 | `grep -n "^import .* from" src/*.mjs` 仅见 `node:*`；确认 `package.json` 无 dependencies、无安装步骤 |
| V-08 | `node --test`：`server.close()` 后重新 `listen` 同端口成功（端口已释放） |
| V-09 | `node --test`（整目录） |
| V-10 | 对 `specs/gui-workflow-acceptance/contracts/openapi.yaml` 运行 YAML 解析与 OpenAPI 3.1 校验 |
| PG-01…PG-05 | PG 版本协商、schema/角色/授权、连接池与超时、迁移 up/down 与回滚、含数据备份恢复：均无对应实现面 |

## Expected Result

| 用例 | 期望（设计断言，不得引用为已通过） |
|---|---|
| V-01 | 状态 200；11 字节逐字节相等；`Content-Type` 媒体类型匹配；响应完整终止 |
| V-02 | 与 V-01 完全一致，查询串与并发不改变任何字节 |
| V-03 | 每个路径变体均为 404，无一命中成功分支 |
| V-04 | 404，证明 404 优先于 405 |
| V-05 | 六个方法均 405；HEAD/OPTIONS 不落 200（Q-01 有意偏离 RFC） |
| V-06 | 仅 `127.0.0.1:3001` 可服务；通配地址与 env/CLI 配置面均不存在 |
| V-07 | 无第三方模块、无安装步骤 |
| V-08 | 关闭后端口释放，无残留监听 |
| V-09 | 全部用例通过，进程退出码 `0` |
| V-10 | 解析成功；仅 1 个 path、7 个操作、根级 `security: []`、无 securityScheme |
| PG-01…PG-05 | 不适用；期望是「无任何 PostgreSQL 连接面」被核查为真（见 `data-model.md`） |

## Status

| 范围 | 状态 |
|---|---|
| V-01…V-09（AC-001–AC-005） | **NOT RUN** — 无 HTTP 请求发出、无服务启动、`node --test` 未运行、测试代码尚未编写 |
| V-10 | **NOT RUN** — 未运行任何 YAML/OpenAPI 工具，本工作流无命令执行能力 |
| PG-01…PG-05 | **不适用** — 特性无持久化（Non-Goals） |
| 风险口径 | 在 V-09 真实跑绿并核对退出码为 0 之前，任何 AC 不得记为 passed（architecture Risks-7）；逐字节断言脆弱性与端口争抢由 V-01、V-06 的临时端口策略缓解 |
