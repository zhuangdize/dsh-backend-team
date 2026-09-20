# 客户管理 数据模型（PostgreSQL）

依据 `spec.md`（AC-001–AC-010）、`clarification.md`（Q1–Q3 已定稿，无未决业务问题）、`plan.md` §2、`contracts/openapi.yaml`。定稿口径：必填 `name`、`phone`；`contact_person`、`email`、`company`、`note` 可选；`phone` 归一化后系统内唯一为最终判重依据；授权人员可读写全部客户，无行级与字段级权限差异；清单外字段不建列、不接受、不静默写入。目标 PostgreSQL ≥ 12（使用 STORED 生成列；实际版本属实现期确认项，若低于 12 则由应用层写入 `phone_key` 并保留唯一索引兜底）。schema 为 `crm`。

## Table Purpose

| 表 | 用途 | 覆盖 AC |
| --- | --- | --- |
| `crm.customer` | 客户主档，一行一客户；承载新增、关键词分页查询、详情与局部修改（乐观并发） | AC-001–AC-008 |
| `crm.customer_change_log` | 逐字段变更留痕，仅追加；详情"最近变更"与历史分页的数据源 | AC-009 |

本期不做删除、合并与回收站（Non-Goal），两表均无软删除标记列。

## Fields and Types

`crm.customer`：

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| customer_id | varchar(40) | NOT NULL, PK | 服务端生成，形状 `^[A-Z]{2,4}-[0-9A-Za-z-]{6,32}$`，创建后不可变更、不可由客户端指定 |
| name | varchar(100) | NOT NULL + CHECK | trim 后 1–100 字符 |
| contact_person | varchar(50) | NULL | 联系人；Q1 定稿为可选，不参与必填与判重校验 |
| phone | varchar(20) | NOT NULL + CHECK | 展示值，保留原始书写，按契约正则 `^[0-9()+ -]{6,20}$` 校验 |
| phone_key | varchar(20) | GENERATED ALWAYS AS (lower(regexp_replace(phone,'[^0-9+]','','g'))) STORED | 去除空格与 `()`、`-` 等分隔符后的归一化号码，唯一性判定列 |
| email | varchar(100) | NULL + CHECK | 基本格式校验（含 `@` 与点、无空格） |
| company | varchar(100) | NULL | 公司名称 |
| note | varchar(1000) | NULL | 备注 |
| version | integer | NOT NULL DEFAULT 1, CHECK ≥ 1 | 乐观锁版本，与 ETag 等价 |
| created_by / updated_by | varchar(64) | NOT NULL | 人员目录 userId，无本地 FK |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() | UTC 存储 |

`crm.customer_change_log`：`id` bigint identity PK；`customer_id` varchar(40) NOT NULL；`field` varchar(32) NOT NULL；`old_value`、`new_value` varchar(1000) NULL（敏感字段仅存脱敏值或"该字段已被修改"）；`changed_by` varchar(64) NOT NULL；`changed_at` timestamptz NOT NULL DEFAULT now()；`request_id` varchar(64) NULL。`field` 存 snake_case 列名白名单（name/contact_person/phone/email/company/note），出参按契约映射为 camelCase（如 `contactPerson`）。

## Keys and Constraints

- 主键：`customer.customer_id`、`customer_change_log.id`。
- 唯一：`UNIQUE (phone_key)` 是电话重复的最终裁决（AC-003）；应用层捕获 SQLSTATE 23505 转 409 `CUSTOMER_PHONE_TAKEN`，附已存在客户名称摘要。
- 外键：`customer_change_log.customer_id → customer.customer_id`，`ON DELETE RESTRICT`（本期无删除路径）。
- CHECK：name trim 非空且 ≤100；phone 匹配契约正则；email 为空或基本合法；version ≥ 1；`field` 白名单枚举。
- 不可变：`customer_id`、`created_at`、`created_by` 不进入任何 UPDATE 语句；`customer_change_log` 仅 INSERT（应用写入路径 + 列权限双层保证）。
- 一次成功修改的多条留痕共享同一 `request_id`，与该 UPDATE 原子绑定。

## Indexes

| 索引 | 定义 | 目的 |
| --- | --- | --- |
| customer_pkey | btree(customer_id) | 详情与修改定位 |
| uq_customer_phone_key | UNIQUE btree(phone_key) | 阻止重复录入（含 `138-0000-5678` 与 `13800005678` 等价） |
| ix_customer_name_prefix | btree(name varchar_pattern_ops) | `name LIKE 'kw%'` 前缀检索 |
| ix_customer_updated | btree(updated_at DESC, customer_id ASC) | 分页固定排序键，翻页不重不漏（AC-005） |
| ix_changelog_customer_time | btree(customer_id, changed_at DESC) | 历史倒序分页（AC-009） |

联系人/电话的包含式 `ILIKE '%kw%'` 不走上述 btree；团队级数据量下顺序扫描可接受，如需加速再安装 `pg_trgm` 并加 `GIN (phone gin_trgm_ops)`（可选，不默认启用，实现期以翻页与延迟实测决定）。

## Relationships

`customer 1 — N customer_change_log`（按 customer_id 关联，一次修改写入被改字段的若干行）。`customer_id` 是对外引用键，订单/跟进模块本期不建外键、不联动。人员（created_by/updated_by/changed_by）来自现有人员目录，仅存 userId；本模块不建用户表、不存凭据，也不做权限映射表（Q3 定稿为授权人员均可改全部客户）。

## Lifecycle

1. 新增：事务内插入 `customer`（version=1，编号服务端生成）；创建事实由 `created_by/created_at` 承载，不写逐字段留痕；唯一冲突整体回滚，不产生半记录。
2. 查询/详情：只读，无状态迁移。
3. 修改：`UPDATE crm.customer SET <提交字段>, version = version + 1, updated_by = $u, updated_at = now() WHERE customer_id = $1 AND version = $2`；影响 0 行时按编号是否存在判定 404 或版本冲突 409；成功则同事务逐字段 INSERT 留痕，全部提交或全部回滚（AC-006/008/009）。
4. 保留：数据保留至系统外明确清理（本期无自助删除）；无归档、无状态机。

## Sensitive Data

`phone`、`email` 为个人敏感信息：主档存明文，仅具备 `customer:read` 的授权人员可读取；变更历史的 `old_value/new_value` 与所有日志一律脱敏（`138****5678`、`a***@example.com`），敏感字段前值不保留明文；`note` 不入日志。SQL 参数（含电话关键词）不进入追踪打点。本期无批量导出，故不存在脱敏导出通道。

## Migration Notes

顺序：001 建 `crm` 与 `customer`（列 + CHECK）；002 加 `phone_key` 生成列与 `uq_customer_phone_key`；003 建 `customer_change_log`、外键与索引；004 授予应用账号最小权限（change_log 仅 INSERT + SELECT）。均为新建对象，无历史数据回填；回滚按逆序 DROP（004→001），无破坏性数据变更。Q1 已定稿为最小字段集合，本期迁移不含 `ADD COLUMN`，也不建信用代码/来源/负责人/地区列；未来扩展须另立需求后走追加式迁移。Q2 已定稿为电话单列唯一，不建复合唯一索引。迁移脚本编写与真实数据库上的 DDL/索引/回滚验证归实现阶段与主机执行，本设计阶段未执行任何 DDL。
