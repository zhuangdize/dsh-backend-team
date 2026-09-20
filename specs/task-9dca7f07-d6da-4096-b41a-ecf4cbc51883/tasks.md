# 客户管理 实施任务

依据 spec.md（AC-001–AC-010）、plan.md §2/§3（T1–T8）、architecture.md 模块边界、contracts/openapi.yaml；test-plan.md 的 evidence id 与测试文件路径按原样保留，不新增证据标识。实现映射为 Node + TypeScript（宿主 Node 24 直跑）：每个任务只声明一个具体工作区相对文件产出位置，不使用目录或通配写法；迁移脚本与表定义按任务元数据顺序应用。自动化断言使用内存假仓储与 loopback HTTP，不依赖真实数据库与外部网络；PostgreSQL 适配仓储（T-13、T-18、T-26、T-27、T-33）随所属切片交付，其 SQL、索引与列权限行为只能由主机真库验证。术语以 data-model.md 与契约的 `phone_key` 为准（plan §2 的 `phone_normalized` 同义）；D-03/D-04/D-05/D-09/D-11/D-14/D-15 为实现期读码确认项，不改动其他业务模块。

## Slices

- S-1 创建与字段校验（AC-001/002）
- S-2 电话唯一性（AC-003）
- S-3 关键词分页查询（AC-004/005）
- S-4 详情、局部更新与乐观并发（AC-006/007/008，含写入侧留痕）
- S-5 变更历史读取与留痕（AC-009）
- S-6 认证与授权（AC-010）
- S-7 日志脱敏与可观测性（AC-009 + NFR）

## Tasks

<!-- backend-team:task id=T-01 slice=S-1 requirements=AC-001,AC-002 owner=developer risk=standard layer=domain files=src/customers/domain/customer.ts evidence=customer-model-test -->
- [ ] T-01 实现 Customer 聚合：name 必填（trim 后 1–100 非空）、phone 必填且匹配契约正则、contact_person/company/note 可选、email 可选基本格式；编号服务端生成 ^[A-Z]{2,4}-[0-9A-Za-z-]{6,32}$，客户端传入 customerId 被忽略且创建后不可变；version=1；按字段输出 REQUIRED/TOO_LONG/INVALID_FORMAT/IMMUTABLE 错误项。

<!-- backend-team:task id=T-02 slice=S-1 requirements=AC-001 owner=developer risk=standard layer=persistence files=src/customers/persistence/memory-customer-repository.ts evidence=customer-model-test depends=T-01 -->
- [ ] T-02 建立内存假仓储：insert（created_at/updated_at 创建后不可变）、findById、count；语义与 data-model.md 的唯一索引与版本条件更新一致（唯一性分支见 T-08）。

<!-- backend-team:task id=T-03 slice=S-1 requirements=AC-001,AC-002 owner=developer risk=standard layer=domain files=src/customers/application/create-customer.ts evidence=customer-model-test depends=T-01,T-02 -->
- [ ] T-03 实现 createCustomer 用例：领域校验→聚合构建→仓储落库；任一步失败不产生记录，字段错误项供 422 定位到具体字段。

<!-- backend-team:task id=T-04 slice=S-1 requirements=AC-001,AC-002 owner=developer risk=standard layer=contract files=src/customers/api/app.ts evidence=customer-model-test depends=T-03 -->
- [ ] T-04 搭建 loopback HTTP 应用：模块内路由挂载 + 统一错误结构 code/message/requestId/fieldErrors（与 openapi 一致），沿用既有 HTTP 入口与错误映射边界（D-05 读码确认）。

<!-- backend-team:task id=T-05 slice=S-1 requirements=AC-001,AC-002 owner=developer risk=standard layer=contract files=src/customers/api/create-customer.ts evidence=customer-model-test depends=T-04 -->
- [ ] T-05 实现 POST /api/v1/customers：成功 201+Location；字段不合法 422 并逐项列出 fieldErrors；清单外字段显式拒绝、不静默写入。

<!-- backend-team:task id=T-06 slice=S-1 requirements=AC-001,AC-002 owner=developer risk=standard layer=test files=test/customer-model.test.mjs evidence=customer-model-test depends=T-01,T-02,T-03,T-04,T-05 -->
- [ ] T-06 按 test-plan.md 场景编写并运行 `node --test test/customer-model.test.mjs`：断言契约中全部合法/非法输入分支，含多字段同时非法时逐项列出。

<!-- backend-team:task id=T-07 slice=S-2 requirements=AC-003 owner=developer risk=standard layer=domain files=src/customers/domain/phone-key.ts evidence=customer-phone-uniqueness-test -->
- [ ] T-07 实现号码归一化（去空格/括号/连字符/点、保留前导 +、小写），与 data-model 的 STORED 生成列表达式一致，使 `138-0000-5678` 与 `13800005678` 同键。

<!-- backend-team:task id=T-08 slice=S-2 requirements=AC-003 owner=developer risk=standard layer=persistence files=src/customers/persistence/memory-customer-repository.ts evidence=customer-phone-uniqueness-test depends=T-02,T-07 -->
- [ ] T-08 insert 增加 phone_key 唯一检查：冲突抛 PhoneTaken（携带已存在客户名称摘要）且整体不写入、记录数不变。

<!-- backend-team:task id=T-09 slice=S-2 requirements=AC-003 owner=developer risk=standard layer=domain files=src/customers/application/create-customer.ts evidence=customer-phone-uniqueness-test depends=T-03,T-08 -->
- [ ] T-09 创建用例把 PhoneTaken 原样上抛：不落库、不吞异常、不留半记录，保留已存在客户名称摘要供路由展示。

<!-- backend-team:task id=T-10 slice=S-2 requirements=AC-003 owner=developer risk=standard layer=contract files=src/customers/api/create-customer.ts evidence=customer-phone-uniqueness-test depends=T-05,T-09 -->
- [ ] T-10 创建路由将冲突映射为 409 CUSTOMER_PHONE_TAKEN，details.existingCustomer 返回已存在客户摘要（对齐 ConflictPayload）。

<!-- backend-team:task id=T-11 slice=S-2 requirements=AC-003 owner=developer risk=high layer=persistence files=migrations/001-crm-customer.sql evidence=customer-phone-uniqueness-test -->
- [ ] T-11 编写迁移 001：crm.customer 建表（列 + CHECK + 审计列）、ix_customer_name_prefix、ix_customer_updated；附逆序回滚。真库执行由主机完成。

<!-- backend-team:task id=T-12 slice=S-2 requirements=AC-003 owner=developer risk=high layer=persistence files=migrations/002-phone-key-unique.sql evidence=customer-phone-uniqueness-test depends=T-11 -->
- [ ] T-12 编写迁移 002：phone_key STORED 生成列与 uq_customer_phone_key 唯一索引；若既有 Drizzle 版本不支持生成列（D-03），按 data-model 退化口径由应用层写入该列并保留唯一索引兜底；附逆序回滚。

<!-- backend-team:task id=T-13 slice=S-2 requirements=AC-003 owner=developer risk=high layer=persistence files=src/customers/persistence/schema.ts evidence=customer-phone-uniqueness-test depends=T-07,T-12 -->
- [ ] T-13 按 plan §3 T1 建立 Drizzle 表定义：与迁移 001/002 的列、CHECK、phone_key 与两个索引逐一对齐，沿用仓库既有 drizzle-kit 流程（D-04 读码确认）。真库 DDL 与索引生效由主机验证。

<!-- backend-team:task id=T-14 slice=S-2 requirements=AC-003 owner=developer risk=standard layer=test files=test/customer-phone-uniqueness.test.mjs evidence=customer-phone-uniqueness-test depends=T-08,T-10,T-13 -->
- [ ] T-14 编写并运行 `node --test test/customer-phone-uniqueness.test.mjs`：先建 A，再以同归一化键建 B → 错误码 CUSTOMER_PHONE_TAKEN、摘要含 A 名称、仓储计数仍为 1。

<!-- backend-team:task id=T-15 slice=S-3 requirements=AC-004,AC-005 owner=developer risk=standard layer=persistence files=src/customers/persistence/memory-customer-repository.ts evidence=customer-search-test depends=T-01,T-08 -->
- [ ] T-15 仓储增加 search(keyword,page,pageSize)：name/contact_person 大小写不敏感包含匹配、phone 按归一化包含匹配；排序键 (updated_at desc, customer_id asc)（D-11 由本用例裁决）；返回 items+total，未命中返回空列表而非全量。

<!-- backend-team:task id=T-16 slice=S-3 requirements=AC-004,AC-005 owner=developer risk=standard layer=domain files=src/customers/application/search-customers.ts evidence=customer-search-test depends=T-15 -->
- [ ] T-16 实现 searchCustomer 用例：keyword trim、page≥1、pageSize 上限 100（越界归一或 400），返回 CustomerPage 形状。

<!-- backend-team:task id=T-17 slice=S-3 requirements=AC-004,AC-005 owner=developer risk=standard layer=contract files=src/customers/api/search-customers.ts evidence=customer-search-test depends=T-16 -->
- [ ] T-17 实现 GET /api/v1/customers：keyword/page/pageSize 参数解析与 400；响应 CustomerPage（items/page/pageSize/total）。

<!-- backend-team:task id=T-18 slice=S-3 requirements=AC-004,AC-005 owner=developer risk=standard layer=persistence files=src/customers/persistence/drizzle-customer-query.ts evidence=customer-search-test depends=T-13,T-15 -->
- [ ] T-18 实现查询侧 PostgreSQL 仓储（plan §3 T3）：以 T-13 表定义做 ILIKE/前缀检索 + count(total) + 固定排序键分页，并读取详情所需列；语义与 T-15 内存实现一致，未命中返回空集合；`pg_trgm` 仅在 D-10/V-04 确认可安装时增补。Node 测试运行器无实时数据库，本任务 SQL 行为由主机集成执行验证。

<!-- backend-team:task id=T-19 slice=S-3 requirements=AC-004,AC-005 owner=developer risk=standard layer=test files=test/customer-search.test.mjs evidence=customer-search-test depends=T-14,T-16,T-17,T-18 -->
- [ ] T-19 编写并运行 `node --test test/customer-search.test.mjs`：名称/联系人/电话关键词结果集合等于预期且 total 一致；未命中为空列表；5 条数据以 pageSize=2 遍历，各页 id 互不相交、并集为全量、排序键符合契约。

<!-- backend-team:task id=T-20 slice=S-4 requirements=AC-009 owner=developer risk=standard layer=domain files=src/customers/support/redaction.ts evidence=customer-change-log-test -->
- [ ] T-20 实现显式掩码函数：phone→`138****5678`、email→`a***@example.com`（D-13 口径），供更新事务内留痕与日志共用，不改动业务响应原文。

<!-- backend-team:task id=T-21 slice=S-4 requirements=AC-009 owner=developer risk=standard layer=domain files=src/customers/domain/changelog.ts evidence=customer-change-log-test depends=T-20 -->
- [ ] T-21 实现 ChangeLog 值对象：field 白名单枚举、先掩码后落值的 old/new、changed_by/changed_at/request_id。

<!-- backend-team:task id=T-22 slice=S-4 requirements=AC-007 owner=developer risk=standard layer=domain files=src/customers/application/get-customer.ts evidence=customer-update-test depends=T-21 -->
- [ ] T-22 实现按编号读取用例：不存在抛 CustomerNotFound；返回完整档案 + 脱敏 recentChanges + 作为 ETag 基的 version。

<!-- backend-team:task id=T-23 slice=S-4 requirements=AC-007 owner=developer risk=standard layer=contract files=src/customers/api/customer-detail.ts evidence=customer-update-test depends=T-05,T-22 -->
- [ ] T-23 实现 GET /api/v1/customers/{customerId}：200 响应含 recentChanges 与 ETag(=version)；编号不存在返回 404 NotFound。

<!-- backend-team:task id=T-24 slice=S-4 requirements=AC-006,AC-008 owner=developer risk=high layer=domain files=src/customers/application/update-customer.ts evidence=customer-update-test depends=T-21,T-23 -->
- [ ] T-24 实现 patchUpdate 用例：加载（不存在→CustomerNotFound）→领域校验→If-Match/expectedVersion 比较（不符→VersionConflict、不落库）→仅更新提交字段（customerId/createdAt/createdBy 只读）→version+1→同事务逐字段写脱敏留痕（共享 request_id），全提交或全回滚。

<!-- backend-team:task id=T-25 slice=S-4 requirements=AC-006,AC-007,AC-008 owner=developer risk=high layer=contract files=src/customers/api/update-customer.ts evidence=customer-update-test depends=T-10,T-24 -->
- [ ] T-25 实现 PATCH /api/v1/customers/{customerId}：If-Match 缺失/非法→412；成功→200+新 ETag；不存在→404；版本不符→409 CUSTOMER_VERSION_CONFLICT（提示刷新重试、不静默覆盖）；改后电话占用→409 CUSTOMER_PHONE_TAKEN；字段错误→422。

<!-- backend-team:task id=T-26 slice=S-4 requirements=AC-003 owner=developer risk=high layer=persistence files=src/customers/persistence/drizzle-customer-command.ts evidence=customer-phone-uniqueness-test depends=T-08,T-13 -->
- [ ] T-26 命令侧仓储写入路径（plan §3 T3）：单事务 INSERT crm.customer（version=1，编号/created_at/created_by 由服务端赋值）；捕获 SQLSTATE 23505→抛 PhoneTaken（查回已存在客户名称摘要）并整体回滚，不产生半记录；customer_id/created_at/created_by 永不进入 UPDATE 语句。真库唯一索引兜底由 T-12/T-13 与主机验证。

<!-- backend-team:task id=T-27 slice=S-4 requirements=AC-006,AC-008 owner=developer risk=high layer=persistence files=src/customers/persistence/drizzle-customer-command.ts evidence=customer-update-test depends=T-21,T-26 -->
- [ ] T-27 命令侧仓储更新路径：`UPDATE crm.customer SET <提交字段>, version=version+1, updated_by=$u, updated_at=now() WHERE customer_id=$1 AND version=$2`；影响 0 行按编号存在性返回 CustomerNotFound 或 VersionConflict；成功则同事务逐字段 INSERT 脱敏留痕（共享 request_id），全部提交或全部回滚（D-06/D-12）。

<!-- backend-team:task id=T-28 slice=S-4 requirements=AC-006,AC-007,AC-008 owner=developer risk=standard layer=test files=test/customer-update.test.mjs evidence=customer-update-test depends=T-19,T-25,T-27 -->
- [ ] T-28 编写并运行 `node --test test/customer-update.test.mjs`：局部更新只改提交字段、version 自增 1、详情与检索返回新值；不存在编号报“客户不存在”；过期版本保存被拒且新旧提交字段原值均不变。

<!-- backend-team:task id=T-29 slice=S-5 requirements=AC-009 owner=developer risk=standard layer=domain files=src/customers/application/list-changes.ts evidence=customer-change-log-test depends=T-24 -->
- [ ] T-29 实现 listChanges 用例：按客户读取留痕、changed_at 倒序分页并返回 total。

<!-- backend-team:task id=T-30 slice=S-5 requirements=AC-009 owner=developer risk=standard layer=contract files=src/customers/api/customer-changes.ts evidence=customer-change-log-test depends=T-29 -->
- [ ] T-30 实现 GET /api/v1/customers/{customerId}/changes：CustomerChangePage，前后值均为脱敏形态；编号不存在 404。

<!-- backend-team:task id=T-31 slice=S-5 requirements=AC-009 owner=developer risk=high layer=persistence files=migrations/003-customer-change-log.sql evidence=customer-change-log-test depends=T-12 -->
- [ ] T-31 编写迁移 003：customer_change_log 表、FK ON DELETE RESTRICT、ix_changelog_customer_time、field 白名单 CHECK；附逆序回滚。真库执行由主机完成。

<!-- backend-team:task id=T-32 slice=S-5 requirements=AC-009 owner=developer risk=high layer=persistence files=migrations/004-grants.sql evidence=customer-change-log-test depends=T-31 -->
- [ ] T-32 编写迁移 004：应用账号最小权限（change_log 仅 INSERT+SELECT，customers 按需读写）；附回滚。真库列权限断言由主机完成。

<!-- backend-team:task id=T-33 slice=S-5 requirements=AC-009 owner=developer risk=standard layer=persistence files=src/customers/persistence/drizzle-changelog-repository.ts evidence=customer-change-log-test depends=T-13,T-21,T-32 -->
- [ ] T-33 变更历史仓储：按 customer_id 以 ix_changelog_customer_time 倒序分页读取 + count(total)，field 白名单映射为契约 camelCase；写入侧仅 INSERT 且复用 T-27 事务句柄。外键 RESTRICT 与列权限由主机真库断言。

<!-- backend-team:task id=T-34 slice=S-5 requirements=AC-009 owner=developer risk=standard layer=test files=test/customer-change-log.test.mjs evidence=customer-change-log-test depends=T-28,T-30,T-33 -->
- [ ] T-34 编写并运行 `node --test test/customer-change-log.test.mjs`：一次修改 3 字段产生 3 行留痕（field/changed_by/changed_at/前后值，同 request_id）；phone/email 前后值匹配脱敏形态，历史与日志无明文。

<!-- backend-team:task id=T-35 slice=S-6 requirements=AC-010 owner=developer risk=high layer=domain files=src/customers/identity/principal.ts evidence=customer-authz-test depends=T-04 -->
- [ ] T-35 实现 Principal{userId,displayName,teamId,permissions}（architecture 口径）与既有会话的 identity-adapter 判定：人员目录不可达时 fail-closed（D-14 读码确认），不引入新账号体系。

<!-- backend-team:task id=T-36 slice=S-6 requirements=AC-010 owner=developer risk=high layer=contract files=src/customers/api/auth.ts evidence=customer-authz-test depends=T-05,T-17,T-23,T-30,T-35 -->
- [ ] T-36 对全部 5 个端点施加 customer:read/customer:write 守卫：无会话 401、无权限 403；“不存在编号”与“无权访问编号”返回同一语义响应，不泄露存在性差异。

<!-- backend-team:task id=T-37 slice=S-6 requirements=AC-010 owner=developer risk=standard layer=test files=test/customer-authz.test.mjs evidence=customer-authz-test depends=T-36 -->
- [ ] T-37 编写并运行 `node --test test/customer-authz.test.mjs`：缺 Principal 时列表/详情/写返回 401；缺 read/write 权限返回 403；不存在与无权访问响应语义一致。

<!-- backend-team:task id=T-38 slice=S-7 requirements=AC-009 owner=developer risk=low layer=persistence files=src/customers/support/telemetry.ts evidence=customer-change-log-test depends=T-20,T-36 -->
- [ ] T-38 实现结构化日志字段白名单（requestId/userId/teamId/operation/customerId/result/errorCode/latencyMs）：phone/email/note 与检索关键词参数不入日志与 SQL 打点（明文排除由 T-34 断言）；输出 409/422 比例与写事务回滚计数（阈值告警属主机运行期）。

## 执行顺序与并行

- 关键链：S-1（T-01→T-06）→ S-2（T-07→T-14）→ S-3（T-15→T-19）→ S-4（T-20→T-28）→ S-5（T-29→T-34）→ S-6（T-35→T-37）→ S-7（T-38）。全部前置关系记录在任务元数据 depends 中，且仅指向更早编号，图无环（切片间亦然）。
- 可并行：T-07、T-11、T-20 无前置；T-11/T-12/T-13 与 S-1 测试并行；T-31/T-32 与 S-4 编码任务并行。复用同一文件的任务（内存仓储、创建用例与路由、命令侧仓储）已用 depends 串行化。
- MVP 建议：先交付 S-1+S-2（创建可用且防重复），再 S-3（查询），再 S-4+S-5（修改与历史）；S-6 授权须在暴露给真实用户前完成。真库适配任务（T-13/T-18/T-26/T-27/T-33）随所属切片一同交付，否则模块无法在 PostgreSQL 上运行。

## 主机延后项（非本计划任务）

<!-- backend-team:host-evidence id=workspace-boundary kind=workspace-boundary requirements=AC-001,AC-002,AC-003,AC-004,AC-005,AC-006,AC-007,AC-008,AC-009,AC-010 -->
- workspace-boundary：主机快照比对，证明仅新增本计划各任务声明的文件，既有源码与测试未被改写。
- 迁移 001–004 与 PostgreSQL 适配仓储在真实库上的应用、phone_key 生成列与唯一索引生效、外键 RESTRICT 与列权限、逆序回滚：测试运行器不允许子进程、无实时数据库、无构建工具，故不由任何 node-test 声称覆盖。
- 仓库既有编译与自动化校验脚本的执行，以及 AC-001–AC-010 的最终端到端验证，由主机在本计划全部任务完成后自动执行；test-plan.md 未启用固定作用域类型门，本计划不声明该门。
