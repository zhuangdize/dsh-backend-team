# 人员管理功能 开源选型研究

## 范围与方法
- 目标：为 `plan.md` / `architecture.md` 提供开源组件选型依据，限定在人员模块"会用到什么"，不引入与既有边界无关的新依赖。
- 证据来源：宿主只读项目检查（技术栈类别、证据文件路径、宿主 Node 24.19.0）与本 feature 目录四份文档；未读取任何业务代码或配置文件。
- 硬性限制：本任务禁用网络、脚本与安装，无法查询 registry、官网、许可证原文、版本时效与安全公告。凡无直接证据的表述标注为"常识性假设"或 Pending，由实施阶段验证。

## 决策研究（Decision / Rationale / Alternatives / 证据与限制）

### 1 运行时与语言：沿用 Node + TypeScript strict
- Decision：人员模块使用仓库既有 Node + TypeScript（strict）。
- Rationale：spec 非功能要求"沿用仓库现有技术栈与模块边界"；证据 `package.json`、`templates/new-project/node-postgresql/tsconfig.json`。
- Alternatives：独立新服务或异语言重写——与边界复用及 AC-011 冲突，弃用（同 architecture「Alternatives」）。
- 限制：宿主检查 `nodeRuntime=needs-clarification`；24.19.0 为宿主环境版本，非 CI/生产运行时基线，需随宿主包确认。

### 2 持久化与迁移：PostgreSQL + Drizzle（不新增 ORM）
- Decision：沿用 Drizzle schema/迁移通道，落 `migrations/`，按 plan M1–M3 拆分。
- Rationale：证据 `packages/database/src/drizzle-kit-generator.ts` 与宿主 database=postgresql。
- Alternatives：Prisma / Kysely / 裸 SQL——均需新增依赖并与既有 Drizzle 通道并行，弃用；新建独立人员存储被 spec 明确禁止。
- 限制：Drizzle 与 PG 服务端版本未取证（无权读取 lockfile/配置）。

### 3 任职区间不重叠（R3/AC-005）的强制方式
- Decision：domain 纯函数校验 + 持久层事务内串行化（锁定该人员行）为主方案；PostgreSQL 标准 contrib `btree_gist` + `daterange` EXCLUDE 约束列为候选二线防线。
- Rationale：domain 校验可单测（plan 验证设计），不依赖数据库扩展；约束下沉依赖环境能力。
- Alternatives：分布式锁、事件溯源防重放——对 Q1 范围复杂度不必要，弃用。
- 限制：`btree_gist` 可用性与语法属常识性假设，PG 版本与扩展权限未取证，Pending 实施验证。

### 4 输入校验与 DTO（R6、AC-001、AC-009）
- Decision：优先复用宿主包既有校验库；若无，默认候选 zod（schema 字段白名单 + 自定义中文错误信息，契合 AC-009 敏感字段排除）。
- Alternatives：ajv（JSON Schema，与 `contracts/openapi.yaml` 对齐，但需额外映射）；class-validator（装饰器风格，与框架耦合）。全部弃用优先于"复用既有"。
- 限制：仓库证据未显示当前校验库选型——Pending；zod 许可证与版本现状属常识性假设，未验证。

### 5 HTTP 框架与路由
- 宿主检查无框架证据且 `serviceBoundary=null`。Decision：完全沿用宿主包既有 web 框架与认证中间件，人员模块零新增；随 plan 前置确认 1 收口。

### 6 认证授权（AC-008）
- Decision：复用宿主既有会话机制与角色（architecture 结论），服务端强制角色门禁，零新增开源认证依赖。
- Alternatives：自建 JWT 体系、接入外部身份服务——违反 Q2/Q3 与"不新增独立登录体系"，弃用。

### 7 测试运行器与数据库 fixture（AC-011 及计划内验证）
- 证据：仓库同时存在 Vitest（`package.json`）与 `node:test`（`packages/bundle/test/approved-test-bindings.test.ts`）。Decision：人员模块跟随宿主包既有 runner 约定，不强行统一。
- 集成测试：优先宿主既有 PostgreSQL fixture；仅当宿主无该能力时评估 testcontainers（常识性假设，未验证现状）。
- 限制：检测到的 build/lint/typecheck/test 脚本均未执行（宿主检查全为 unverified），本稿不声称其通过。

### 8 审计、历史与可观测
- Decision：`change_record` 追加写 + 仅 INSERT 的数据库账号权限实现"不可改写"（R7/AC-010）；历史查询与审计同源；日志/指标沿用宿主既有通道，不引入新开源审计或可观测后端。
- 限制：数据库权限模型未验证，风险与 architecture「Risks」一致。

## 待澄清清单（本轮证据无法收口）
1. 宿主包与路由挂载点（= plan 前置确认 1）→ 决定 web 框架与校验库候选。
2. HR 管理员身份来源（= 前置确认 2）。
3. PG 版本与 `btree_gist` 可用性。
4. 既有校验库与 PostgreSQL 测试 fixture 现状。
上述均不改变选型方向：一律收敛为"复用仓库既有能力、零或极少新增依赖"。
