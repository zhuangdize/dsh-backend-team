# Implementation Plan — GUI Workflow Acceptance (Local `GET /health`)

**Feature ID**: `gui-workflow-acceptance` · **Date**: 2026-09-07 · **Companions**: `spec.md`、`clarification.md`、`architecture.md`、`contracts/openapi.yaml`
**Status**: 设计阶段计划。本阶段不产出业务代码、测试代码或配置文件。AC-001–AC-005 与契约工具校验一律 **NOT RUN**；本文「期望」均为设计断言，不得被下游引用为已通过。

## 1. Inputs 与目标

输入：`specs/gui-workflow-acceptance/spec.md`（已批准需求）与 `clarification.md`（Q-01–Q-11 裁决；阻塞性澄清 0、NEEDS CLARIFICATION 0）。
目标：后端架构、实现计划与 API 契约。本计划不新增需求、不改写既有裁决、不设性能指标（Q-11）。

## 2. Technical Context

| 维度 | 值 | 依据 |
|---|---|---|
| 运行时 | Node.js 24，仅内置模块，零第三方依赖、无安装步骤 | spec Integrations/NFR、AC-004 |
| HTTP 服务 / 测试 | `node:http` / `node:test` + `node:assert` | spec Integrations、AC-005 |
| 监听地址 | `127.0.0.1:3001` IPv4 字面量代码常量；无 env/CLI 配置 | R-03、Q-07 |
| 资源面 | 单一精确路径 `/health`；无别名、重定向、尾斜杠或大小写归一化 | R-01、Q-06 |
| 成功响应 | 恰 11 字节 `{"ok":true}`；`Content-Type: application/json` 裸媒体类型 | R-02、Q-03、Q-04 |
| 错误结果 | 非 `/health` 一律 404（路径优先于方法）；`/health` 非 GET（含 HEAD/OPTIONS）405；错误正文与 `Allow` 不在验收内 | F-02/F-03、Q-01、Q-02、Q-05 |
| 认证 / 会话 | 无；唯一访问控制即回环绑定；响应不回显请求内容 | Permissions、Q-08、R-03 |
| 持久化 / 集成 | 无数据库、缓存、队列、外部 API、代理、TLS、容器、CI | spec Integrations/Non-Goals |
| Unknowns | 无 NEEDS CLARIFICATION | clarification.md |

## 3. 范围与策略门禁

`.specify/memory/constitution.md` 不在本任务 readPaths 内，未读取、不虚构其内容；以下以任务策略（policySummary）作门禁清单，设计后复核结论相同。

| 门禁 | 评估 | 结果 |
|---|---|---|
| 仅写 owned 路径（`plan.md`/`architecture.md`/`contracts/openapi.yaml`） | 三个声明路径之内 | PASS |
| 不改业务代码 / 测试代码 / 配置 | §6 文件布局仅为交接计划 | PASS |
| 不执行脚本 / 分支 / 扩展钩子 / 安装 / 迁移 | 源 prompt 的 `setup-plan.sh`、before/after hooks 按任务策略不执行 | PASS |
| 不虚构通过项 | §7、§8 全部标注 NOT RUN | PASS |
| 无未解决澄清 | clarification.md 记录为 0 | PASS |
| OpenAPI 3.1 有效性（YAML parser / linter） | 本阶段无命令能力 | **NOT RUN** |

## 4. 设计决策（承担 Phase 0 research 结论；本阶段 required outputs 不含独立 research.md）

- **D-01 仅用 `node:http`**：`http.createServer` 单文件实现。Rationale: AC-004 零依赖零安装。Alternatives: Express/Fastify——引入依赖即违反 AC-004。
- **D-02 决策逻辑为纯函数**：`decide(method, path) → outcome`，无 IO、无状态。Rationale: R-01/Q-02/Q-06 可脱离网络单测。Alternatives: handler 内联 if——可行但不利用例枚举。
- **D-03 规则顺序先路径后方法**：`path !== '/health' → 404` 先于 `method !== 'GET' → 405`。Rationale: Q-02（`POST /nope` 是 404）。Alternatives: 先 405 的方法表——与裁决冲突。
- **D-04 常量字节响应**：200 正文为冻结字符串字面量直写，不经 JSON 序列化器。Rationale: R-02/Q-03 逐字节断言。Alternatives: `JSON.stringify({ok:true})`——产物相同但留空白注入面。
- **D-05 原始字符串比较，不解码不归一化**：取 `req.url` 首个 `?` 前子串做精确比较；`%68ealth`、`/health/`、`/HEALTH` 均 404。Rationale: R-01 + Q-06。Alternatives: `new URL(...).pathname`（会解码/归一化）——弃。
- **D-06 `HEAD`/`OPTIONS /health → 405`**：按需求字面语义执行。Rationale: Q-01 明确采纳，有意偏离 RFC。Alternatives: HEAD≈GET 惯例——被显式否决（architecture Risks-1 挂账）。
- **D-07 测试端口策略**：行为测试（AC-001–003）走临时回环端口 `listen(0)`；AC-004 以代码字面量断言核对。Rationale: Q-09 避免并行争抢 3001。Alternatives: 全用 3001——并行互炸。
- **D-08 可测缝与配置面分离**：启动入口为带默认参数的内部工厂（默认 `127.0.0.1:3001`），仅测试注入。Rationale: Q-07 禁的是对外 env/CLI 配置面。Alternatives: 测试复制 handler——漂移风险。属设计侧解读，挂 architecture Risks-6。
- **D-09 ESM vs CJS**：未定（实现细节、非验收项）；倾向 `.mjs`，不影响对外契约。
- **D-10 契约表达边界**：OpenAPI 只声明 1 个 path 与 7 个方法操作；404 作为全局未匹配规则写入根扩展，`security: []` 且不发明 securityScheme。Rationale: 需求只批准一个请求形状与三种结果，通配 path 模板会把「未匹配」伪装成端点，违反 R-01。Alternatives: `/{any}` + 404 response——否。

## 5. 工件分工

| 工件 | 内容 | 状态 |
|---|---|---|
| `architecture.md` | 8 小节：Context / Module Boundaries / Request Flow / API and Authentication / Failure Model / Observability / Alternatives / Risks | 设计工件已就绪 |
| `contracts/openapi.yaml` | OpenAPI 3.1.0；`info.title`/`info.version`；`paths./health` 7 操作；`components` 含 `HealthQuery`、`HealthFound`、`MethodNotAllowed`、`NotFound`、`HealthResponse`；根扩展记录 404 规则与 Q-05 排除项 | 已就绪；工具校验 NOT RUN |
| 数据模型 | 无实体、无持久化、无会话；唯一数据形态是 11 字节响应常量（R-02），并入 architecture「Request Flow」与契约 `HealthResponse` | 不另立文档 |
| 验证指南 | 并入本文件 §7（本阶段 required outputs 不含独立 quickstart.md） | 已就绪 |
| 需求追溯 | AC-001→`get`+`HealthFound`+`HealthResponse`；AC-002→`x-unmatched-path-rule`（`NotFound` 仅追溯）；AC-003→6 个非 GET 操作；AC-004→`servers`+`info`；AC-005→测试事项，不入契约 | 一致 |

## 6. 实现任务（交下一阶段；本阶段未创建、未运行）

建议文件布局（本特性目录之外，归属实现轮）：`src/health-server.mjs`（decide 纯函数 + createServer + 常量响应 + `listen(3001, '127.0.0.1')`）、`test/health.test.mjs`（`node:test`，行为用例走临时端口，D-07/Q-09）。

| ID | 任务 | 覆盖 |
|---|---|---|
| T-00 | 对已落盘契约运行 YAML parser 与 OpenAPI 3.1 linter | 契约合法性 |
| T-01 | 实现 `decide(method, path)`：404/405/200 三态，顺序按 D-03、比较按 D-05 | AC-001–AC-003 基础 |
| T-02 | 响应写出：200 时 `Content-Type: application/json` + 11 字节字面量并 `res.end`；404/405 只保证完整终止（Q-05） | AC-001–AC-003 |
| T-03 | 启动入口：host/port 代码字面量、导出内部工厂（D-08）；进程停止即释放端口 | AC-003 尾项、AC-004 |
| T-04 | 测试：`GET /health`、`GET /health?a=1` 逐字节相等 + `Buffer.byteLength === 11`；媒体类型大小写不敏感且容忍 charset；完整终止 | AC-001 |
| T-05 | 测试：`/`、`/health/`、`/HEALTH`、`/healthz`、`POST /nope` → 404 | AC-002 |
| T-06 | 测试：`/health` 上 POST/PUT/PATCH/DELETE/HEAD/OPTIONS → 405 | AC-003 |
| T-07 | 测试：源码字面量断言 host=`127.0.0.1`、port=`3001`；import 清单仅 `node:*` | AC-004 |
| T-08 | 测试：`server.close()` / 进程停止后端口释放 | AC-003 尾项 |
| T-09 | 运行 `node --test`，要求全绿且退出码 0 | AC-005 |

实现轮建议命令（提案，本阶段未执行，故无退出码）：`node --version`（期望 v24.x）、`node src/health-server.mjs`、`node --test`；人工冒烟 `http://127.0.0.1:3001/health`。

## 7. Validation / Quickstart（供实现轮使用；期望＝设计断言）

1. 前置：Node.js 24；无安装步骤（零依赖）。
2. `node src/health-server.mjs` → 期望监听 `127.0.0.1:3001`；`GET /health` 期望 200 且正文逐字节等于 `{"ok":true}`。
3. 行为测试（临时端口）：期望覆盖 T-04–T-06 用例清单且零失败。
4. AC-004 核对：期望 host/port 来自代码字面量；`::1:3001` 连接被拒属预期且**不计入验收**（Q-07）。
5. `node --test` 期望退出码 0（AC-005）。当前状态：**未编写、未运行**。
6. 契约期望通过 YAML/OpenAPI 校验（T-00）。当前状态：**未运行**。

## 8. Verification Status

本阶段全部结论来自对已批准需求与澄清裁决的静态设计分析：未发出任何 HTTP 请求、未启动服务、未编写或运行测试、未运行 YAML/OpenAPI 工具校验。AC-001–AC-005 状态维持「未执行」；`node:test` 相关事项同样未执行。

## 9. Done Criteria 与交接

- Done（本阶段）：三件设计工件齐备且相互一致，全部位于 owned 路径内。
- 交接：① 先执行 T-00 契约工具校验；② 再按 T-01–T-09 展开实现与测试，逐条回填 AC 状态。
- 遗留：错误响应正文与 `Allow` 头（现按 Q-05 排除）、延迟/并发/启动耗时目标（Q-11 已删除）——如需，须作为新需求重新澄清，本计划不做假设。
