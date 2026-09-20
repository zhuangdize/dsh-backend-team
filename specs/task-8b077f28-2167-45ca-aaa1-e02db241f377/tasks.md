# 人员管理功能 实施任务

路径相对 M0 确认的宿主包目录，仅落在 `src/`、`test/`、`migrations/`；不新增依赖、不改既有文件（沿用 ADR-001～ADR-008）。
测试按 `test-plan.md` 的 Node 证据逐文件执行（`node --test <file>`，进程内 domain + 内存仓储，不连 PostgreSQL）。
Node 24 直跑 TS 的限制：仅可擦除语法（禁 enum/装饰器/参数属性/namespace，枚举用字符串联合 + as const），相对导入带 `.ts` 后缀，不用 path alias。
宿主 deferred：包级 typecheck/build、PG 约束与仅 INSERT grant 实测、`openapi.yaml` 契约一致性、既有模块构建与既有测试套件。

## S-1 建档 F1 与字段范围（AC-001 / AC-009）

<!-- backend-team:task id=T-01 slice=S-1 requirements=AC-001,AC-009 owner=developer risk=standard layer=contract files=src/personnel/contract/dto.ts,src/personnel/contract/errors.ts evidence=personnel-validation -->
- [ ] 按 `contracts/openapi.yaml` 落 PersonCreateRequest / PersonUpdateRequest / ContactInfo / PersonDetail / Assignment / ErrorResponse 的字段白名单与类型，显式排除 idNumber、salary、bankAccount 及常见别名；错误结构含 code、中文 message、fieldErrors、conflictRef。

<!-- backend-team:task id=T-02 slice=S-1 requirements=AC-001 owner=developer risk=standard layer=domain files=src/personnel/domain/validation.ts evidence=personnel-validation depends=T-01 -->
- [ ] 实现入参纯函数校验（必填、长度 1–32/1–64、雇佣类型枚举、日期格式与终止不早于起始、邮箱格式），缺失项逐条输出中文提示，结果为 validation_failed（R6）。

<!-- backend-team:task id=T-03 slice=S-1 requirements=AC-001,AC-009 owner=developer risk=high layer=persistence files=migrations/0001_personnel_person.sql,migrations/0002_personnel_assignment.sql,src/personnel/persistence/schema.ts,src/personnel/domain/store.ts evidence=personnel-validation depends=T-01 -->
- [ ] 建 person（employee_no 唯一、status CHECK、停用原因 CHECK）与 assignment 表的仅向前迁移 M1/M2 及 Drizzle schema（列与 DTO 白名单一一对应、FK ON DELETE RESTRICT），并提供事务可回滚的内存仓储实现供 node 测试使用；EXCLUDE 排他约束按 ADR-003 待 PG 能力确认后追加。

<!-- backend-team:task id=T-04 slice=S-1 requirements=AC-001 owner=developer risk=standard layer=domain files=src/personnel/domain/service.ts evidence=personnel-validation depends=T-02,T-03 -->
- [ ] 实现 createPerson 用例：校验通过后同一事务写入 person 与首条任职区间并置在职，任一步失败整体回滚（F1/R2）。

<!-- backend-team:task id=T-05 slice=S-1 requirements=AC-001,AC-009 owner=developer risk=standard layer=test files=test/personnel-validation.test.mjs evidence=personnel-validation depends=T-01,T-02,T-03,T-04 -->
- [ ] 按 test-plan 的 personnel-validation 场景写测试：逐项与组合缺省 8 个必填字段断言 validation_failed 与中文 fieldErrors；遍历字段清单断言无敏感字段。

## S-2 在册视图与停用 F4（AC-003 / AC-006）

<!-- backend-team:task id=T-06 slice=S-2 requirements=AC-006 owner=developer risk=standard layer=domain files=src/personnel/domain/status.ts evidence=personnel-roster depends=T-03,T-04 -->
- [ ] 实现 R2 单向状态机与停用 F4：仅 草稿→在职→停用，停用需原因与生效日期，档案与历史保留，非法流转返回 invalid_status_transition。

<!-- backend-team:task id=T-07 slice=S-2 requirements=AC-003,AC-006 owner=developer risk=standard layer=domain files=src/personnel/domain/roster.ts evidence=personnel-roster depends=T-03,T-06 -->
- [ ] 实现默认在册视图（在职且处于生效区间）、姓名/工号/部门/状态筛选与分页，以及可指派候选集查询（停用者不进入）。

<!-- backend-team:task id=T-08 slice=S-2 requirements=AC-003,AC-006 owner=developer risk=standard layer=test files=test/personnel-roster.test.mjs evidence=personnel-roster depends=T-04,T-06,T-07 -->
- [ ] 按 personnel-roster 场景写测试：建档后默认在册立即命中且分页/筛选正确；停用后不在默认在册与可指派集合，但显式 status=inactive、历史与业务关联仍可读。

## S-3 工号唯一与不复用（AC-002）

<!-- backend-team:task id=T-09 slice=S-3 requirements=AC-002 owner=developer risk=standard layer=domain files=src/personnel/domain/employee-no.ts,src/personnel/domain/service.ts evidence=personnel-employee-no depends=T-04,T-06 -->
- [ ] 实现 employee_no 全表唯一且停用后不复用的守护并接入 createPerson，冲突返回 duplicate_employee_no 与 conflictRef=被占用工号（R1）。

<!-- backend-team:task id=T-10 slice=S-3 requirements=AC-002 owner=developer risk=standard layer=test files=test/personnel-employee-no.test.mjs evidence=personnel-employee-no depends=T-09 -->
- [ ] 按 personnel-employee-no 场景写测试：同 employee_no 重复建档被拒且 conflictRef 命中；首条停用后重复建档仍被拒。

## S-4 在职变更与调岗 F3（AC-004 / AC-005）

<!-- backend-team:task id=T-11 slice=S-4 requirements=AC-005 owner=developer risk=standard layer=domain files=src/personnel/domain/assignment.ts evidence=personnel-assignment depends=T-06,T-07 -->
- [ ] 实现任职区间不重叠校验（返回 overlapping_assignment 与 conflictRef=冲突区间 id，R3）与汇报关系校验（禁自引用、上级须在可指派集合、汇报链无环，返回 invalid_report_line，R4）。

<!-- backend-team:task id=T-12 slice=S-4 requirements=AC-004 owner=developer risk=standard layer=domain files=src/personnel/domain/service.ts evidence=personnel-assignment depends=T-09,T-11 -->
- [ ] 实现 changeAssignment / retractAssignment 用例：按生效日期登记 pending 区间，生效时关闭旧区间并写部门、岗位、汇报的前后值变更，撤销仅对 pending 开放（F3/R3、AC-004）。

<!-- backend-team:task id=T-13 slice=S-4 requirements=AC-004,AC-005 owner=developer risk=standard layer=test files=test/personnel-assignment.test.mjs evidence=personnel-assignment depends=T-12 -->
- [ ] 按 personnel-assignment 场景写测试：未来生效调岗推进后详情为新组织岗位、旧区间 closed、变更含前后值与生效期间；[2026-01-01,2026-03-31] 与 [2026-03-15,2026-04-30] 冲突被拒；自引用与 A→B→A 被拒。

## S-5 历史、审计与受限删除（AC-007 / AC-010）

<!-- backend-team:task id=T-14 slice=S-5 requirements=AC-007,AC-010 owner=developer risk=standard layer=domain files=src/personnel/domain/lifecycle.ts evidence=personnel-lifecycle depends=T-12 -->
- [ ] 实现受限删除守护（业务引用为真时抛 referenced_by_business 且档案仍在，无引用且授权才删除，R2/AC-007）与按人员倒序分页的字段级历史查询（含生效期间，F5/AC-010）；引用判定以可注入端口表达，真实引用源随 M0 前置确认 3 接入。

<!-- backend-team:task id=T-15 slice=S-5 requirements=AC-007,AC-010 owner=developer risk=high layer=persistence files=migrations/0003_personnel_change_record.sql,src/personnel/persistence/schema.ts,src/personnel/persistence/store.ts evidence=personnel-lifecycle depends=T-03,T-14 -->
- [ ] 落 change_record 追加写迁移 M3 与 Drizzle 仓储实现：与业务写在同一事务、无更新/删除路径、删除依赖 FK RESTRICT 兜底；仅 INSERT 的账号 grant 作为迁移内待宿主实测项。

<!-- backend-team:task id=T-16 slice=S-5 requirements=AC-007,AC-010 owner=developer risk=standard layer=test files=test/personnel-lifecycle.test.mjs evidence=personnel-lifecycle depends=T-14,T-15 -->
- [ ] 按 personnel-lifecycle 场景写测试：引用为真时删除失败且档案仍在、无引用且授权时成功；新增/变更/停用各一次可按人员查到 action、field_name、old/new、operator_id、occurred_at 与生效期间；状态机拒绝 draft→inactive 与 inactive→active。

## S-6 服务端授权与状态映射（AC-008）

<!-- backend-team:task id=T-17 slice=S-6 requirements=AC-008 owner=developer risk=standard layer=contract files=src/personnel/api/access.ts evidence=personnel-access depends=T-06,T-12,T-14 -->
- [ ] 实现服务端角色门禁与响应整形：非 HR 的集合查询与写操作返回 forbidden 且不含任何人员数据；人员维度资源返回 not_found，并与「记录不存在」深度同构（同码同结构），不泄露存在性。

<!-- backend-team:task id=T-18 slice=S-6 requirements=AC-008 owner=developer risk=high layer=contract files=src/personnel/api/routes.ts evidence=personnel-access depends=T-04,T-12,T-14,T-15,T-17 -->
- [ ] 实现契约中 7 个操作对应的框架无关处理器（入站请求→用例→HTTP 状态映射 400/401/403/404/409/200/201/204），全部写路径经门禁且不依赖界面隐藏；挂载到宿主路由的适配留在 M0 前置确认 1 收口。

<!-- backend-team:task id=T-19 slice=S-6 requirements=AC-008 owner=developer risk=standard layer=test files=test/personnel-access.test.mjs evidence=personnel-access depends=T-17,T-18 -->
- [ ] 按 personnel-access 场景写测试：以非 HR 身份遍历集合查询、详情、各类写操作，断言 forbidden/not_found 分类与响应体不含人员数据，且无权与不存在的响应深度相等。

## S-7 交付足迹保全（AC-011）

<!-- backend-team:task id=T-20 slice=S-7 requirements=AC-011 owner=developer risk=high layer=contract files=migrations/0001_personnel_person.sql,migrations/0002_personnel_assignment.sql,migrations/0003_personnel_change_record.sql,test/personnel-validation.test.mjs,test/personnel-employee-no.test.mjs,test/personnel-roster.test.mjs,test/personnel-assignment.test.mjs,test/personnel-lifecycle.test.mjs,test/personnel-access.test.mjs evidence=workspace-boundary depends=T-05,T-08,T-10,T-13,T-16,T-19 -->
- [ ] 交付前核对足迹：新增文件仅限 `src/personnel/`、`test/`、`migrations/` 计划内路径，既有源码/测试/迁移与 package.json、lockfile 未被改动；三张表全部为新建、不动既有 schema 与数据，越界改动一律回退。

## 依赖与并行

S-1 → S-2 → S-3/S-4 → S-5 → S-6 → S-7；每条前置关系已写入对应任务的 depends（均指向前序任务，无环）。
可并行：T-02 与 T-03；T-07 与 T-09；T-15 与 T-17；T-05、T-08、T-10、T-13、T-16、T-19 六份测试文件互不依赖。
共用同一文件的任务按序执行：service.ts（T-04→T-09→T-12）、persistence/schema.ts（T-03→T-15）。
建议 MVP：S-1 + S-2（AC-001、AC-003、AC-006、AC-009 可用），其后按 S-3→S-4→S-5→S-6 增量交付。

## 契约核对（按批准原文实现，不静默改写）

- `not_yet_retractable` 错误码名与 test-plan「仅 pending 可撤销」语义相反：保留契约码名，实现为「变更已生效不可撤销」时返回，验收说明需写明。
- AC-006 的「可指派选择」在 `openapi.yaml` 无对应端点：按内部候选集查询实现并供汇报关系校验使用，不新增公开接口。
- `servers: /api/personnel` 的挂载点、HR 身份来源、业务引用源属 plan.md 三项前置确认，未收口前 T-15/T-18 不假设具体框架与真实引用表。
