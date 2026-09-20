# 人员管理功能 开源选型决策记录（ADR）

状态说明：Accepted = 基于当前仓库证据采纳；Pending = 方向已定、细节待实施验证；Deferred = 明确移交后续环节。本任务禁用网络与安装，所有许可证/版本表述均为常识性假设，未做实时验证；详细备选与出处见同目录 `research.md`。

## ADR-001 沿用既有技术栈，不新增运行时依赖
- Status: Accepted
- Decision：人员模块在既有 monorepo 内以 Node + TypeScript strict + PostgreSQL 交付，迁移走 Drizzle 既有通道；不建独立人员微服务或重复存储。
- Evidence：宿主检查证据 `package.json`、`templates/new-project/node-postgresql/tsconfig.json`、`packages/database/src/drizzle-kit-generator.ts`、`package-lock.json`。
- Consequences：供应链零增量、满足 AC-011；框架与校验库最终形态受 ADR-005/006 的 Pending 项约束。

## ADR-002 认证与外部集成零新增依赖
- Status: Accepted
- Decision：复用宿主既有会话（Cookie/Bearer 由实施确认）与服务端角色门禁；非 HR 对集合/写操作 403、人员维度资源 404 且与不存在不可区分（AC-008）；不引入登录体系、身份服务或第三方认证库；无外部人事/通讯录同步（Q3）。
- Consequences：plan 前置确认 2（HR 身份来源）为实施阻塞项。

## ADR-003 区间防重叠：domain 校验为主，PG 排他约束为候选
- Status: Decision Accepted；候选约束 Pending
- Decision：R3/AC-005 以 domain 纯函数校验 + 事务内行级串行化落地；`btree_gist` + `daterange` EXCLUDE 约束仅在确认 PG 版本与扩展权限后作为二线防线。
- Rejected：分布式锁、事件溯源（超出 Q1 复杂度需求）。

## ADR-004 审计与字段级历史不引入第三方库
- Status: Accepted（权限模型 Pending）
- Decision：`change_record` 追加写，常规接口无更新/删除路径，数据库账号仅 INSERT；历史即审计视图（AC-010）。
- Limitations：数据库权限未取证，由宿主在实施阶段验证，与 architecture「Risks」同源。

## ADR-005 校验库：复用宿主既有，缺省候选 zod
- Status: Pending
- Decision：实施时先复用宿主包既有校验库；确无则采用 zod 做 DTO 校验与字段白名单（AC-001 中文错误、AC-009 敏感字段排除）。备选 ajv（与 OpenAPI 契约对齐）、class-validator，均优先于引入而让位于复用。
- Limitations：仓库无校验库选型证据；zod 现状与许可证未做联网验证。

## ADR-006 HTTP 框架随宿主包确定
- Status: Pending
- Decision：不新增 web 框架；资源前缀 `/persons` 的挂载点与路由库由 plan 前置确认 1 决定。`serviceBoundary=null` 是当前最大选型信息缺口。

## ADR-007 测试运行器与 fixture 随仓库约定
- Status: Accepted（fixture 现状 Pending）
- Decision：人员模块按宿主包约定使用 Vitest 或 `node:test`（仓库两者并存，证据 `package.json`、`packages/bundle/test/approved-test-bindings.test.ts`）；集成测试优先宿主既有 PostgreSQL fixture，仅当无现成能力时评估 testcontainers。
- Limitations：宿主检查中所有验证脚本状态为 unverified，未执行、不得视为通过；AC-011 由宿主在实施/验收阶段按计划执行并记录。

## ADR-008 许可证、公告与供应链准入移交宿主流程
- Status: Deferred
- Decision：本轮研究结论不构成许可证或安全公告验证；最终任何新增依赖（候选 zod、testcontainers 等）必须经宿主依赖治理与安全扫描后方可引入（仓库存在 `packages/dependency-governance` 包，其脚本未执行、结果未知）。
- Rationale：本角色无 network/install 能力，禁止伪造验证结果。
