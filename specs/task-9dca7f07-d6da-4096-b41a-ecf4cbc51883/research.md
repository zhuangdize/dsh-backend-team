# 开源选型调研：客户管理功能

## 0 前提与来源限制

- 本任务无网络、无命令执行：未访问包索引、仓库或官网，**未核实任何第三方组件的当前版本、维护状态与许可证条款**。下文对具体库能力的表述均为待核实先验，集中列入 `decisions.md` 的 V 清单。
- 可当作事实引用的仅有宿主只读检测证据：`package.json`、`src/personnel/persistence/schema.ts`、`packages/database/src/drizzle-kit-generator.ts`、`package-lock.json`。据此栈已确定为 Node（宿主 24.19.0）+ TypeScript strict + Drizzle + PostgreSQL + Vitest / node:test。该检测未执行任何脚本（`commandsExecuted:false`、各 manifest `status:unverified`），故不构成"可构建或测试通过"的证据。
- Q1–Q3 已定稿；`clarification.md` 并已修正"联系人必填"的早期表述（以 spec 为准，`contactPerson` 可选）。旧版调研把该点列为文档矛盾，现已不成立。
- 仍未确定（须实现期读码，本文不臆造）：实际 HTTP 框架与服务入口（宿主 `serviceBoundary:null`）、既有校验/日志/身份组件及其版本、目标 PG 实例与扩展权限。

## 1 栈内候选速览

| 槽位 | 选定倾向 | 主要备选 | 关键取舍 |
| --- | --- | --- | --- |
| 数据库 | 沿用宿主既有 PostgreSQL 与 `packages/database` 流程 | 新建独立实例；SQLite 仅本地临时 | 唯一索引与事务语义两者皆可；新实例徒增运维 |
| 数据访问 | Drizzle ORM（仓库已在用） | Prisma、Kysely、裸 `node-postgres` | 需精确掌控"影响行数=0"与唯一键异常，重抽象反成负担；实际版本与 API 待读码 |
| 迁移 | 沿用 drizzle-kit 生成 SQL，落 `migrations/` | node-pg-migrate、Umzug、Prisma Migrate | 单一工具链避免 schema 双写；回退(down)能力未核实（V-03） |
| HTTP 层 | 复用现有服务入口与错误映射，在 `src/customers/api/` 注册路由 | 新引入第二套框架 | ETag/If-Match 须与既有中间件共存，代理是否剥离待验 |
| 输入校验 | Node 栈单一 schema 校验器（Zod 类）产出字段级错误 + 领域层二次校验 | class-validator、TypeBox、手写 if 链 | AC-002 要求逐项字段错误；清单外字段须显式拒绝而非静默忽略 |
| 电话格式 | 入库前自写归一化（去空格与 `()`、`-`）+ 宽松格式校验 | libphonenumber 系严格判定 | 严格化依赖区域口径，过严会拒真实号码；Q1 最小集合下不新增依赖为宜 |
| 检索 | `ILIKE`/前缀，可选 `pg_trgm` + GIN | `to_tsvector` 全文；ES / Meilisearch / Typesense | 默认全文对中文姓名分词效果差；团队级规模引搜索引擎为过度设计 |
| 翻页排序键 | 不可变键 `(created_at, customer_id)` 或键集游标 | plan §4 现约 `(updatedAt DESC, customerId)` | 直接关系 AC-005，见 2.1 |
| 变更留痕 | 自研同事务写 `customer_change_log`（逐字段、先掩码再落库） | 通用审计组件、JSON diff 列 | 未识别到可信的"前值脱敏"成品组件；自研需字段白名单与测试 |
| 日志脱敏 | 结构化字段白名单 + 显式掩码函数（若既有 logger 支持 `redact` 类能力） | 事后正则替换、框架默认输出 | 白名单为 fail-closed：新增字段默认不输出明文 |
| 认证授权 | identity-adapter 桥接既有会话 → Principal，仅两权限点 | 自建账号、完整 RBAC/ABAC、新增 OIDC 客户端 | spec Integrations 明确复用现有登录与人员目录；无行级粒度（Q3 定稿） |
| 客户编号 | 服务端生成、不可变、非枚举（`node:crypto` 随机 UUID + 前缀，或 UUIDv7） | 自增整型、外部发号服务 | 自增暴露规模；UUIDv7 在目标运行时的可得性未核实（V-08） |
| 测试 | Vitest / node:test + 真 PostgreSQL 跑集成与契约 | 内存库 H2/SQLite、纯手工点测 | 唯一冲突、版本冲突、翻页不重不漏只有真库能验证；容器运行时可得性未核实（V-05） |
| 可观测性 | 随既有栈取一（OTel JS / prom-client 类），指标含 409/422 比例与写回滚 | 仅应用日志、APM 全家桶 | SQL 打点只含语句名，禁参数明文 |

## 2 关键决策详解

**2.1 排序键与 AC-005**
Decision：默认排序键取不可变列，`updated_at` 仅作展示或显式可选排序。
Rationale：`updated_at` 每次修改都变，翻页期间他人编辑会使记录跨页漂移或遗漏，违反 AC-005。
Alternatives：一致性快照读、前端全量拉取。
Tradeoff：失去"最近变更优先"默认视图；若业务需要该视图，须明示翻页可能漂移。plan §4 暂定键由 T8 翻页用例裁决。

**2.2 唯一性以归一化列为前提**
Decision：唯一索引建在 `phone_normalized` 上，原始书写值另存。
Rationale：AC-003 要求 `138-0000-5678` ≡ `13800005678`；不在入库前统一归一化，索引即被书写差异绕过。
Alternatives：仅展示层清洗（无效）、应用层先查后写（并发窗口）。
Tradeoff：多一列与一套规范约定；正则边界属技术细节，不需业务决策。

**2.3 留痕与脱敏同层实现**
Decision：不引第三方审计框架，由用例层在同一事务内按字段生成并先掩码后落库。
Rationale：通用审计组件倾向整包保存原始 JSON diff，与"敏感字段前值不留明文"冲突，改造成本高于最小自研。
Alternatives：审计组件 + 自定义 listener 过滤、JSON diff 列（architecture 已否决）。
Tradeoff：自研需覆盖字段白名单与 AC-009 测试，写放大由独立表承担。

**2.4 不引入新外部组件**
Decision：不引搜索引擎、缓存、消息队列、发号服务与外部数据补全，也不新增第二套 ORM / HTTP 框架。
Rationale：Non-Goals 与 spec Integrations 已限定范围；2s/3s 由索引与分页满足。
Tradeoff：写路径与留痕同事务略增时延，换取"失败不留半条记录"。

## 3 剩余未决技术项（不需业务决策）

1. 既有 HTTP 框架、Principal 来源（会话 Cookie 名称、人员目录接口）——读码确认。
2. 目标 PG 版本与 `pg_trgm` 是否可安装（云托管常受限，V-04）。
3. 校验器与日志器是否已有仓库内既定选型——沿用优先，避免新增依赖。
4. 排序键最终选型（2.1）与是否需要 `Idempotency-Key`。
