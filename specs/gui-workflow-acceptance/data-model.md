# Data Model — GUI Workflow Acceptance (Local `GET /health`)

**Feature ID**: `gui-workflow-acceptance` · **Companions**: `spec.md`、`clarification.md`、`architecture.md`、`contracts/openapi.yaml`、`test-plan.md`
**Persistence decision**: 无 PostgreSQL 实例、无 schema、无表。唯一对外数据形态是内存常量字节串 `{"ok":true}`（11 字节，R-02）。依据 spec「Data and Privacy」与「Integrations」（无数据库、缓存、消息队列）及 Non-Goals（排除数据库与任何持久化）。本文各节据此记录不适用理由，不虚构表结构。

## Table Purpose

需求面为单路由、无状态、匿名的存活应答端点，任何被批准的行为都不需要写入或读取记录：200 响应体是固定字面量，404/405 只断言状态码与完整终止（Q-05），日志非需求且默认不记录（spec Data and Privacy）。因此不存在表、视图、物化视图或序列的用途。若将来要求依赖检查、版本、uptime、时间戳等富健康信息，或将 404/405 错误正文纳入验收，须作为新需求重新澄清后再评估持久化——本轮不做假设。

## Fields and Types

无 PostgreSQL 列类型映射。产品侧唯一的数据形状是成功响应体，其逻辑结构由 `contracts/openapi.yaml` 的 `HealthResponse` 声明：单字段 `ok`，类型 boolean，取值恒为 `true`，`additionalProperties: false`。

| 逻辑字段 | 类型 | 来源 | 持久化 |
|---|---|---|---|
| `ok` | boolean，恒 `true` | R-02、Q-03；schema 见契约 | 否，内存常量字面量直写（plan.md D-04） |

查询串为自由形式且完全不参与路由（Q-06），因此不定义任何查询字段、参数类型或扩展列；请求方法与请求路径仅在内存中用于选择状态码，不落库、不回显（R-03）。

## Keys and Constraints

无主键、外键、唯一索引或 CHECK 约束。`/health` 的「身份」由路由层的精确、大小写敏感字符串相等判定保证（R-01），这比数据库唯一约束更强：它没有别名、重定向、尾斜杠归一化或大小写归一化的路径（Q-06）。`ok` 的恒真约束在 schema 层以 `const: true` 表达；不引入 JSON/JSONB 列，因为该值永不写入。

## Indexes

无索引。路由决策是单次精确字符串比较（取 `req.url` 首个 `?` 前子串，原始文本、不解码、不归一化，plan.md D-05），任何 B-tree/hash/表达式索引都无法表达「必须逐字符相等」这一语义，反而会诱导出前缀或大小写不敏感匹配，直接违反 R-01 并使 AC-002 失败。`/health/`、`/HEALTH`、`/healthz`、`%68ealth` 全部必须 404，这正是「不建索引、不做归一化」的验收体现。

## Relationships

无实体关系。系统参与者只有匿名探测/测试客户端与单服务进程（spec Actors）；到达回环端口的所有客户端拥有相同的匿名只读访问，无认证、无授权、无角色、无会话（Q-08），因此不存在用户表、权限表、会话表或任何关联表，也不存在 1:N、N:N 或继承关系需要建模。

## Lifecycle

无记录级生命周期、无状态机、无数据状态转换。进程级生命周期为：启动并绑定 `127.0.0.1:3001` → 逐请求无状态应答（重复与并发请求结果一致，R-03）→ 停止并释放监听端口（F-03）。启动时端口被占用即快速失败、不重试、不改端口（architecture Failure Model）。无数据即无保留期、删除、归档、软删除与导出需求；PITR、备份与恢复演练同样不适用。

## Sensitive Data

不存储任何数据：无个人数据、无凭据、无令牌、无会话标识、无请求内容镜像（R-03 不回显请求内容）。因此没有列需要加密、脱敏、掩码或数据分类分级，也没有密钥管理面、行级安全策略或访问审计表。唯一的暴露面控制即 IPv4 回环绑定本身（R-03、AC-004）：不监听通配地址，非回环连接在绑定层面即不收；IPv6 `::1` 连不上属预期且不计入验收（Q-07）。实现若附带诊断输出，不得改变任何 HTTP 应答、不得落盘数据。

## Migration Notes

无迁移。不存在数据库夹具、schema 版本表、`alembic`/`flyway`/`liquibase` 迁移脚本，也不需要 expand-contract、回填、双写或回滚步骤；`migration` 能力在本工作流中亦未启用。部署与回滚等价于进程启停与代码版本切换，不涉及任何数据状态变更，故向后兼容与数据修复程序均不适用。数据库相关验收项（PG 版本、`search_path`、角色权限、连接池、迁移 up/down）在 `test-plan.md` 中逐条记为不适用，未虚构任何通过记录。
