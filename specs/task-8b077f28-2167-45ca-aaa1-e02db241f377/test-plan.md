# 人员管理功能 测试计划

AC-001–AC-011 全部绑定证据。Node 测试以 `node --test <单文件>` 执行（不传目录或 glob）；路径相对于 personnel 模块所在的宿主包目录（M0 确认包归属后本计划路径不再变动，planner 须原样保留证据 id 与文件路径）。受限运行器无子进程/Git/实库能力：node-test 仅测进程内 domain 规则与内存 repository 语义。

## Requirement ID
| AC | Evidence ID | 类型 |
|---|---|---|
| AC-001, AC-009 | personnel-validation | node-test |
| AC-002 | personnel-employee-no | node-test |
| AC-003, AC-006 | personnel-roster | node-test |
| AC-004, AC-005 | personnel-assignment | node-test |
| AC-007, AC-010 | personnel-lifecycle | node-test |
| AC-008 | personnel-access | node-test |
| AC-011 | workspace-boundary | host-evidence |

## Evidence Type
- **node-test**：纯 domain 单测 + 内存 repository（不连 PostgreSQL），由计划内 `node --test` 自动执行。
- **host-evidence**：宿主将当前工作区与开发前快照比对（含开发前本地修改），仅证明既有文件保全与无计划外新文件，不证明运行时行为。
- **deferred（限制记录）**：PostgreSQL fixture 中的约束实测（唯一/EXCLUDE/仅追加 grant）、经真实挂载路由与会话的全栈接口行为、openapi.yaml 契约一致性、包级 typecheck/build 与既有自动化测试套件——均在批准后由宿主执行并另行记录，不由上述单测冒充。

## Command or Scenario
### personnel-validation
<!-- backend-team:evidence id=personnel-validation file=test/personnel-validation.test.mjs requirements=AC-001,AC-009 -->
`node --test test/personnel-validation.test.mjs`：对建档入参逐项与组合缺省 employeeNo/fullName/employmentType/employmentStartDate/departmentId/departmentName/positionName/effectiveFrom，断言结果为 validation_failed、fieldErrors 逐一列出缺失字段、消息为可理解中文（AC-001）。遍历 PersonCreateRequest / PersonUpdateRequest / PersonDetail / Assignment 的字段定义清单，断言不含 idNumber、salary、bankAccount 及常见别名（AC-009）。

### personnel-employee-no
<!-- backend-team:evidence id=personnel-employee-no file=test/personnel-employee-no.test.mjs requirements=AC-002 -->
`node --test test/personnel-employee-no.test.mjs`：对已建人员再次以同 employee_no 建档，断言被拒、错误码 duplicate_employee_no 且 conflictRef 等于被占用工号（AC-002）；将首条置停用后重复建档仍被拒（R1 停用后不复用）。

### personnel-roster
<!-- backend-team:evidence id=personnel-roster file=test/personnel-roster.test.mjs requirements=AC-003,AC-006 -->
`node --test test/personnel-roster.test.mjs`：完成 F1（含任职区间）后，断言默认在册视图立即含该人员，按姓名/工号/部门/状态筛选与分页命中（AC-003）；停用后断言其不出现在默认在册视图与可指派候选集，但显式 status=inactive 查询、其历史与既有业务记录关联仍可读（AC-006，引用判定以内存桩表达）。

### personnel-assignment
<!-- backend-team:evidence id=personnel-assignment file=test/personnel-assignment.test.mjs requirements=AC-004,AC-005 -->
`node --test test/personnel-assignment.test.mjs`：提交未来生效的调岗并推进生效，断言详情显示新组织与岗位、旧区间 closed、change_record 含部门/岗位前后值与生效期间（AC-004）；在既有区间 [2026-01-01, 2026-03-31] 上提交重叠的 [2026-03-15, 2026-04-30]，断言被拒 overlapping_assignment 且 conflictRef 指向冲突区间 id（AC-005）。附加：仅 pending 可撤销；自引用与 A→B→A 汇报环被 invalid_report_line 拒绝（R3/R4 支撑项）。

### personnel-lifecycle
<!-- backend-team:evidence id=personnel-lifecycle file=test/personnel-lifecycle.test.mjs requirements=AC-007,AC-010 -->
`node --test test/personnel-lifecycle.test.mjs`：业务引用判定为真时删除抛 referenced_by_business 且档案仍在（AC-007 守护逻辑；真实引用源属 M0 待确认项）；无引用且授权时删除成功。对新增/变更/停用各执行一次，按人员维度断言可查到 action、field_name、old/new 值、operator_id、occurred_at，任职/停用类含生效期间（AC-010）；状态机拒绝 draft→inactive 与 inactive→active（R2 支撑项）。

### personnel-access
<!-- backend-team:evidence id=personnel-access file=test/personnel-access.test.mjs requirements=AC-008 -->
`node --test test/personnel-access.test.mjs`：以非 HR 身份走授权判定与响应整形函数：集合查询与全部写操作得 forbidden 且响应体不含任何人员数据；人员维度资源得 not_found，且该响应与「记录确实不存在」的响应深度相等（同码同构），不泄露存在性（AC-008）。经挂载路由与真实会话的端到端越权验证属宿主 deferred 项。

### AC-011 保全
<!-- backend-team:host-evidence id=workspace-boundary kind=workspace-boundary requirements=AC-011 -->
宿主比对工作区与开发前快照：既有源码/测试未被破坏、新增文件仅限确认包内 src/、test/、migrations/。包级构建与既有测试套件的执行结果由宿主另行记录；本计划不为其设置 Node 测试，不声称其通过。

## Expected Result
每条 node-test 证据：全部子测试通过，失败输出可定位到 AC 与规则编号（R1–R7）；任一断言失败即对应 AC 未达成。host-evidence：快照差异仅含计划内新文件。deferred 各项须由宿主以各自执行记录独立给出通过/失败结论，不得由本计划的单测结果代偿。

## Status
本计划所有项 **not-run**：本阶段仅产出设计与计划文档，未编写测试代码、未执行任何命令。绑定文件将在实施阶段创建并由宿主以 `node --test` 逐文件执行记录；PostgreSQL 约束实测、全栈授权、契约一致性与既有模块构建（AC-011 其余部分）为待宿主验证项，当前无通过证据。
