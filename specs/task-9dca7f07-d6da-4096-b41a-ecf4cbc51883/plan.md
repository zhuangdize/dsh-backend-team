# 客户管理 实施计划

依据：`spec.md`（AC-001–AC-010）、`clarification.md`（Q1–Q3 已定稿，无未决业务问题）、`architecture.md`、`contracts/openapi.yaml`。本文件只描述计划，不含实现代码。

## 1. 技术基线

- 运行时/语言：Node（宿主 24.19.0）+ TypeScript strict，沿用仓库既有 monorepo 工具链与脚本入口。
- 持久化：PostgreSQL + Drizzle ORM，schema 与迁移沿用既有 drizzle-kit 生成流程，迁移文件落在 `migrations/`。
- 形态：现有后端服务内的独立模块 `src/customers/`；不新建服务、不引入新账号体系，只读取既有登录态与人员目录，不修改其他业务模块代码。
- 允许写入范围：`src/`、`test/`、`migrations/`（本角色仅写规格文档，未触碰业务代码）。
- 实现期确认项（技术细节，不需业务决策）：上游会话 Cookie 名称与 Principal 桥接方式、目标 PG 版本、关键词检索是否启用 `pg_trgm`、号码归一化正则边界、翻页排序键最终选型。

## 2. 数据模型

**customers**：`customer_id`（服务端生成、不可变、可作外部引用键）、`name`（必填，1–100，trim 后非空）、`contact_person`（可选）、`phone`（必填，保留原始书写）、`phone_normalized`（去除空格与 `()`、`-` 等分隔符后的数字串，唯一索引）、`email`（可选）、`company`、`note`、`version`（乐观锁）、`created_by/created_at`、`updated_by/updated_at`。

**customer_change_log**：`id`、`customer_id`(FK)、`field`、`old_value_masked`、`new_value_masked`、`changed_by`、`changed_at`、`request_id`；索引 `(customer_id, changed_at DESC)`。敏感字段前值仅以脱敏形态或“该字段已被修改”落库。

字段清单外不建列、不接受、不静默写入；无删除/软删标记（Non-Goal）。

## 3. 工作分解（按依赖顺序）

| # | 任务 | 产出位置 | 关联 AC |
| --- | --- | --- | --- |
| T1 | 迁移：customers（含 `phone_normalized` 唯一索引）与 customer_change_log | `migrations/`、`src/customers/persistence/schema.ts` | AC-003/006/009 |
| T2 | domain：Customer 聚合、字段校验、号码归一化、编号生成、版本自增、ChangeLog 值对象 | `src/customers/domain/` | AC-001/002/006 |
| T3 | persistence：仓储实现（插入、按编号读取、关键词分页 + 总数、版本条件更新） | `src/customers/persistence/` | AC-004/005/007/008 |
| T4 | identity-adapter：会话校验 → Principal，暴露 `customer:read` / `customer:write` | `src/customers/identity/` | AC-010 |
| T5 | application 用例：create / search / detail / update（更新与留痕同事务） | `src/customers/application/` | AC-001/003/006/008/009 |
| T6 | api：契约 5 个端点、错误映射（400/401/403/404/409/412/422/503）、ETag/If-Match | `src/customers/api/` | 全部 |
| T7 | 脱敏能力 + 结构化日志与指标接入 | `src/customers/support/` | AC-009、NFR |
| T8 | 单元/集成/契约测试与端到端验收场景 | `test/customers/` | AC-001–AC-010 |

## 4. 关键实现决策

- **电话唯一**：归一化列 + 数据库唯一索引为最终裁决；捕获唯一冲突后回滚并返回 409 `CUSTOMER_PHONE_TAKEN`，附已存在客户名称摘要；创建失败不得留下半条记录（AC-003）。
- **并发**：更新强制携带 `If-Match`（或 body `expectedVersion`），版本不匹配返回 409 `CUSTOMER_VERSION_CONFLICT`，禁止静默覆盖（AC-008）。
- **局部更新**：`PATCH` 仅更新提交字段；`customerId`、`createdAt`、`createdBy` 只读；改后电话同样受唯一索引约束。
- **查询**：`keyword` 命中名称/联系人/电话；`page`/`pageSize`（上限 100）+ `total`；无命中返回 200 空列表（AC-004/005）。契约暂固定排序键 `(updatedAt DESC, customerId ASC)`，实现期以 T8 翻页用例验证“不重不漏”，必要时改键集游标。
- **权限**：未认证 401、已认证无权限 403；不区分“不存在”与“无权”以外信息，人员目录不可用时 fail closed（AC-010）。
- **脱敏**：`phone` → `138****5678`、`email` → `a***@example.com`，仅用于变更历史值与日志，不用于业务响应。

## 5. 测试与验收映射

- 单元：必填/超长/trim、电话与邮箱格式、归一化等价（`138-0000-5678` ≡ `13800005678`）、编号只读、脱敏函数 → AC-001/002/003。
- 集成（需 PostgreSQL）：唯一冲突回滚、版本冲突、局部更新、分页无重无漏、历史完整性与操作人 → AC-003/005/006/008/009。
- 契约：按 `contracts/openapi.yaml` 校验请求/响应与 401/403/404/409/412/422 语义、字段级错误结构 → AC-002/007/010。
- 端到端：逐条跑 AC-001–AC-010 场景。当前无已执行的自动化验证：本角色未运行任何构建、类型检查或测试；仓库已检测到的脚本状态为未验证，实际执行归属实现与验证阶段（主机在角色之后运行计划内 Node 测试）。

## 6. Definition of Done

AC-001–AC-010 全部通过；日志与历史前值无敏感明文；迁移可前滚可回退；实现与契约一致；`src`/`test`/`migrations` 之外的边界未被改动；技术基线确认项（§1）有明确结论或明确假设记录。
