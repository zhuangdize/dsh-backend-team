# 客户管理 数据模型测试计划

自动化用例由 Node 内置测试器（宿主 Node 24.19.0）以 `node --test <显式文件路径>` 运行，不使用目录操作数。仓储与并发类断言针对实现阶段提供的内存假仓储（与 `data-model.md` 声明的 `phone_key` 唯一索引、版本条件更新语义一致）执行；真实 PostgreSQL 上的 DDL、生成列、唯一索引、外键 RESTRICT 与列权限行为无法由测试运行器覆盖（不允许子进程、无实时数据库、无构建工具），由主机在本角色之后执行（见 Status）。本角色无命令执行与测试代码写入能力，下列用例均为设计态。

## Requirement ID

| AC | 证据 id | 测试文件 |
| --- | --- | --- |
| AC-001, AC-002 | customer-model-test | test/customer-model.test.mjs |
| AC-003 | customer-phone-uniqueness-test | test/customer-phone-uniqueness.test.mjs |
| AC-004, AC-005 | customer-search-test | test/customer-search.test.mjs |
| AC-006, AC-007, AC-008 | customer-update-test | test/customer-update.test.mjs |
| AC-009 | customer-change-log-test | test/customer-change-log.test.mjs |
| AC-010 | customer-authz-test | test/customer-authz.test.mjs |
| AC-001…AC-010（文件边界） | workspace-boundary | 主机快照比对，无测试文件 |

## Evidence Type

- `node-test`：单元/契约级断言，不依赖外部网络与真实数据库；如需 HTTP 仅使用 loopback。
- `host-evidence`（`kind=workspace-boundary`）：比对当前工作区与开发前快照，证明既有源码与测试未被改写、无计划外新文件；只证明文件保留，不证明运行时行为。
- 主机迁移运行：迁移 001–004 在真实数据库上的应用、索引生效与逆序回滚断言。
- 类型/构建门（本计划未启用 `backend-team:typecheck` 标记）：`src/customers/**` 的 TypeScript 依赖 `drizzle-orm`、既有 HTTP 框架与仓库路径设置，而固定作用域 typecheck 采用 strict/ES2022/ESNext/bundler 与内置 Node 类型，不读取项目 tsconfig、不安装依赖、也不等于完整构建，故不适用本设计。改由仓库既有 typecheck/build 脚本作为实现阶段最终门；宿主只读检查显示这些脚本状态为未验证，未运行前不得声称通过。

## Command or Scenario

<!-- backend-team:evidence id=customer-model-test file=test/customer-model.test.mjs requirements=AC-001,AC-002 -->
`node --test test/customer-model.test.mjs`：仅提交 `name`+`phone` 即可创建，`customerId` 非空且匹配契约正则、`version` 为 1、客户端传入的 customerId 被忽略，创建后同一假仓储可被详情与检索读到；补交可选字段后详情与检索返回同值。`name` 为空串/纯空格/101 字符，`phone` 含字母或短于 6 位，`email` 无 `@` 分别产出对应 field 的错误项（多字段同时非法时逐项列出）；`contactPerson` 缺省不报错（Q1 定稿为可选）。"原输入被保留"属前端行为，接口只保证 fieldErrors 定位到具体字段。

<!-- backend-team:evidence id=customer-phone-uniqueness-test file=test/customer-phone-uniqueness.test.mjs requirements=AC-003 -->
`node --test test/customer-phone-uniqueness.test.mjs`：先创建客户 A，再以归一化后 `phone_key` 相同的号码（`138-0000-5678` 对 `13800005678`）创建 B → 断言错误码 `CUSTOMER_PHONE_TAKEN`、错误摘要含 A 的名称、仓储计数仍为 1（无半记录）。

<!-- backend-team:evidence id=customer-search-test file=test/customer-search.test.mjs requirements=AC-004,AC-005 -->
`node --test test/customer-search.test.mjs`：分别用名称、联系人、电话关键词检索，结果集合等于预期匹配集合并返回一致 `total`；未命中关键词返回空列表而非全量；对 5 条数据以 `pageSize=2` 逐页遍历，各页 id 互不相交且并集等于全量，排序键固定为 `(updated_at desc, customer_id asc)`。

<!-- backend-team:evidence id=customer-update-test file=test/customer-update.test.mjs requirements=AC-006,AC-007,AC-008 -->
`node --test test/customer-update-test.mjs`：非录入人的授权 Principal 局部更新只改提交字段、`version` 自增 1、随后读取与检索均返回新值且操作人为实际修改者；不存在的 customerId 返回"客户不存在"；携带过期 version 的保存被拒绝且各字段原值均未被静默覆盖。

<!-- backend-team:evidence id=customer-change-log-test file=test/customer-change-log.test.mjs requirements=AC-009 -->
`node --test test/customer-change-log.test.mjs`：一次修改 3 个字段产生 3 行留痕，每行含 `changed_by`、`changed_at`、`field` 与前后值且共享同一 `request_id`；`phone`/`email` 前后值匹配脱敏形态，留痕与日志中不出现明文。

<!-- backend-team:evidence id=customer-authz-test file=test/customer-authz.test.mjs requirements=AC-010 -->
`node --test test/customer-authz.test.mjs`：缺少 Principal 时列表、详情、写操作返回 401；Principal 缺少 `customer:read`/`customer:write` 返回 403；同一 Principal 对不同 createdBy 的客户读写结果一致；"不存在编号"与"无权访问编号"的响应不泄露存在性差异。

<!-- backend-team:host-evidence id=workspace-boundary kind=workspace-boundary requirements=AC-001,AC-002,AC-003,AC-004,AC-005,AC-006,AC-007,AC-008,AC-009,AC-010 -->
主机快照比对：仅允许出现本设计与 tasks.md 声明的新增文件，既有源码与测试文件内容保持不变。

## Expected Result

每条 AC 至少一个 `node-test` 通过（退出码 0）；错误结构（`code`、`message`、`requestId`、`fieldErrors`）与 `contracts/openapi.yaml` 定义一致；电话唯一与版本冲突均不产生数据变更；变更历史不出现明文敏感值；workspace-boundary 仅报告计划内新增文件；主机迁移在真实 PostgreSQL 上按 001→004 成功应用并可逆序回滚，且 `uq_customer_phone_key` 与 `phone_key` 生成列实际生效。

## Status

全部 `node-test` 用例：未运行（本角色无命令执行权限，测试文件尚待实现阶段创建）。仓库 typecheck/build 脚本与主机迁移/索引/回滚断言、workspace-boundary 快照比对：未运行，由主机在本角色之后执行。本计划中不存在已通过的测试结果；AC 的通过判定以实现阶段与主机的实际执行输出为准。
