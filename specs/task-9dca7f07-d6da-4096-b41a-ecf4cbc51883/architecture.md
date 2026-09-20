# 客户管理 后端架构设计

## Context

单团队内部客户主数据维护：新增、关键词查询（分页 + 总数）、详情、修改、变更历史，覆盖 AC-001–AC-010。需求口径已定稿（clarification Q1–Q3）：字段最小集合（必填 `name`、`phone`；可选 `contactPerson`、`email`、`company`、`note`，清单外字段拒绝）；`phone` 归一化后系统内唯一为最终判重依据；授权人员可修改全部客户，不设只读角色与行级（录入人）权限。

技术栈沿用仓库既有边界（宿主只读检查证据：`package.json`、`src/personnel/persistence/schema.ts`、`packages/database/src/drizzle-kit-generator.ts`）：Node + TypeScript strict 的单体 monorepo、Drizzle ORM + PostgreSQL、Vitest/node:test。功能作为 `src/customers/` 独立模块并入现有服务，写入范围限 `src`、`test`、`migrations`。规模团队级（数十人同时在线），延迟沿用 spec 目标（查询 2s、写入 3s），未虚构额外指标。

## Module Boundaries

| 模块 | 职责 | 明确不负责 |
| --- | --- | --- |
| customer-api | 路由、请求解码、HTTP 状态与错误映射、ETag/If-Match | 业务规则判定、SQL |
| customer-application | create/search/detail/update 用例编排、事务边界、乐观并发、留痕写入 | HTTP 细节、持久化细节 |
| customer-domain | Customer 聚合、字段与格式校验、号码归一化、唯一性断言、版本自增、ChangeLog 值对象 | ORM 与序列化；时间取自注入的 Clock |
| customer-persistence | Drizzle schema、客户与变更表读写、唯一索引、关键词分页、版本条件更新 | 业务决策 |
| identity-adapter | 验证现有登录态与人员目录，输出 `Principal { userId, displayName, teamId, permissions }` | 本地账号、密码、令牌签发 |
| audit-redaction | `phone`/`email` 脱敏函数，供日志与历史值使用 | 变更明文存储策略 |

依赖方向：api → application → domain ← persistence / identity 实现端口。domain 不依赖外层，也不依赖其他业务包；人员目录仅经 identity-adapter 只读访问，本期不改 `src/personnel/` 代码。

## Request Flow

1. 接口层接收请求 → 身份中间件校验会话（复用现有登录态），解析 Principal；缺失即 401，无权限 403。
2. 结构解码（类型、必填存在性、清单外字段拒绝）在接口层，规则校验（trim 非空、长度、电话/邮箱格式）在领域层，字段级错误汇总为 422。
3. 创建：开事务 → 计算 `phone_normalized` → 依赖唯一索引插入 → 编号服务端生成（客户端不可指定）→ 提交后 201 返回详情；冲突回滚并映射 409 + 已存在客户名称摘要（AC-001/002/003）。
4. 查询：`keyword` 匹配名称/联系人/电话 + `page`/`pageSize` → 摘要列表与 `total`；无命中返回 200 空列表而非全量（AC-004/005）。
5. 详情：按编号读取档案与最近变更（脱敏值），响应带 ETag（= `version`）；不存在 404（AC-007/009）。
6. 修改：携 `If-Match` → 仅更新提交字段 → 版本不符返回 409 要求刷新（AC-008）→ 成功时**同一事务**写客户行与逐字段变更（变更人、时间、前后值脱敏），返回新值与新版本（AC-006/009）。
7. 跨模块仅以 `customerId` 作为引用键，本期不与订单/跟进联动。

## API and Authentication

- 契约以 `contracts/openapi.yaml` 为唯一权威：`POST /api/v1/customers`、`GET /api/v1/customers`、`GET /api/v1/customers/{customerId}`、`PATCH /api/v1/customers/{customerId}`、`GET /api/v1/customers/{customerId}/changes`。
- 认证：沿用现有系统会话（Bearer 会话令牌或同源 Cookie，名称由部署配置确定，契约不虚构）；本模块不自建登录、不签发令牌。
- 授权：仅两个权限点 `customer:read` / `customer:write`；已定稿为授权人员可读写全部客户，无字段级与行级差异（Q3）。
- 未认证 401、已认证无权限 403；权限不足与资源不存在的响应不泄露数据是否存在（AC-010）。
- 并发：更新强制版本条件（`If-Match`，缺失/非法 412）；创建非幂等，是否支持 `Idempotency-Key` 由实现期决定。

## Failure Model

| 故障 | 行为 |
| --- | --- |
| 必填缺失/格式非法/清单外字段 | 422 + fieldErrors，事务不启动，输入由客户端保留 |
| 电话归一化后已存在 | 409 `CUSTOMER_PHONE_TAKEN`，整体回滚，无半条记录（AC-003） |
| 客户编号不存在 | 404（AC-007） |
| 版本不匹配（他人已改） | 409 `CUSTOMER_VERSION_CONFLICT`，不落库，提示刷新（AC-008） |
| 数据库不可用/写失败 | 503/500，事务回滚，不自动重试写 |
| 人员目录不可达 | 无法判定权限时 fail closed → 403 |
| 变更留痕写入失败 | 与主更新同事务，任一失败整体回滚，保证可追溯 |
| 分页参数越界 | 400；`pageSize` 上限 100 |

## Observability

- 结构化日志：requestId、userId、teamId、operation、customerId、result、errorCode、latencyMs；**禁止**记录手机号、邮箱、备注明文，查询参数（含电话关键词）不打点。
- 指标：请求量与延迟直方图（对齐 2s/3s 目标）、422/409 比例（判重与并发冲突观测）、写事务回滚数、身份校验失败数、慢查询数。
- 追踪：requestId 贯穿 api → application → persistence；SQL 打点仅含语句名不含参数明文。
- 审计：`customer_change_log` 即业务侧可查审计（AC-009），与客户数据同生命周期，保留至明确清理。
- 告警建议：5xx 比例、写事务失败率、identity-adapter 不可用。

## Alternatives

- **现有服务内独立模块 vs 独立微服务**：数据量与团队规模小、无独立伸缩诉求，选前者（最低集成与鉴权成本）；多团队共享需求出现后再拆分。
- **归一化列 + 唯一索引 vs 应用层查重**：前者并发下才可靠，后者存在竞态窗口；结论为索引兜底 + 应用层友好提示。
- **version/ETag 乐观锁 vs 悲观行锁**：乐观锁满足“先查询后保存”，避免长事务与死锁成本。
- **独立变更表 vs JSON diff 列**：独立表便于按字段查询与脱敏控制，写放大在量级内可接受。
- **PG 索引/LIKE vs 全文检索引擎**：团队级数据量用前者足够，引入搜索引擎属过度设计。

## Risks

- 仓库技术栈结论来自宿主只读检查证据（Drizzle/PostgreSQL/Node），模块内部实际 API 与既有 HTTP 框架契约需在实现阶段读码确认，本设计未验证其可编译性。
- 已检测的验证脚本尚未执行，构建/类型检查/测试状态为未验证；不得据本设计声称通过。
- `IF-Match` 与 ETag 的版本语义需与现有 HTTP 层缓存中间件共存，可能被代理层剥离，需在 T6 集成验证。
- 以 `updatedAt` 为翻页排序键时，翻页期间被修改的记录可能移位，影响 AC-005，备选键集游标待实现期定。
- 电话作为关键词检索与“敏感信息不入日志”存在张力，需坚持参数不落盘。
- 本期无删除能力，脏数据只能由管理员在系统外清理，需配套运维流程说明。
