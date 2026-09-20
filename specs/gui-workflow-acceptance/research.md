# Research — GUI Workflow Acceptance（开源选型调研）

**Feature**: `gui-workflow-acceptance` · **Date**: 2026-09-07 · **Companions**: `spec.md`、`clarification.md`、`plan.md`（D-01–D-10）、`architecture.md`、`contracts/openapi.yaml`、`decisions.md`
**Status**: 设计阶段调研工件，不含业务代码。本特性无任何运行时验证：AC-001–AC-005 与契约工具校验均 **NOT RUN**。

## 0. 证据等级与来源限制

本调研在**无网络访问、无命令执行**的条件下完成：未查询包注册表、项目仓库、发布说明或许可证文本，未执行 `node --version`。结论按证据分级：

- **E1 已提供证据**：特性目录内既有工件（需求、Q-01–Q-11 裁决、计划、架构、契约）。
- **E2 先验知识、本轮未核验**：对常见开源项目的一般性记忆，不得当作当前版本/许可/维护状态的事实引用。
- **E3 设计推断**：由 E1 规则推出的取舍。

与开源相关的需求硬约束只有一条：以 Node.js 24 内置模块运行、零新增依赖、无安装步骤，并由 `node:test` 验证（AC-004/AC-005，E1）。因此下列多数「选择」是排除法的结果，而不是对生态优劣的经验比较。

## 1. HTTP 服务实现

- **Decision**：`node:http`（`http.createServer`），单进程、单文件、无框架。
- **Rationale**：唯一同时满足 AC-004 与路由硬规则（R-01、Q-01、Q-02、Q-06：精确且大小写敏感、不解码、不折叠尾斜杠、HEAD/OPTIONS 亦返回 405、404 优先于 405）的方案（E1）。框架的路由层默认提供需求明确禁止的归一化与镜像语义（E3）。
- **Alternatives considered**：Express、Fastify、Koa、micro、polka——均为第三方运行时依赖，直接违反 AC-004（E1 判据）；E2 记忆称其默认含尾斜杠/大小写选项、HEAD 自动镜像 GET、内置 404/405 与 `Allow` 头，需逐项关闭且属高风险定制。`node:https`/`node:http2`：TLS 与 HTTP/2 列 Non-Goals。
- **Limitation**：框架行为差异描述属 E2，未读任何源码或文档。

## 2. 测试运行器与断言库

- **Decision**：`node:test` + `node:assert`，入口 `node --test`。
- **Rationale**：AC-005 已点名 `node:test`，且它是主运行时自带能力，无需安装（E1）。断言库不另选，`node:assert` 足够覆盖逐字节与状态码断言。
- **Alternatives considered**：Jest、Vitest、Mocha + Chai、tape/uvu——均需 npm 安装及传递依赖（E2），违反 AC-004；其快照、mock、并发隔离能力对本特性（单路由、零状态）无验收价值（E3）。
- **Limitation / 待核验**：`node:test` 的稳定性阶段与 `node --test` 的默认文件发现规则属 E2，本轮未核验；实现轮以实际发现的测试文件清单为准，若建议布局 `test/health.test.mjs` 未被自动发现，改用显式文件参数（不新增依赖）。

## 3. 测试内 HTTP 客户端

- **Decision**：测试用 `node:http` 客户端发起请求。
- **Rationale**：可直接断言状态行、原始头与响应字节，覆盖 `HEAD`/`OPTIONS` 等非幂等方法；避免内置 fetch（undici）对头部或方法语义的规范化影响 AC-001 的逐字节断言（E3）。
- **Alternatives considered**：全局 `fetch`（同为零依赖，可接受退路，需经 `arrayBuffer()` 比对字节，E2）；supertest、显式 undici 依赖——需安装，否。
- **Tradeoff**：`node:http` 客户端样板代码略多，换取断言贴近线上字节形态。

## 4. 契约表达与生成方式

- **Decision**：手写静态 `contracts/openapi.yaml`（OpenAPI 3.1.0，已落盘，E1）。
- **Rationale**：对外面只有 1 个 path、7 个方法操作；从代码生成契约需要框架/装饰器依赖，与 D-01 冲突（E1）。
- **Alternatives considered**：代码生成（E2 记忆：fastify-swagger、tsoa、routing-controllers 等）——否；OpenAPI 3.0.3——会丢 `const` 等 JSON Schema 子集表达，而契约已用 `const`（E1）；`/{any}` 通配 path 表达 404——已由 D-10 否决（伪造未批准端点）。

## 5. 契约校验工具链（主要缺口）

- **Finding**：`plan.md` T-00 要求运行 YAML parser 与 OpenAPI 3.1 linter，但 Node 内置无 YAML 解析器（E2，未核验），而 spectral、`@redocly/cli`、swagger-cli、ajv 都是需安装的第三方包（E2），与「零新增依赖、无安装步骤」字面冲突（E3）。
- **Decision（建议）**：把 T-00 记为**仅在使用方已自带工具时才执行**的外部可选动作；契约在默认路径上的状态保持「未经工具校验」，不得记为通过。
- **Alternatives considered**：自写最小 YAML 子集解析器（成本高、易自错）；契约改用 JSON 以便零依赖校验（改动已批准工件形式，需重新澄清）。
- **Tradeoff**：形式正确性保障 vs 依赖面与验收口径一致性。

## 6. 依赖面、许可与供应链

- **Decision**：交付物含 0 个第三方包，运行时前置为 Node.js 24（需求既定，非本轮新增依赖）。因此不需要许可证选型、SCA 扫描或 SBOM 生成步骤（E1+E3）。
- **Limitation**：Node.js 自身许可（E2 记忆为 MIT）未经 SPDX 文本核对；因需求已指定 Node 24，许可核验不影响本特性交付，仅影响组织级合规清单。
- **Alternatives considered**：以 `--experimental-strip-types` 等运行时实验特性承载实现——阶段与行为属 E2，且无需求驱动，否。

## 7. NEEDS CLARIFICATION 与环境前置

`clarification.md` 记录阻塞性澄清 0、NEEDS CLARIFICATION 0（E1），本轮未新增未知需求项。四项非阻塞事项（不改变需求）须由下游知晓，位置如下：T-00 依赖冲突的处置口径＝`decisions.md` U-1；`node --test` 文件发现规则未核验＝U-2；目标机是否存在 Node.js 24（本文全部结论的共同前置假设，本轮无命令执行能力）＝U-3；`HEAD`/`OPTIONS → 405` 的生态兼容性风险则记于 `decisions.md`「有意偏离与已知风险」与 `architecture.md` Risks-1，不属于未决项。
