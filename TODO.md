# Backend Agent Team 待办清单

更新日期：2026-09-20。此文件是后续开发、验收和进度汇报的唯一状态入口。

依据：[原需求核查](docs/requirements-audit-2026-09-09.md)、用户后续要求及 Stage 06/07 发布事项。首次整理沿用已有实现与验证记录，没有重新验收全部功能。

## 如何推进

- `☑️` / `[x]`：该条明确范围已完成，有对应证据；不代表所在功能全部完成。
- `☐` / `[ ]`：未完成，注明待开发、部分实现、待验收或待核实。
- 延期、替换和排除项单列，延期不勾完成。
- 用户说“继续”时，先读本文件，从下一步开始。优先完成业务主流程及实际阻塞，相关配套归入同一条；不连续增加与主流程无关的局部工具。
- 每轮开始说明任务编号；结束更新该条的实现、验证、证据、剩余问题及“下一步”。仅代码完成时保留未勾选，标为待验收。
- 发现新缺口追加编号；保留历史编号和完成记录。调整优先级说明原因，不静默删项或缩小完成标准。
- 真实业务审批由用户操作；测试使用隔离场景。生产发布、迁移等沿用既有授权规则。

## 下一步

**下一步：T12、T14、T18、T25 已完成；T16 发布审计、T19 矩阵、T20 生产 Bundle 接线与 T21 材料审计已刷新，T21 的 DbGate 运行时已收敛为 PostgreSQL-only 并移除 `xlsx`/Excel 插件路径，官方 npm registry 复核为 0 critical/0 high/8 moderate；双架构本机制品已生成并完成本机执行核对。T21 当前只剩外部签名/attestation、稳定 HTTPS 下载和正式生产 provenance 门禁；T22 的 arm64 干净 Profile 生命周期证据已刷新，但完整生产组合、x64 与签名制品仍未满足前不勾选。T19/T20 的隔离 E2E、Bundle 和本地材料回归已刷新，真实生产组合仍需受保护模型和发布材料。阻塞项的根因、解除顺序和外部输入已写入 [发布阻塞处置方案](docs/operations/release-blockers.md)，后续按该顺序推进；不把 LangGraph spike 依赖并入 Bundle 默认路径。**

**当前任务范围锁（2026-09-14）：本轮开发对象是 Backend Agent Team 本身（`packages/`、宿主编排、任务中心及其验证链路）。`src/customers/` 与 `test/customer-model.test.mjs` 是已生成需求的验收样例，冻结保留；除用户明确要求外不得继续修改，也不能把样例代码测试当作 Agent Team 主流程完成证据。**

**人员管理任务（本会话侧）**：T-03 迁移约束按已确认的仅向前 `migrations/0004_personnel_integrity_indexes.sql` 承载；未改写 `0001/0002`，未修改 `tasks.md`，未执行数据库迁移。T24 已完成运行循环修复；迁移应用仍由 T13/T14 的独立审批门禁控制。

T01 已完成诊断与防误报修复；未启动新的业务开发或审批。按发现的必要依赖推进 T02–T05，随后完成 T06；受用户确认阻塞时记录具体等待点并继续独立配套工作。

**客户管理任务（`9dca7f07-d6da-4096-b41a-ecf4cbc51883`，当前 rev21 / BUILD）**：

- T-01 `src/customers/domain/customer.ts` 与 T-02 `src/customers/persistence/memory-customer-repository.ts` 已在工作区落地；本轮修正 T-02 的 `phone_key` 类型收窄错误。
- T-03 自动 handoff（seq65）在 2026-09-14 11:08 因 `Agent result failed` 结束，文件仍是旧的自包含重复实现，未作为完成接受；宿主显示功能开发“受阻待处理”。
- 已直接重写 T-03 `src/customers/application/create-customer.ts`：只调用 T-01 `Customer.create`，把快照映射为 T-02 `CustomerInsertInput`，校验失败在仓储调用前抛出 422 字段错误，仓储异常原样上抛；没有修改 `tasks.md`、迁移、真实数据库或发布。
- T-04 `src/customers/api/app.ts` 与 T-05 `src/customers/api/create-customer.ts` 已在工作区落地；新增 `src/customers/api/module.ts` 显式装配同一仓储、身份和时钟到五个端点，避免未注入 useCase 时默认返回 500；客户源文件均通过 NodeNext strict 类型检查。
- 已直接补齐 T-06 `test/customer-model.test.mjs`：由 Node 24 `node:test` 执行当前领域、仓储、用例、loopback HTTP 与 POST 端点场景；本轮 39/39 测试通过，覆盖合法创建、客户端编号忽略、多字段错误、失败不落库、201+Location、422 fieldErrors、显式模块装配后的五端点连续调用，以及 T-07～T-30 已实现的电话唯一、查询分页、脱敏留痕、详情、更新并发和历史读取。
- 宿主 seq68 在 11:30 因 Agent result failed 收口，未留下官方切片账本；未接受其失败为业务代码失败。已将真实测试证据发送给宿主，请其只核对并收口 T-03～T-06，不重复写码。
- 宿主 seq69 在 11:56 因 declared budget exhausted（1,350,337 > 1,000,000）阻塞，seq71 随即续跑；因无新的切片证据且持续消耗，已通过 Chrome 停止无进展回合。工作区代码和测试保留，未修改 `tasks.md`。
- T-07 `src/customers/domain/phone-key.ts` 已直接落地：实现与 data-model 的 STORED 表达式一致，去除空格/括号/连字符/点并保留数字与 `+`；回归覆盖 4 个代表场景，官方 `customer-phone-uniqueness-test` 账本尚未生成，T-07 暂记待宿主接纳。
- T-08 在 `MemoryCustomerRepository.insert` 增加电话归一化键唯一守卫，冲突抛出 `PhoneTakenError` 并携带已有客户名称摘要，确认记录数不变；T-09 创建用例原样上抛该异常；T-10 创建路由映射为 409 `CUSTOMER_PHONE_TAKEN` 并返回 `details.existingCustomer`。四条回归均由同一 Node24 测试文件覆盖，官方切片账本尚未生成，暂记待宿主接纳。
- T-15～T-17/T-19 已补齐查询链路：内存仓储按名称/联系人大小写不敏感匹配、电话归一化包含匹配并按 `updated_at DESC, customer_id ASC` 稳定分页；`searchCustomers` 校验关键词/page/pageSize 并返回 `CustomerPage`；GET 路由返回 200 空列表或 400 参数错误。回归已加入 `test/customer-model.test.mjs`，当前总计 38/38 通过；未接入 PostgreSQL 查询仓储，官方 `customer-search-test` 账本尚未生成，暂记待宿主接纳。
- T-20/T-21 已补齐 `src/customers/support/redaction.ts` 与 `src/customers/domain/changelog.ts`：电话/邮箱在留痕构造时脱敏，字段白名单、变更人、时间和 requestId 均校验；业务响应值不改写。
- T-22/T-23 已补齐详情读取与 GET 路由：按编号返回完整档案和最近变更，缺失编号返回 404 `CUSTOMER_NOT_FOUND`，成功响应携带与 version 对应的 ETag。回归总计 38/38 通过；未接入真实变更表或 PostgreSQL，官方 `customer-update-test` 账本尚未生成，暂记待宿主接纳。
- T-24/T-25 已补齐内存更新用例与 PATCH 路由：复用领域 `attemptUpdate/withAppliedUpdate`，强制 If-Match，版本冲突/电话冲突/字段错误分别映射为 409/422；内存更新与脱敏 ChangeLog 组合写入，成功返回新版本 ETag。回归总计 38/38 通过；PostgreSQL 命令仓储及真实事务仍待 T-26/T-27，官方 `customer-update-test` 账本尚未生成，暂记待宿主接纳。
- T-29/T-30 已补齐变更历史读取用例与 GET 路由：按客户编号分页、返回 total 和已脱敏前后值，不存在客户返回 404，非法分页返回 400。回归文件当前 39/39 通过；PostgreSQL 变更历史仓储仍待 T-33，官方 `customer-change-log-test` 账本尚未生成，暂记待宿主接纳。
- 本轮补齐 `src/customers/api/module.ts` 的显式装配：同一 loopback 应用已连续验证 POST 创建、GET 查询、PATCH 更新、GET 详情和 GET 变更历史；默认无 useCase 的应用仍保留 500 缺口特征用例，提醒生产入口必须调用该装配函数。
- 已修复的调度器依赖可见性补丁、回归测试、development 类型检查、Bundle 构建/打包及本地 web Profile 升级均已通过；真实宿主任务状态仍显示 BUILD/受阻待处理，等待本轮证据被宿主账本接纳。

## 一、优先完成：用户主流程

- [x] **T01 ☑️ 当前主流程诊断｜已完成诊断与防误报修复，业务任务仍待恢复｜R07/R12/R14**
  - 真实会话证据：`session-fe8cb0cf-0b03-490e-ac63-d5bdd5fd8d83` 中，用户在 `q-crm-task` 明确选择“搁置旧任务，单开跟进新任务”（工具结果 seq 1736），但同一处置结果 seq 1802 返回 `status: adopted`；随后任务注册表把客户管理任务绑定到客户跟进会话（`.backend-team/conversation-tasks.json`），客户跟进新任务因此无法独立创建。该历史 Bundle 的任务处置实现已不能作为当前生产代码依据。
  - 当前任务的第二个阻塞已最小复现：任务基线 `.backend-team/task-evidence/9dca7f07-d6da-4096-b41a-ecf4cbc51883-baseline.json` 只记录 `src、test`，批准的 `tasks.md` 却声明 `migrations/`；当前配置允许 `src、test、migrations`，恢复时因此不能用旧基线证明迁移目录的修改前状态。Node 20 运行边界测试只会得到 `--permission` 不支持的环境噪声，使用工作区 Node 24.19.0 后该诊断场景稳定通过。
  - 本轮实现：`resolve-task` 现在核对服务返回的 `shelved/adopted` 与聊天中的明确选择，状态不一致时停止并要求重新查询，不再把错误结果报告成成功；工作区边界错误现在指出“已记录目录”和“当前配置允许目录”，并通过正式开发入口传入配置目录。
  - 验证：`packages/bundle/test/conversation-tools.test.ts` 新增错误处置回归；`packages/bundle/test/workspace-boundary-evidence.test.ts` 覆盖基线目录漂移；相关 4 个测试文件共 39 项通过。Bundle 类型检查、构建、相关 ESLint 通过。真实 Chrome 的 DSH `http://127.0.0.1:3080/` 可加载，`travel` 工作区和 Qwen3.8 Flash 可见；当前会话列表只暴露“新会话”，未再次触发真实任务切换或审批。
  - 仍未完成：历史真实任务已保留，未代用户搁置、接回、批准或补造旧基线；旧 Bundle 的历史误绑定需要在真实宿主升级到当前 Bundle 后重新走一次任务冲突确认。当前 Chrome 未暴露历史会话，故不能据此声称真实切换回归已完成。队列/运行中安全暂停归入 T02，需求变更后的真实重新交付归入 T03，完整客户跟进主流程归入 T06。
- [x] **T02 ☑️ 任务冲突与排队｜实现与真实宿主验收完成｜R02**
  - 任务冲突仍要求聊天明确接回或搁置；开发运行存在 `pauseAndWait` 时，暂停入口等待当前切片、最终验证和运行租约释放，再允许重新确认处置。
  - 工作区被占用时，新需求以 `queuedAt` 写入会话任务注册表，去重同会话同需求；排队期间不创建任务状态、审批或 Agent。旧任务由聊天明确搁置后，同一会话最早的排队任务才自动衔接；若衔接过程在写注册表前失败，仍保留排队记录。
  - 隔离测试覆盖明确搁置、队列持久化、重启恢复、排队阶段不创建状态目录、旧任务记录保留及排队任务独立状态；聊天工具和任务中心分别报告并展示“排队中”。
  - 验证：10 个相关测试文件 90 项通过；Bundle、Web 与 spec-workflow 类型检查、相关 ESLint、`git diff --check` 通过；Bundle 构建、打包和本地 web profile 升级通过。真实 Chrome `http://127.0.0.1:3080/` 已复核“旧任务占用→新需求持久排队→用户确认搁置旧任务→排队任务自动衔接”的链路；升级修复后的运行时继续执行该任务后，设计校验通过并进入 `AWAIT_DESIGN_APPROVAL`，页面显示“查看并确认”。
  - 仍未完成：当前实施方案审批由用户本人操作，未代用户确认；确认后进入 T03 的真实需求变更与重新交付验收。
- [x] **T03 ☑️ 需求变更到重新交付｜真实宿主验证通过并进入 DELIVER｜R03/R04/R14**
  - 已实现变更选择、安全暂停、旧证据保存、两道审批重开、检查点归档及恢复。
  - 本轮修复了 `STALE_VIEW` 阻塞：控制面以前只读事件投影 revision，投影落后持久化状态时会错误拒绝继续；现在正式 Bundle 从 durable state store 读取权威 revision，并在关闭时等待正在执行的控制调用排空。
  - 真实宿主已从 VERIFY 恢复至 DELIVER（revision 27）；最终报告 `.backend-team/final-verification-cqAQHW/report.json` 为 `passed`，交付状态为 `ready`，AC-001–AC-011 全部通过且无 unresolved items。Chrome 中已打开团队进度和任务资源，显示功能开发、测试验收已结束，并可查看验收方案及证据绑定。
  - 完成标准已满足：真实宿主完成需求变更后的恢复、测试和交付状态切换；取消、中断、过期回答的隔离回归保留在既有控制/审批测试中；旧任务和基线未被覆盖。DELIVER 阶段当前只提供只读验收结果，没有额外的“交付审批”写操作。真实业务迁移仍未执行，归入 T13/T14。
- [ ] **T04 ☐ 审批来源与记录展示｜部分实现、待核实｜R05/R15**
  - 核查旧任务 09:56 设计审批来源；09:19 需求审批已有对应会话证据。
  - 本轮代码推进：新审批记录增加认证会话、任务 ID和审批时的文档哈希；资源面板展示来源与文档版本摘要；缺少来源的旧记录明确显示“来源未知”，不补造历史信息。
  - 本轮补充回归：审批服务持久化 `sessionId`/`taskId` 与文档哈希；生产控制命令在存在任务上下文时写入任务 ID；相关审批服务、生产命令、视图模型及面板模型 33 项通过。
  - 本轮验收：升级本地 `web` Profile 并重启 DSH 后，真实 Chrome 聊天出现“需求确认 1 / 3”逐题确认卡，Q1–Q3、选项、可选补充说明和“下一题”均可见；卡片明确说明回答不会自动批准方案，未代用户答题或批准。资源面板仍可查看需求与审批记录，历史记录继续显示来源未知及文档哈希摘要。
  - 本轮代码修复：`BackendTeamViewProjector` 收到新的 `approval-recorded` 事件时，现在将该记录投影到 `approvalHistory`，按审批类型替换旧版本，保留认证会话、任务 ID和文档哈希；此前实时事件只清除待审批卡，可能导致资源/进度视图缺少刚完成的审批记录。
  - 本轮隔离验证：Web 事件投影、面板、进度和待审批回归共 20 项通过；Web 类型检查、受影响 ESLint 与 `git diff --check` 通过。未修改客户样例代码，未执行真实审批或迁移。
  - 仍未完成：Q1–Q3 已完成回答，但需求方案仍等待用户本人批准；设计审批及新记录的会话、任务、文档来源最终展示需在批准后再验收。
  - 完成标准：新的批准可追溯到用户操作、会话、任务和文档版本；旧来源无法核实则明确标注未知；资源区正确展示，不补造历史批准。
- [ ] **T05 ☐ 环境预检与可执行恢复｜部分实现｜R12/R14**
  - 已有路径预检、限次规划修正和基线检查；补依赖、环境检查及适用的恢复动作。
  - 本轮代码推进：`backend-team-doctor` 增加项目 manifest/lockfile/node_modules、Node 版本与架构、预算账本、开发检查点、Spec Kit 运行时、状态 revision/审批/运行数量，并给出受状态约束的 `preview-and-confirm`、`continue`、`none` 或 `inspect-state` 建议；发现预算账本存在耗尽记录时，BUILD/VERIFY 不再建议直接 `continue`，改为先核对耗尽维度；仍只读，不自动启动、安装、批准或改写状态。
  - 本轮验收：`backend-team-doctor` 报告 workspace Profile、Node、Bundle、PostgreSQL、DbGate 均可用且无诊断备注；恢复相关 6 个测试文件 21 项通过。重启本地 DSH 后任务数据保留，但人员任务仍为 BUILD/尚未运行，未自动绕过审批或恢复开发运行。
  - 本轮验证：doctor/profile 相关集成 7 项通过；真实工作区报告 Node 24.19.0 arm64、依赖/Spec Kit/PostgreSQL/DbGate 可见，预算账本识别 13 条历史耗尽记录，检查点识别 1 个已通过切片，并改为给出 `inspect-state`（先核对耗尽维度）的建议；原始报告保存在 `.backend-team/artifacts/doctor-t05-budget-guard.json`。
  - 本轮继续开发：诊断脚本改为读取会话任务注册表及 `state-<taskId>`，优先选择唯一未完成任务；同时按该任务读取 `development-<taskId>/checkpoint.json`。旧 workspace-root 状态只作为 legacy 参考；多个未完成任务时强制给出“先处理任务冲突”的 `inspect-state`，避免把旧任务的恢复建议套到当前任务。
  - 本轮验证：doctor 脚本集成 5 项通过；真实工作区现在识别客户管理任务 `9dca7f07-d6da-4096-b41a-ecf4cbc51883`、`AWAIT_REQUIREMENTS_APPROVAL`、revision 9 和 `preview-and-confirm`，不再把 greeting 的 VERIFY/revision 23 当作当前状态；报告保存在 `.backend-team/artifacts/doctor-t05-task-aware.json`，相关 ESLint 与 `git diff --check` 通过。
  - 2026-09-14 逐项复验：使用 Node 24.19.0 运行 `backend-team-doctor`，新报告保存在 `.backend-team/artifacts/doctor-t05-sequential-20260914.json`。报告确认当前活动任务为客户管理任务 `9dca7f07-d6da-4096-b41a-ecf4cbc51883`、`BUILD`/revision 21，工作区共 3 个任务；依赖、Bundle、Spec Kit、PostgreSQL、DbGate 均可见，预算账本为 `blocked`，耗尽维度为 `tokens` 与 `wallMs`，恢复建议为 `inspect-state`。因此未自动重试或改写任务状态，T05 仍待完成可执行恢复闭环。
  - 2026-09-14 `inspect-state` 复核：读取该任务的 durable state、development checkpoint 与预算账本，证实需求/设计审批均带同一会话和任务来源，当前 `runs` 为空，开发 checkpoint 的切片数为 0；预算账本共 57 条记录，其中 16 条为 `blocked:budget-exhausted`，耗尽维度仍为 `tokens`/`wallMs`。明细保存在 `.backend-team/artifacts/inspect-state-t05-20260914.json`；没有可安全续跑的通过切片，未清理或重置账本。
  - 2026-09-16 团队执行阻塞复验：隔离任务 T-05 的真实开发 Agent 返回 `tokens used 1452870 > limit 1000000`，这是累计输入/缓存/输出用量超过单任务上限，不是审批或文件权限冲突。此前调度失败只写入事件日志，宿主重启后开发运行状态退回 `idle`，页面因此错误显示“可以开始”。现已修复：顶层预算错误改为“task budget exhausted”；协调器将调度/校验失败持久化为运行记录和 `workflowError`；宿主启动时恢复最新终态失败，明确显示“已受阻”和原因；显式“恢复任务”会清除旧错误并从已落盘文件继续。相关聚焦回归本轮 Core/Agent Team/Development 4 文件 44 项、Bundle 4 文件 55 项通过，类型检查、构建和 `git diff --check` 通过。真实隔离 Chrome 重启后先看到受阻状态，点击“恢复任务”后进入功能开发；为避免再次消耗长模型回合，随后用“暂停任务”停止了隔离验收，停止原因也已持久化，未把 T-05 后续结果提前记为完成。证据更新至 `.backend-team/artifacts/local-acceptance-agent-team-20260916.json`。
  - 2026-09-16 正式本地宿主复验：发现输入区下方的“团队进度”小卡片在受阻/失败/暂停后只有查看和暂停入口，没有“恢复任务”，用户只能看到阻塞原因而无法从当前对话继续；同时“当前进展”把失败原因放在“正在做”项下，造成状态语义冲突。`packages/web/src/team-progress-card.ts` 现按 BUILD/VERIFY 的运行状态显示互斥的暂停/恢复按钮，阻塞状态使用危险色徽标；`task-progress-model` 将受阻摘要改为“任务已受阻，处理原因后可恢复”，详细原因保留在“当前问题”。3080 重启加载新 Bundle 后，团队进度页显示“已受阻”、预算原因和可用的“恢复任务”按钮。新增 Web 状态回归 4 项通过，Web/Bundle 类型检查、构建、lint 与 `git diff --check` 通过；正式 3080 本轮未点击恢复，避免启动已有长任务。证据同上，视觉记录写入 `design-qa.md`。
  - 2026-09-17 环境门禁修复：新增 `scripts/assert-node24.mjs`，根级 `test/build/typecheck/lint/pack` 在执行前统一拒绝 Node 20 等不兼容运行时，并明确提示项目锁定的 Node 24.19.0 路径；用系统 Node 20 运行会立即失败并给出可执行提示，使用项目 Node 24.19.0 的全量回归 205 个测试文件、1514 项通过、7 项跳过，typecheck、build、lint 和 `git diff --check` 均通过。该项只消除环境误报，不等同于 T05 的恢复闭环完成。
  - 完成标准：Agent 给出并执行实际可用的恢复步骤，不要求用户寻找不存在的面板；恢复不绕过审批、不破坏未提交修改。
- [ ] **T06 ☐ 客户跟进主流程交付｜端到端待完成｜R07**
  - 场景：用户自然描述新增客户、联系记录、下次跟进时间和待跟进视图，由团队梳理需求与设计，明确审批后开发。
  - 2026-09-14 逐项门禁核对：当前真实 workspace 的唯一未完成任务仍是客户管理任务 `9dca7f07-d6da-4096-b41a-ecf4cbc51883`（BUILD/revision 21），预算账本为 `blocked`（`tokens`、`wallMs` 已耗尽），且没有运行记录；因此本轮没有启动新的客户跟进流程，也没有覆盖旧任务或绕过审批。需先完成 T05 的可执行恢复闭环，或在隔离任务中取得真实模型和用户审批后再做 T06 端到端验收。
  - 2026-09-14 真实 Chrome 门禁：任务中心选中该客户管理任务后明确显示“其他会话的任务 · 仅查看”“查看资料不会开始执行”，资源项和“搁置任务/接回当前对话”操作均可见且要求明确确认；当前会话搜索“客户管理”无名称匹配，不能把当前图片验收会话误接为原始业务会话。按钮状态仅做读取，未执行接回或搁置。
  - 完成标准：真实模型与正式宿主完成需求→设计→审批→实现→适用测试→交付；资源可查看、结果可运行、验收项有证据；解决循环调用与人工接管式错误引导。隔离演示不能代替此项。

- [x] **T24 ☑️ 人员管理任务的运行循环缺陷｜预算、超时、检查点和处置状态已修复｜R12/R14**
  - developer 运行每回合恰好在 600s wall-clock 上限处被截断为 failed/blocked（05:01→05:11、05:12→05:22、05:35→05:45、05:50→06:00、06:10→06:17 等），跨窗口进度虽可累积但无法在窗口内完成收尾报告。
  - `budget-ledger.json` 出现 `blocked:budget-exhausted` 但 `consumed` 全 0 的记录，处置结果与数值矛盾，与 T01 类误报同族。
  - 两次 `passed` 运行之后 `development/checkpoint.json` 的 `slices` 仍为空数组，协调器连续把后续回合并列派发回 S-1 收口（重复验证、补 schema.ts 差异注释），T-10（`test/personnel-employee-no.test.mjs`）及之后切片未获派发。
  - `wait` 在运行刚启动/持锁期间误报“没有团队成员在运行”并建议 continue，与“specification operation is already running”互相矛盾；BUILD 阶段 `ask` 返回“当前阶段不能修改方案”。
  - 根因与修复：调度器原来在 `spawnAgent` 返回后才启动墙钟计时，Agent 创建/模型连接卡住时无法超时；现在从调度开始计时并覆盖创建、结果收集，超时取消后写入实际墙钟用量。生产编排端将墙钟超时持久化为 `blocked` 并保留原因和用量；账本保留耗尽维度、禁止同一终态任务重新注册，并为预算预留失败写入可诊断的超额详情。已通过结果仍逐片写入检查点；`wait` 以 durable run 状态和实时调度器计数为准，运行中不返回 `needs-resume`，BUILD 阶段 `ask` 返回明确的 `refine/continue/wait` 指引。
  - 实现范围：`packages/agent-team/src/task-scheduler.ts`、`budget-ledger.ts`、`durable-budget-ledger.ts`；`packages/core/src/production-orchestration-port.ts`；对话等待状态回归见 `packages/bundle/test/conversation-tools.test.ts`；运行循环说明见 `docs/operations/automatic-development.md`。
  - 验证：预算、调度和生产编排回归 3 个文件 41 项通过；开发协调器/检查点/暂停恢复 4 个文件 25 项通过；对话工作流、任务宿主和生产命令 3 个文件 35 项通过；Agent Team、Core、Bundle 类型检查及受影响 ESLint、`git diff --check` 通过。先添加的超时回归在旧实现下按预期失败（账本仍为 ready/0），修复后转绿。全量 Vitest 1438 项通过、6 项跳过；仍有 3 项既有基线失败：`tests/e2e/development-recovery.test.ts` 使用与当前开发者验证 ID 不匹配的旧夹具，`packages/bundle/test/standalone-production.test.ts` 的隔离包缺少外部 React 依赖；未将其归因于本次运行循环修复。当前真实人员任务已有 DELIVER 报告和全切片通过检查点；为避免再次消耗 600 秒，未重复运行整段墙钟任务。
  - 完成标准：预算/墙钟口径一致且耗尽原因可见；passed 运行能推进 checkpoint 切片指针；wait/continue 的处置建议与实际锁状态一致；BUILD 阶段的受限问答有明确指引。历史账本中的旧 `consumed=0` 记录未被伪造重写，新运行会按新格式持久化。

- [x] **T25 ☑️ Codex-like 长任务上下文与恢复机制｜真实 Qwen Agent Team 双进程受限切片验收通过｜R12/R14**
  - 研究文档：[Codex-like 长任务 Agent 方案调研](docs/research/codex-like-long-running-agents-2026-09-16.md)。按与当前 Node.js/TypeScript Agent Team 的相关性筛选了 10 个 GitHub 开源候选，首选 LangGraph.js；其余候选、许可证、机制、适配判断和风险见文档。
  - 当前结论：保留现有 Agent Team、审批来源、预算账本、工作区边界和 evidence ledger；用 LangGraph.js 承担 `thread_id + checkpoint`、人工介入和恢复；`ContextManager` 采用 Cline SDK 的上下文管线语义（完整 transcript 与独立 compaction artifact 分离、prefix hash 校验、agentic + deterministic fallback），再组合工具清理、结构化摘要和可选供应商原生 compaction，不把新框架当作后端 Agent 的替代品。
  - 压缩边界：按 `contextWindow - outputLimit - toolBuffer - margin` 计算触发点，保留需求、决策、审批、最新检查点、验证结果、阻塞项和下一步；原始事件不删除，摘要保存 `sourceEventIds` 和版本。
  - 本轮隔离 spike：新增 `packages/agent-team/src/context-manager.ts` 与对应回归，提供 append-only transcript、独立 compaction artifact、canonical prefix hash、tool-output 清理、agentic/native/deterministic 三路策略、文件 checkpoint、重启恢复、工具幂等状态和压缩失败回滚；新增受控的 `PostgresCheckpointQueryPort`/`PostgresContextCheckpointStore`，由宿主注入已认证连接并按 revision 单调 upsert；普通 OpenAI-compatible provider 能力探测失败时自动走确定性兜底；`ContextBudgetWindow` 将单次模型窗口、压缩预算和任务累计上限分开计账；读取不存在的文件 checkpoint 不会创建目录，压缩 artifact 的 canonical prefix 被篡改时不会复用。`packages/agent-team/test/context-manager.test.ts` 10 项通过，Agent Team 全部 128 项通过；全工作区 typecheck、build、受影响 lint 与 `git diff --check` 通过。
  - 本轮 LangGraph 隔离验证：新增 `spikes/t25-langgraph/` 独立包，锁定 `@langchain/langgraph@1.4.15` 与 `@langchain/langgraph-checkpoint-postgres@1.0.5`，实现 `StateGraph`、`interrupt`/`Command({ resume })`、ContextManager 投影和工具幂等边界；内存回归验证人工介入后工具不重复、原始 transcript 保留、同线程并发压缩只生成一个 artifact；真实本机 PostgreSQL 16.14 通过“压缩 → interrupt → 关闭进程 → 新进程恢复 → resume”链路，工具执行次数保持 1。证据 `.backend-team/artifacts/langgraph-t25-postgres-20260916.json`；spike 自有 `test` 5 项、`typecheck` 与 ESLint 通过，`npm audit --omit=dev` 为 0 high/0 critical（`.backend-team/artifacts/langgraph-t25-dependency-audit-20260916.json`），生产 `agent-team` 未引入 LangGraph 依赖。
  - 宿主映射已记录在研究文档：`taskId → thread_id`；工作区继续由 `OwnershipManager` 跨进程租约保护；`DurableBudgetLedger` 继续掌管任务累计预算，ContextBudgetWindow 只掌管窗口与压缩预算；LangGraph interrupt 只传递待审批值，审批来源/文档哈希/权限仍走现有审批服务。当前未把 PostgreSQL checkpoint 单独当作可恢复授权。
  - 本轮宿主接线边界：新增 `LongTaskExecutionSession`，要求先取得宿主运行锁，再核对 `OwnershipManager` 已持有的读/写范围，之后才加载 ContextManager checkpoint；同一会话操作在进程内串行，工具幂等结果写回 checkpoint，模型/压缩 token 同时计入 `ContextBudgetWindow` 和可选的现有 durable ledger。真实 `FileDevelopmentCheckpointStore` 运行锁、文件 checkpoint 恢复和 durable budget ledger 接线回归共 6 项通过；生产 Bundle 保持显式调用边界。
  - 本轮正式 Agent runtime 接线：`HarnessAgentRuntime` 增加可选 `executionSessionFactory`，在真实 DSH Agent 创建前记录 user prompt 并执行 context preparation，收到真实 assistant/message 后记录 assistant transcript、计入实际模型 token，格式修复与取消路径共用同一会话并最终关闭；上下文准备耗时也计入墙钟预算，过期时不会创建 DSH Agent。没有工厂时行为完全保持原状；Bundle/DSH 仅透传显式工厂，不自行创建 no-op 生产会话。Harness runtime 回归 83/83、Bundle 绑定工厂回归 2/2、Bundle 类型检查和构建通过。
  - 本轮跨进程与依赖审计：新增 spike 子进程 SIGKILL 后运行锁释放/下一进程恢复回归，LangGraph spike 共 5/5；工作区 `npm audit --omit=dev` 复核为 0 info/low/moderate/high/critical，统一升级直接使用的 `yaml` 到 2.9.1，证据 `.backend-team/artifacts/t25-production-dependency-audit-20260916.json`。
  - 本轮正式宿主接线：配置了 development execution 的文档工作流宿主现在把 `createLongTaskExecutionSessionFactory` 接到真实切片运行；开发运行和嵌套 Agent 通过 `SharedLongTaskRunLease` 共用一个跨进程锁，规格阶段无源代码所有权的 Agent 按选择器跳过绑定，不创建 no-op 会话。`createProductionDevelopmentRun` 支持宿主传入共享租约；Bundle/宿主类型检查和受影响回归通过。
  - 本轮验证：Harness 全量 83/83、Bundle 全量 187 passed/2 skipped、长任务绑定与工作流宿主回归通过；全工作区 `typecheck`、`build`、受影响 ESLint、`git diff --check`、`verify:agent-runtime`、`verify:dsh-production-ports`、`verify:web-client` 通过；`npm audit --omit=dev` 仍为 0 vulnerabilities。
- 2026-09-16 官方 DSH runtime 隔离切片验收：新增 `scripts/verify-long-task-runtime.mjs`，在两个独立的官方 DSH `headless` 进程中加载同一 `ContextManager` checkpoint、`FileDevelopmentCheckpointStore` 运行锁和正式 `HarnessAgentRuntime`，通过确定性 `dsh-agent-runtime-probe` 适配器完成首个切片写入与第二个切片恢复。首进程 checkpoint revision 2、transcript 2 条、tokens 12；新进程从 revision 2 恢复后追加到 revision 4、transcript 4 条、tokens 12；两次 Agent 均在结束后销毁，未触碰业务任务、Qwen 凭据或样例代码。证据 `.backend-team/artifacts/t25-official-runtime-long-task-20260916.json`；`npm run verify:long-task-runtime`、脚本 ESLint、全工作区 `typecheck`、`build` 与 `git diff --check` 通过。
  - 2026-09-17 真实 Qwen 模型短请求验收：在 Codex Chrome 插件控制的真实 DSH Web 宿主中创建独立新对话，模型选择为 Qwen3.8 Flash（提供方 `qwen-4399`、协议 `openai-responses`），发送固定无工具请求并收到精确响应 `QWEN_REAL_ACCEPTANCE_OK`；页面显示 1 轮/1 步、首 token 2.8 秒、输出 25 tokens，未关联团队任务、未读写文件。证据 `.backend-team/artifacts/qwen-real-acceptance-20260917.json`，未记录 API key。
  - 2026-09-17 真实 Qwen Agent Team 受限切片验收：新增 `scripts/verify-real-qwen-team-slice.mjs` 与 `verify:real-qwen-team-slice`，使用临时 DSH Profile、独立工作区和正式 `createProductionActivation`，以 Qwen3.8 Flash 启动一个 developer Agent，只允许读写单个 marker 文件，不执行命令、数据库或迁移。首个独立 DSH 进程完成写入并落 ContextManager revision 2、实际消耗 46,921 tokens/19,659ms；第二个独立进程恢复同一线程 revision 2，读取既有内容并追加续接标记，完成 revision 4、实际消耗 70,965 tokens/17,906ms。两次 handoff 均 `completed`，工具调用分别为 2/3，最终文件内容和 SHA-256 均核对通过；证据 `.backend-team/artifacts/qwen-real-team-slice-20260917/evidence.json`，未记录 API key，临时 Profile 已清理。
  - 完成标准已满足：真实 Qwen 驱动正式 Agent Team，受限工作区和工具权限生效；跨进程恢复读取同一 ContextManager checkpoint，续接后 revision 单调增加；模型 token/wallMs/toolCalls 计账及文件结果可核对；无业务任务、客户样例、数据库或迁移副作用。脚本 ESLint、`git diff --check` 与证据/marker 回读通过，T25 已勾选。

## 二、项目适配与开发执行

- [ ] **T07 ☐ 多服务项目范围选择｜代码完成，真实多服务触发验收待补｜R08**
  - 已有只读项目识别；完成服务归属选择与执行策略，沿用现有框架、ORM、包管理器。
  - 本轮代码推进：`ProjectAnalysis` 保留 `ServiceBoundaryDecision`，项目上下文向规格 Agent 暴露候选服务、评分和证据路径；出现多个可信候选时明确要求在需求确认中让用户选择 `relativeRoot`，选择前不生成业务写入计划。支持通过 `analyze(requestedServicePath)` 只接受 manifest-backed、工作区内且无敏感/符号链接逃逸的明确选择。
  - 本轮隔离验证：项目分析、服务边界和规格上下文 40 项通过；project-analyzer/build、类型检查、Bundle 类型检查、相关 ESLint 与 `git diff --check` 通过。未修改客户样例代码。
  - 2026-09-14 逐项复验：Node 24 下重新运行多服务项目分析、服务边界和 Bundle 项目上下文测试，共 4 个文件 41 项通过；多服务 monorepo 仍返回 `needs-clarification`，显式选择仅接受 manifest-backed 的工作区内服务路径。真实正式宿主触发“发现多个候选→聊天逐步确认→选择后生成计划”的证据仍未取得，因此保持未勾选。
  - 完成标准：多服务项目中修改范围清楚、写入受限；歧义通过实际确认处理，不把检测建议当授权。
- [x] **T08 ☑️ 空目录初始化后端项目｜真实隔离验收通过｜R09**
  - 已有 `NewProjectBootstrapper`：固定 Node/TS/Nest/Fastify/PostgreSQL/Drizzle 模板、空目录冲突检查、逐文件哈希校验、target-local Node/npm 和 `npm install --ignore-scripts`；此前临时夹具下载网络曾阻塞真实隔离验收，现已完成复验。
  - 2026-09-14 逐项复验：Node 24 下运行 `packages/development/test/new-project-template-isolation.test.ts` 与 `tests/e2e/new-project-simulated-harness.test.ts`，2 个文件、2 项通过；隔离夹具实际完成目标本地 Node 24 解析、模板写入校验、npm 依赖安装、typecheck、build 与 health 基线测试，并确认未修改宿主 shell/profile、未调用外部 PATH shadow。此前的临时下载阻塞本轮已解除。
  - 完成标准：从空目录到可运行项目，依赖、数据库、测试与交付可复现；不以健康接口或模板文件存在代替。
- [ ] **T09 ☐ 依赖安装与通用命令审批｜代码完成，真实宿主授权验收待补｜R10/R12**
  - 本轮接入：managed Agent 可选注册 `backend_team_command`；命令使用工作区相对可执行文件和 cwd，安装/迁移能力、网络策略、短期批准令牌、阶段/预算/审批均在执行前后复核，未提供宿主执行器时工具不注册。
  - 2026-09-14 逐项复验：Node 24 下运行 managed Agent 命令、Node command runner 与 approval token 回归，3 个文件 51 项通过；覆盖只读命令默认拒绝网络、安装风险拒绝、短期令牌校验、冻结执行证据以及取消/过期边界。未在真实工作区批准或执行安装/迁移命令，正式宿主授权证据仍待补。
  - 完成标准：安装与命令由 Agent 在授权范围执行；取消/过期确认不执行；无全局环境修改或任意 Shell 放开。
- [x] **T10 ☑️ 项目级类型检查、构建与 lint｜真实项目脚本验收通过｜R10**
  - 本轮接入：`packages/verification/src/project-verification.ts` 从项目实际 manifest 的 `typecheck/build/lint` 脚本生成 argv，统一经 `VerificationEngine` 执行并显式报告缺失脚本；最终开发验收支持宿主注入项目级验证结果，报告保留执行结果。
  - 2026-09-14 逐项复验：Node 24 下 `npm run typecheck`（全部 workspace）、`npm run build`（全部 workspace/Bundle）和 `npm run lint` 均成功；同时运行项目脚本映射与结果/缺失脚本测试 2 项通过。验证链路保留实际命令结果，并将缺失的 build/lint 标记为 `notRun`，T10 已勾选完成。
  - 完成标准：真实成功/失败、文件变化后的证据失效、未适用/未执行状态准确。已有固定配置文件级检查不替代本项。
- [x] **T11 ☑️ 完整安全、数据库及契约验证｜生产门禁与 arm64 数据库验收通过｜R10**
  - 本轮接入：`ComprehensiveSecurityReview` 汇总凭据/代码气味、依赖与授权证据，并要求宿主按项目适用性提供数据库、API、OpenAPI、迁移、启动和契约检查；缺失必需检查阻断，选配检查明确告警。最终验收支持宿主注入该报告。
  - 2026-09-14 逐项复验：工作区 Node 24 直接运行 `verify-web-client.mjs`、`verify-dsh-production-ports.mjs`、修复后的 `verify-agent-runtime.mjs` 均通过；`verify-postgresql-execution-port.mjs` 在 darwin-arm64 完成真实启动、建库、SQL 探针、停机及新实例恢复并保留数据/凭据身份。安全、契约、最终验收及证据状态回归 7 个文件 39 项通过。期间修复 Agent runtime 验收夹具缺失完整 `agentTask.verification` 导致的 schema 生成异常；未执行客户业务迁移或生产发布。
  - 完成标准：适用检查实际运行并有证据；缺失、失败及不适用分别报告，不把单元测试等同全部验证。
- [x] **T12 ☑️ 专家创建受限子 Agent｜真实 Qwen 委派验收通过｜R11**
  - 本轮接入：managed Agent 在存在直接 `request.delegation` 且任务声明 `canDelegate` 时注册 `backend_team_delegate_worker`；只提交完整 `AgentTask`，实际深度、角色、路径、预算、审批和所有权由 Core `TeamCoordinator`/`DelegationGuard` 再次校验，worker 不会获得委派回调。
  - 2026-09-14 逐项复验：Node 24 下运行 Agent topology、managed Agent 委派、DelegationGuard 和 capability intersection 回归，4 个文件 19 项通过；覆盖直接专家回调窗口、深度二 worker 权限收敛、预算/路径/审批校验和回调关闭后的拒绝。
  - 2026-09-17 真实 Qwen 委派验收：新增 `scripts/verify-real-qwen-delegation.mjs` 与 `verify:real-qwen-delegation`，使用临时 DSH Profile、独立工作区和正式 `createProductionActivation`，以 `qwen-4399`/`qwen3.8-flash` 启动 developer expert；expert 通过生产 `backend_team_delegate_worker` 创建唯一 depth-two worker，worker 仅能读写 `acceptance/qwen-real-delegation.txt`，实际写入并回读精确 marker，所有权、能力收敛、预算和 durable child acknowledgement 均通过。证据 `.backend-team/artifacts/qwen-real-delegation-20260917/evidence.json`：expert/worker handoff 均 `completed`，worker run `passed`，marker SHA-256 `75dcd546b4d731154b7ddd0f4cde77b529c4e5775ea6ab3c4230fde1ae0c7b4e`，临时 Profile 已清理，未记录 API key。验收首次暴露父任务把已由子任务 reservation 结算的 `children` 再记一次、导致 `task budget exhausted`；`TaskScheduler` 已改为保留 host usage、只由 reservation 结算 children，修复后真实验收通过。
  - 2026-09-17 回归：工作区 Node 24.19.0 下全量 Vitest `205 passed | 5 skipped`、`1515 passed | 7 skipped`；全工作区 typecheck、lint、Bundle build 和 `git diff --check` 均通过。全量并行运行曾使三次受限 TypeScript 检查超过 Vitest 默认 5 秒，已把该测试超时设为 30 秒（不改变生产超时边界），复跑通过。随后新增的一致性回归因既有合同允许 `children=0` 搭配待确认 handoff ID，已撤回该过严约束；当前调度器专门回归仍覆盖子任务 reservation 不重复计数。
  - 完成标准已满足：生产工具可用，真实模型验证子任务范围、预算、结果汇总和越权边界；取消边界继续由既有隔离回归覆盖。

## 三、数据库交付（Stage 06）

- [x] **T13 ☑️ 数据库结构同步 ORM 源码｜同一正式宿主会话 GUI→迁移→ORM/数据库验收通过｜R13**
  - 已实现：DbGate 生成的 `schema.ts` 可通过 `database.ormSchemaPath` 纳入同一迁移审批；审批前只读预览，批准后在原文件摘要未变化时原子写入，迁移失败尝试回滚 ORM 文件；SQL 与 ORM 摘要均绑定审批记录。
  - 2026-09-14 逐项复验：隔离 Chrome 中真实 DbGate 7.2.3 连接临时 `design_ba779c1ce46f3111`，通过 public schema 创建 `gui_migration_accounts`、增加 `email text`，查看并确认生成的 `CREATE TABLE` SQL；数据库查询回读与监听器证据保存在 `.backend-team/artifacts/dbgate-gui-acceptance/gui-migration-evidence-20260914.json`。补充真实 PostgreSQL arm64 迁移回归：审批前 ORM 文件保持原内容，审批后 `schema.ts` 原子落盘并包含 `migration_demo`，同时完成数据保留和结构漂移拒绝验证；摘要证据写入 `.backend-team/artifacts/native-migration-orm-t13-20260914.json`。
  - 2026-09-14 同链路复验：在第二个隔离 DbGate 设计库中先通过真实 GUI 完成同样的建表和 SQL 确认，再保留开发基线表后调用固定版本 Drizzle 生成唯一迁移 `0001_serious_raza`（SQL SHA-256 `bd923b4099c3a18e263e1f3e896bca386fb453c8663f304c921d1aa215707309`），随后由隔离运行器执行备份、ORM 原子落盘、SQL 应用并回读 `baseline` 与 `gui_migration_accounts` 的全部字段。完整摘要在 `.backend-team/artifacts/dbgate-gui-acceptance/gui-migration-generated-20260914.json`，ORM 文件为 `.backend-team/runtime/gui-migration-acceptance/schema.ts`。首次生成失败暴露出设计库缺少开发基线时 Drizzle 会进入不确定变更路径；已补回基线后重跑通过，并将该前置条件固定进验收脚本。
  - 2026-09-15 同一会话正式宿主验收：Codex Chrome 打开隔离 DSH `web` Profile（3095）的“打开数据库工具”，进入同一会话认证的 DbGate 7.2.3（3094），在 `design_fd7eece23e1be9cf` 中通过 public schema 创建 `gui_migration_accounts` 并增加 `email text`，查看并确认 `CREATE TABLE` SQL。随后由同一 `sessionId` 调用 `prepare-database-migration`，宿主显示迁移审批卡和完整 `migration.sql` 预览；点击隔离确认后完成 ORM `schema.ts` 原子写入、备份与 SQL 应用，独立 PostgreSQL 查询回读 `true|id,email`。证据 `.backend-team/artifacts/formal-host-t13-same-session-20260915.json`，应用摘要 `.backend-team/runtime/migration-acceptance/generation-uL2470/applied.json`（临时宿主路径 `/private/tmp/dsh-t14v-M6nX3X`）。
  - 完成标准：真实 GUI 修改可追溯到一致的 ORM/迁移产物，并经实际数据库验证；同一正式宿主会话的接线、SQL 预览、ORM 落盘和数据库回读均已取得。仅使用临时 Profile、工作区和 PostgreSQL 集群，未修改正式业务工作区或业务数据库。
- [x] **T14 ☑️ 待审批迁移重启恢复｜正式隔离宿主重启验收完成｜R13**
  - 已实现：待审批迁移写入工作区私有 `pending-migration.json`，设计会话写入 `design-session.json`；生产宿主启动时先恢复本地 PostgreSQL，再按工作区、revision、目标、设计会话和 SQL/ORM 摘要重建审批，任一不一致即清理并阻止应用。
  - 2026-09-14 逐项复验：Node 24 下迁移审批与恢复回归 9 项通过；覆盖精确 SQL 预览、明确批准/拒绝、旧 revision 过期、数据库应用失败、宿主重启后恢复并应用、持久记录摘要篡改清理，以及中断集群不删数据。配置宿主初始化/会话任务恢复再跑 5 项，合计 3 个文件 14 项通过，脱敏记录 `.backend-team/artifacts/migration-review-t14-regression-20260914.json`。补充修复：无效或篡改的待审批记录现在会先经安全文件校验清理，再返回可诊断错误，避免启动反复卡住。Bundle 类型检查、相关 ESLint、`git diff --check` 通过；`DSH_REAL_DRIZZLE=1` 原生 PostgreSQL 隔离验收 1 项通过，包含迁移应用后数据保留与结构漂移拒绝。
  - 本轮补充：正式宿主恢复待审批迁移失败时，不再直接让宿主初始化退出；保留已验证的宿主和资源页面，把经过截断的失败原因写入 durable `workflowError`，由任务状态显示为“已受阻”，让用户可以查看技术详情后再处理。恢复仍然不会自动应用 SQL，下一次启动继续执行原有 workspace/revision/hash 复核。迁移恢复、宿主恢复与进度模型回归合计 19 项通过，Bundle 类型检查、构建、打包、Profile 升级和重启通过。隔离真实宿主演练用损坏待审批 JSON 验证 `hostMode=supported`、`workflowError` 持久化和无 SQL 应用，证据 `.backend-team/artifacts/migration-recovery-failure-host-t14-20260914.json`。
  - 本轮修复多任务隔离：发现共享 `pending-migration.json` 会被旧的 legacy host 先消费，导致当前任务看不到自己的损坏记录。`FileMigrationReviewStore` 现在按任务使用 `pending-migration-<taskId>.json`，保留无任务时的 legacy 路径兼容；`workflow-host` 创建审批存储时传入当前任务 ID。新增跨任务/legacy 路径回归，相关 4 个文件 20 项通过，Bundle 类型检查、构建、打包、Profile 升级和重启通过。
  - 本轮真实 Chrome 隔离验收：临时 Profile 重启后打开 T14 任务，页面保持可访问并显示“团队任务 · 需求分析 已受阻”；当前问题和下一步均显示“待审批迁移记录无效，已阻止恢复”，点击“查看技术详情”后可见完整 JSON 解析错误。任务状态为 `blocked`，`sqlApplied=false`。证据 `.backend-team/artifacts/migration-recovery-failure-chrome-t14-20260914.json`；临时工作区未连接客户业务数据，未执行审批、迁移或生产写入。
  - 本轮修复进度页审批卡的回调：打开方案后现在会把控制接口返回的、哈希匹配的文件预览写回任务进度状态；预览出现后才显示“退回修改/确认并继续”，避免用户点击后页面无反馈。新增 Web 回归覆盖，Bundle/Web 类型检查、构建、打包和 Profile 升级通过。
  - 本轮有效重启验收：隔离 Profile/工作区重启后，Codex Chrome 显示“等待你处理 / 需要确认 / 数据库迁移”，点击“查看方案”后可见 `migration.sql` 的完整 `CREATE TABLE "accounts"` SQL，并出现“退回修改/确认并继续”；未点击任何决定，`sqlApplied=false`。证据 `.backend-team/artifacts/migration-review-restart-confirmation-chrome-t14-20260914.json`。
  - 本轮过期/篡改边界验收：注入旧 revision 记录后，真实 Chrome 显示“迁移审批已过期，请重新生成迁移”并清理待审批文件；注入错误迁移摘要后，显示“pending migration approval hash does not match preview”并清理待审批文件。技术详情可展开查看，均未执行 SQL。证据 `.backend-team/artifacts/migration-review-expired-chrome-t14-20260914.json`、`.backend-team/artifacts/migration-review-tampered-chrome-t14-20260914.json`。
  - 2026-09-15 正式隔离宿主验收：同一 `web` Profile/工作区/任务先通过 DbGate 7.2.3 在设计库创建 `t14_restart_recovery`，生成待审批迁移并在 Chrome 查看完整 SQL；停止并重启宿主后，PostgreSQL 端口由 `56273` 变为 `53510`，待审批 ID、revision、SQL 摘要、source/design 目标均恢复一致。重启后的 Chrome 仍显示“需要确认 / 数据库迁移”、`migration.sql` 和两个决定按钮；未代用户操作。独立查询确认 sourceDatabase 表计数 `0`、designDatabase 表计数 `1`，`sqlApplied=false`。证据 `.backend-team/artifacts/migration-review-restart-confirmation-formal-host-t14-20260915.json`，视觉记录见 `design-qa.md`。
  - 完成标准已满足：重启后恢复正确 SQL、目标和批准版本；端口变化不会误阻止合法恢复；旧批准不能应用新 SQL；失败可诊断恢复。仅使用临时 Profile、工作区和 PostgreSQL 集群，未执行正式客户任务审批或生产迁移。
- [ ] **T15 ☐ 数据库备份与恢复交互｜代码完成，真实恢复/UI 验收待补｜R13**
  - 已实现：快照服务支持受控创建、清单列出、摘要核验和 loopback 目标恢复；恢复要求 canonical 清单、私有 dump、哈希一致，并可由宿主提供“目标库为空”检查；迁移应用继续自动生成备份及应用清单。
  - 2026-09-14 逐项复验：真实 PostgreSQL 18.6 arm64 隔离库完成创建快照、清单读取、恢复到新空库并查询保留行；篡改 dump 后恢复被 `snapshot hash mismatch` 阻断。证据写入 `.backend-team/artifacts/postgresql-snapshot-t15-20260914.json`。修复快照 `pg_dump/pg_restore` 未传受管数据库用户导致认证回退的问题；相关数据库服务回归 19 项通过，Node24 真实快照验收 1 项通过，相关 ESLint 与 `git diff --check` 通过。
  - 本轮修复资源面板打开任务时未同步当前 `taskId` 的问题：面板现在在资源响应返回后保留任务上下文，备份和恢复按钮不会因空任务标识静默 no-op；备份完成和恢复完成均显示可读的绿色结果状态。
  - 本轮隔离真实 Chrome 宿主验收：在临时 Profile/工作区的资源面板中通过“立即备份”创建 `20260914T130653Z-postgres-95fe05fc`，页面显示“数据库备份已完成，可在下方查看校验摘要。”并列出 3 份备份；随后准备空库 `restored_gui2`，通过“恢复到新库 → 确认恢复”完成恢复，页面显示“数据库已恢复到新库：restored_gui2”，独立查询回读 `1|t15-ui`。证据 `.backend-team/artifacts/database-snapshot-resource-chrome-t15-20260914.json`，截图由 Codex Chrome CUA 直接检查。
  - 完成标准：Agent 提供实际操作和必要确认，用户可查看备份/恢复结果；数据恢复有真实证据。隔离真实资源面板的备份/恢复和结果展示证据已具备；正式客户任务和生产数据库仍未操作，T15 继续保持未勾选。
- [ ] **T16 ☐ PostgreSQL arm64 发布制品｜发布证据待核实｜R18**
  - 本机运行已验证；核查原生制品、manifest、正式下载地址和签名，不沿用旧截图的 pending 状态推断现状。
  - 2026-09-14 逐项复验：本机 arm64 archive `.backend-team/artifacts/postgresql-18.6-darwin-arm64.tar.xz` SHA-256 为 `2c91690995dab19f4193b60297a4070f9c28df96bcf2711a49dcc48d6bae4ec0`；直接运行 PostgreSQL 18.6 arm64 生命周期、SCRAM/loopback、建库建表读写、停止及新实例恢复均通过，证据 `.backend-team/artifacts/postgresql-execution-t16-20260914.json`。发布 manifest 仍如实为 `pending-native-build`，`verify-postgresql-runtime.mjs` 以 Node24 明确拒绝未验证 manifest；当前缺 x64 制品、正式 HTTPS 下载地址及签名/attestation，未把本机结果升级为发布证据。
  - 2026-09-15 最新只读审计（构建前快照）：运行 `verify-postgresql-execution-port.mjs` 时，Node 24.19.0 / macOS arm64 生命周期、SQL 读写、停止和新集群恢复通过；当时包为 5,709,156 字节，结果 `.backend-team/artifacts/postgresql-execution-t16-20260915.json`。`verify-postgresql-runtime.mjs` 以退出码 1 拒绝 `pending-native-build`；该快照尚无 darwin-x64 包、manifest artifact、稳定 HTTPS 地址、checksum sidecar 或签名/attestation，审计 `.backend-team/artifacts/postgresql-release-t16-20260915.json`。后续双架构本机构建见下条，未将本机结果升级为发布通过。
  - 2026-09-15 本轮完成源码构建补齐：从 `postgresql-source-18.6.json` 下载并校验 PostgreSQL 18.6 源码，生成 arm64（5,706,128 字节，SHA-256 `2af1b662319bada7f49be44fb2b2ac8a58e66ca3d701f79b40f615f3992c5b4c`）与 x64（6,211,348 字节，SHA-256 `62ceee8db1e4fea2f9d310cd7d050218c7085609574a50951b6c061bc8b6b9ce`）归档；`file` 确认二进制分别为 Mach-O arm64/x86_64。arm64 使用 `verify-postgresql-execution-port.mjs` 完成 loopback、SQL 写读、停止和新集群恢复；x64 在 Rosetta 下完成 initdb、loopback pg_ctl、SQL 写读和停止。完整证据 `.backend-team/artifacts/postgresql-native-build-t21-20260915.json`。
  - 本机双架构和执行证据已具备，但没有将 `runtime-manifests/postgresql-18.6-darwin.json` 擅自改成 `verified`：正式门禁还要求外部可下载 HTTPS 地址、checksum sidecar 及签名/attestation。`verify-postgresql-runtime.mjs` 继续按此规则 fail closed。
  - 2026-09-17 官方来源复核：PostgreSQL 18.6 已于 2026-08-13 发布；官方 FTP 当前提供源码归档及 checksum，未提供可直接用于本项目的 darwin-arm64/darwin-x64 运行时归档和签名材料。因此源码 URL 不能替代本机制品 provenance，仍需外部构建与分发服务补齐。
  - 完成标准：安装包、摘要、签名和来源可验证；在干净环境可重复安装启动。Intel 部分见 D01。

## 四、界面与浏览器完整验收

- [x] **T17 ☑️ 图片文件选择与拖入｜真实宿主选择、拖入和图片模型请求已验证｜R16**
  - 粘贴及模型图片输入已有证据；本轮通过官方 `conversation.input.left` 插槽补充清晰的“添加图片”入口，继续复用 DSH `conversation` 附件服务和 `InputActions`，不自建上传协议；官方 InputBar 已负责拖入、预览、取消和宿主图片请求传输。
  - 隔离回归覆盖文件选择成功、输入状态拒绝时释放临时附件；Web/Bundle 类型检查、构建、相关 ESLint 与 `git diff --check` 通过。
  - 本轮真实宿主验收：重启并升级本地 `web` Profile 后，Codex Chrome 的 `http://127.0.0.1:3080/` 显示“添加图片”；通过真实文件选择器载入仓库内非敏感 `host-narrow.png`，输入区出现带文件名和缩略图的“待发送图片”，可用“移除图片”清理，未发送消息、未触发模型或业务任务写操作。
  - 本轮真实宿主模型验收：在 Codex Chrome 新建隔离会话，选择有效 PNG `compare-review.png` 后发送图片描述短请求；Qwen3.8 Flash 返回图片内容描述，单轮完成，未关联团队任务。证据 `.backend-team/artifacts/image-model-chrome-evidence-20260914.json`。首次使用的 `host-narrow.png` 内容实际为 JPEG，宿主按格式拒绝，已转换为真实 PNG，避免后续验收误报。
  - 2026-09-14 拖入复验：在真实宿主把当前对话中已显示的 `compare-review.png` 拖入 composer，DOM 出现“待发送图片”与移除按钮，发送按钮变为可用；随后移除草稿，未发送或改变任务。证据 `.backend-team/artifacts/image-drag-chrome-evidence-20260914.json`。本地文件选择与图片模型请求证据见上方记录。
  - 完成标准已满足：正式 DSH 宿主可操作，图片选择/拖入均进入草稿，选择的图片已通过 Qwen3.8 Flash 完成一次真实图片请求；按既有确认稿约定处理 UI 变化。拖入本地文件系统的动作受当前浏览器自动化接口限制，未把该限制误报为失败。
- [x] **T18 ☑️ 深色、窄屏及整体交互｜真实宿主矩阵验收通过｜R15**
  - 2026-09-14 窄屏初验：在真实 DSH Chrome 390×844 视口下，收窄注入的“当前团队任务”和“团队任务”按钮为图标按钮后，顶部标题/模式/操作区不再重叠；`document` 与 `body` 的 scrollWidth 均为 390，无横向溢出。恢复默认视口后桌面端仍保留完整文字按钮；摘要卡和待审批矩阵的剩余问题已在 2026-09-15 修复并复验。
  - 2026-09-14 深色复验：真实宿主切换深色后，聊天、会话列表、团队任务入口、输入区和右侧资源预览均可读；需求规格与两条审批记录在右侧展开，来源、会话、任务和文档摘要完整可见，`document/body.scrollWidth=1920`。证据 `.backend-team/artifacts/t18-dark-resource-chrome-evidence-20260914.json`，视觉记录已写入 `design-qa.md`。当时缺真实待审批卡片在深色/窄屏下的完整矩阵，已由 2026-09-15 复验补齐。
  - 2026-09-15 深色窄屏矩阵：在同一隔离正式宿主 390×844 视口切换深色，修复摘要卡窄屏三列挤压后，四个摘要行均恢复正常横向换行；待审批卡可查看 `migration.sql`、显示完整 SQL 和“退回修改/确认并继续”，资源面板与任务中心均可打开，聊天输入区保持可见，`document/body.scrollWidth=390`。未点击审批决定。证据 `.backend-team/artifacts/t18-dark-narrow-approval-chrome-20260915.json`，视觉记录写入 `design-qa.md`。
  - 完成标准已满足：深色桌面资源/审批历史、浅色窄屏顶部布局、深色窄屏摘要/待审批卡、资源面板和任务中心均在真实 Codex Chrome 宿主核对；聊天、任务中心、资源、问题和审批没有发现遮挡或横向溢出，审批决定未代用户执行。差异、修复和证据已记入 `design-qa.md`。
- [ ] **T19 ☐ Chrome 全流程验收矩阵｜部分完成｜R01–R07/R13/R15/R18**
- 本轮建立 `.backend-team/artifacts/browser-acceptance-matrix-t19-20260914.json`，把十个浏览器交互和十个 `scenarios.ts` 场景逐项标成 `passed/partial/blocked/not-run`；不再保留失真的“全部 not-run”。
- 2026-09-14 本轮使用工作区 `.backend-team/runtime` Node 24.19.0 复跑 E2E 矩阵：7 个文件、16/16 测试通过（1.26s），结果保存在 `.backend-team/artifacts/browser-acceptance-matrix-t19-20260914-rerun.json`。该命令验证隔离 E2E 合同和清理断言，不替代真实 Codex Chrome 正式宿主流程，因此 T19 仍保持 `partial`。
- 2026-09-15 刷新矩阵：工作区 Node 24.19.0 下 `tests/e2e` 7 个文件、16/16 测试通过（1.34s）；合并 T13 同会话 DbGate→ORM→迁移、T14 重启恢复和 T18 深色窄屏/资源/任务中心真实 Codex Chrome 证据，更新 `.backend-team/artifacts/browser-acceptance-matrix-t19-20260915.json`。T19 仍为 `partial`，未把局部真实宿主切片升级为十场景全流程通过。
- 2026-09-16 本地回归刷新：工作区 Node 24.19.0 下 `tests/e2e` 7 个文件、16/16 测试通过；该结果继续只证明隔离 E2E 合同，不替代同一生产组合的真实 Chrome 全流程，T19 仍保持未勾选。
- 真实 Codex Chrome 核对任务中心：同一工作区可见已搁置 greeting、已完成人员管理、未完成客户管理和早期记录，当前会话任务有明确标记；聊天与任务中心并列，搜索/状态筛选可见。相关 DOM 与视觉记录见 `design-qa.md` 的 T04 任务中心段落。
  - 已取得真实宿主只读交付/资源、真实 DbGate/ PostgreSQL 隔离运行、图片模型和深色资源等局部证据；需求/设计审批、Agent 活动、迁移恢复和卸载均按实际边界标为部分或阻塞。
  - 完成标准：逐项保存环境、操作、截图、结果和限制；核对旧浏览器清单，不能保留失真的“全部 not-run”，也不能以局部通过勾整项。当前尚缺同一生产组合下的新业务需求至交付全流程、T15 正式客户任务边界、T16/T20/T21/T22 发布门禁与干净 Profile 卸载，因此 T19 保持未勾选。

## 五、生产 Bundle 与发布（Stage 07）

- [ ] **T20 ☐ 生产 Bundle 完整接线验收｜部分完成｜R07/R18**
- 本轮保存 `.backend-team/artifacts/production-wiring-t20-20260914.json`：官方 Agent runtime probe、Host/Session/Agent loopback provenance probe 均通过；Bundle 生产激活/独立加载回归 58+2 项通过，打包验收通过。
- 2026-09-14 本轮使用工作区 `.backend-team/runtime` Node 24.19.0 复跑生产接线相关 12 个测试文件、81/81 通过（2.78s），结果见 `.backend-team/artifacts/production-wiring-t20-20260914-rerun.json`。首次误用系统 Node 20 时出现 `TEXT_ENCODINGS.union` 兼容性错误及独立类型检查拒绝；按仓库 `engines >=24 <25` 改用 Node 24 后通过，未修改业务代码。
- 修复发布验收脚本与当前 Bundle 契约的漂移：核心文件仍逐项必需，新增的团队主题、许可证和 `lib/tooling/` 只按明确前缀允许；客户端夹具补齐 DOM、React 和布局插槽，避免把真实打包客户端误报为失败。相关 `release-content-policy` 回归 2 项通过。
  - 诊断边界已核对：默认 Bundle 仍为只读，缺少 `agents/workspaceRoot/recoveryToken/policyEngine` 时不创建工作区状态；生产激活只能由显式配置启用，历史 `production-agent-runtime-not-wired-in-diagnostic-bundle` 仍是正确的诊断标志。
  - 2026-09-15 生产接线复验：工作区 Node 24.19.0 下 14 个生产接线相关测试文件、107/107 通过；Bundle 类型检查、全工作区构建、打包制品 14 项必需文件检查、Agent runtime probe 与 Host/Session/Agent loopback provenance probe 均通过。证据 `.backend-team/artifacts/production-wiring-t20-20260915.json`。复验发现一份已停止的 T18 临时工作区仍与受管 Node 共享硬链接，导致 nlink=2 并被安全门禁拒绝；清理该临时目录后 nlink 恢复为 1，未修改产品代码。
  - 完成标准：从可安装制品验证完整链路；核查诊断模式触发条件及历史 UNWIRED 标志，明确默认诊断与已启用生产配置的区别。当前尚缺官方生产 Harness provenance、真实生产协调器/模型运行及同一生产组合的完整 Chrome 流程，因此 T20 保持未勾选。
  - 2026-09-16 本地回归刷新：`packages/bundle/test` 30 个文件、187 passed/2 skipped；与本轮 T25 runtime smoke、当前 Bundle 重新打包和 Profile 生命周期复验相互独立。T20 的真实受保护模型与生产协调器证据仍缺失，继续保持未勾选。
  - 2026-09-17 最终 Bundle/Profile 接线复验：升级工作区 `web` Profile 到当前 Bundle 并重启 `http://127.0.0.1:3080`；安装包与 `packages/bundle/lib/production.js` SHA-256 一致，页面 HTTP 200。`verify:agent-runtime`、`verify:dsh-production-ports`、`verify:web-client` 均通过；真实 Qwen/生产协调器局部证据已由 T12 提供，T20 的同一生产组合全流程仍待矩阵与外部 provenance。
  - 2026-09-18 本地宿主恢复复验：发现 3080 进程已停止，按现有 `web` Profile 重启后 Codex Chrome 页面恢复，任务标题、模型入口和“添加图片”入口可见；HTTP 200，`verify:agent-runtime`、`verify:dsh-production-ports`、`verify:web-client` 均重新通过。未改变任务、审批、迁移或发布状态；T20 仍只完成本地接线证据。
- [ ] **T21 ☐ 发布材料｜依赖风险已修复，外部发布门禁待补齐｜R18**
  - 新增 `scripts/release-materials.mjs`，发布构建现在为同一 Bundle 生成 checksum、CycloneDX 1.5 SBOM 和材料清单，绑定 package-lock、Bundle package、第三方许可证说明、运行时 manifest、Agent fixture 与 release evidence 摘要；验证脚本会检查制品、SBOM、许可证文件和输入摘要一致，release-candidate 还会拒绝未签名或没有稳定 HTTPS 下载地址的材料。
- 新增 `scripts/audit-release-materials.mjs` 与 `audit:release-materials`，只读输出各项材料的 `passed/blocked` 状态，不把本地开发包升级为正式发布；当前核对结果保存在 `.backend-team/artifacts/release-materials-t21-20260914/audit.json`。
- 发布材料构建器支持 `--distribution <json>` 接收外部签名服务的结果；只有带非空签名证据、与归档 SHA-256 完全一致且使用无凭据 HTTPS 地址的记录才会写入 `verified`，默认仍输出 `not-attested` 并 fail closed。
- 2026-09-14 本轮使用工作区 Node 24 并传入现有归档参数复核，checksum/SBOM 与 DbGate 版本/许可证检查通过；总体仍为 `blocked`，原因仍是 PostgreSQL 双架构 provenance、DbGate 依赖风险及签名/稳定 HTTPS 下载缺失。复核结果见 `.backend-team/artifacts/release-materials-t21-20260914/audit-rerun-20260914.json`。
- 2026-09-15 刷新同一当前 Bundle：重新打包 0.1.0，归档 256 项，SHA-256 `acb8fa1b7f12ab25c16eafb87d0b0a4bc19271dbaf387fc33c35670bd0d64a50`；CycloneDX 1.5 SBOM 395 个组件，SHA-256 `e054ad2c2a64892187e5f2f845ebd96e1476622a7f7f6d9bd8968f5fc547b772`。checksum/SBOM、Bundle 版本、许可证、DbGate profile 和官方 registry 安全审计检查通过（0 critical/0 high/8 moderate）；PostgreSQL manifest 尚未完成正式 provenance，签名和稳定 HTTPS 下载仍阻塞。审计结果 `.backend-team/artifacts/release-materials-t21-20260915/audit.json`，T21 保持未勾选。
- 当前本机制品材料：Bundle 0.1.0，256 个归档文件，SHA-256 `acb8fa1b7f12ab25c16eafb87d0b0a4bc19271dbaf387fc33c35670bd0d64a50`；CycloneDX SBOM 395 个组件，SHA-256 `e054ad2c2a64892187e5f2f845ebd96e1476622a7f7f6d9bd8968f5fc547b772`；第三方许可证说明已随包包含，DbGate 7.2.3/GPL-3.0 版本记录一致。
  - 2026-09-17 发布审计复核：`npm run audit:release-materials` 在 Node 24.19.0 下执行完成；Bundle 版本、许可证、DbGate 7.2.3/PostgreSQL-only profile 和安全审计均通过，整体仍按 fail-closed 为 `blocked`，原因是 PostgreSQL 双架构 manifest 尚未获得正式 provenance，且未提供待审 tarball、签名材料和稳定 HTTPS 下载地址。未把本机双架构构建结果升级为发布通过。
  - 2026-09-17 当前 Bundle 材料刷新：对最终 Bundle 重新生成 256 文件归档、checksum 和 CycloneDX SBOM（395 个组件）；归档 SHA-256 `a2c1e28c90bb353587e554ba3b899c7d74ba6b1279095ca4dcb196ffc421403a`，SBOM SHA-256 `36a67f5d8bea4e559d378f1a1cbf6da9cbb466e88d40b8e69348f02d44d131a3`。带 `--tarball` 的审计确认 archive/checksum/SBOM、许可证、DbGate 7.2.3/PostgreSQL-only profile 和 registry 安全审计通过；证据 `.backend-team/artifacts/release-materials-t21-20260917/audit.json`。整体仍 `blocked`，只剩 PostgreSQL 正式 provenance、签名/attestation 和稳定 HTTPS 下载。
  - 2026-09-17 发布交接检查：仓库已有 `.github/workflows/postgresql-runtime.yml`（macOS arm64/x64 原生构建与 GitHub attestation）和 `.github/workflows/release-bundle.yml`（release-candidate 门禁），但当前工作区没有配置 Git remote、GitHub CLI 登录或签名服务凭据，无法从本机代为触发外部 runner；未创建伪造 distribution 记录。
  - 2026-09-18 阻塞复核与本地修复：根目录 Bundle 归档与已审计归档 SHA-256 均为 `a2c1e28c90bb353587e554ba3b899c7d74ba6b1279095ca4dcb196ffc421403a`，但根目录缺少 `.sha256`、CycloneDX SBOM 和 materials sidecar，已补齐并由 `audit:release-materials --tarball` 验证 `archive-checksum-sbom=passed`（SBOM 395 个组件，SHA-256 `36a67f5d8bea4e559d378f1a1cbf6da9cbb466e88d40b8e69348f02d44d131a3`）。当前剩余阻塞仅为 PostgreSQL 正式双架构 provenance、签名/attestation 与稳定 HTTPS 下载；审计证据 `.backend-team/artifacts/release-materials-t21-20260917/audit-20260918.json`。本机默认 Node 20 会被仓库 Node24 前置门禁拒绝，已用工作区 Node 24.19.0 重跑并通过 runtime/ports/web、typecheck/lint/build；该环境前置不改变发布门禁。
- 2026-09-16 本地材料刷新：按当前 `package-lock.json` 重新生成 Bundle 0.1.0 的 checksum/SBOM/materials，归档 256 项，SHA-256 `26620a76c2d1f33aa324d33d8b4cf6ce86dd41f5e611eea9435aff0b489fb8d2`，SBOM SHA-256 `df5144dde9ebef11cfcc03cd8d0098a5cf44a7743e48e671c3f848f182323fad`。`audit-release-materials` 的 archive-checksum-sbom、许可证、DbGate 版本与 PostgreSQL-only profile 均通过；审计证据 `.backend-team/artifacts/release-materials-t21-20260916/audit.json`。PostgreSQL manifest 仍为 `pending-native-build`，签名状态 `not-attested` 且无稳定 HTTPS 地址，T21 继续保持未勾选。
  - DbGate 现状复核：安装器固定 `http@0.0.1-security`，并改为 PostgreSQL-only 运行时，只安装 `dbgate-api`、`dbgate-web` 和 `dbgate-plugin-postgres`；`dbgate-serve`、`dbgate-plugin-excel` 与 `xlsx` 从当前 runtime lock 和插件目录移除，启动器也会拒绝它们重新出现。官方 registry 安全审计为 0 critical/0 high/8 moderate，当前 profile 不再包含 `xlsx`。PostgreSQL 双架构本机制品已生成并有执行证据，但 manifest 仍为 `pending-native-build`；本地材料为 `not-attested`、无稳定 HTTPS 下载地址，正式发布继续 fail closed。
  - 验证：DbGate 安装器、DbGate 安全、release artifact、release content policy 与 dependency governance 共 5 个测试文件、44/44 通过；其中发布材料相关 3 个测试文件为 31/31。Bundle 构建、脚本审计、本机制品 checksum/SBOM/materials 复核通过；工作区 Node 24 下 PostgreSQL-only 启动器实际返回 DbGate 7.2.3 页面，runtime 中未发现 `xlsx`。正式发布仍需把双架构归档接入带签名的稳定 HTTPS 分发并完成 manifest 验证，T21 保持未勾选。
  - 2026-09-20 源码公开推送：完成公开前安全审计，以无旧提交历史的首个提交 `61da6e496031369062848090c497391f842c9394` 推送到 `https://github.com/zhuangdize/dsh-backend-team` 的 `main`；排除本地 `.backend-team`/`.superpowers`、依赖与构建目录、发布压缩包及旧历史中的内网地址。该动作只完成源码公开，T21 的正式制品 provenance、签名/attestation 和稳定 HTTPS 下载门禁仍未完成。
- [ ] **T22 ☐ 干净 Profile 生命周期验收｜待完整验收｜R18**
  - 新增 `scripts/profile-lifecycle-smoke.mjs`，只在临时 `DSH_HOME`、临时 Profile、临时工作区和临时 pnpm store 中调用官方 rc.6 DSH 命令；脚本强制工作区 Node 24.19.0，完成后清理临时目录并保留脱敏结果。
  - arm64 实际验收已通过：安装 0.1.0 后 dump-config 确认唯一 `backend-team` 行；再次读取诊断配置作为使用检查；用重打包的 0.1.1 包升级且行数保持 1；官方 remove 后重新安装 0.1.0 完成回滚恢复；再次 remove 完成卸载；`specs/keep.md` 与 `.backend-team/state.json` 前后 SHA-256 一致。证据 `.backend-team/artifacts/profile-lifecycle-t22-EBa4rL/result.json`。
  - 验证：脚本实际运行状态 `passed`，步骤为 `install → use-diagnostic → upgrade → rollback-remove → rollback-restore → uninstall`，架构 `arm64`，Harness `0.1.0-rc.6`，Node `24.19.0`；脚本 ESLint 与 `git diff --check` 通过。
  - 2026-09-16 当前 Bundle 复验：使用本轮重新生成的 `dsh-backend-team-bundle-0.1.0.tgz` 执行同一官方 Profile 生命周期，六个步骤全部通过，临时工作区 `specs/keep.md` 与 `.backend-team/state.json` 前后摘要保持一致。证据 `.backend-team/artifacts/profile-lifecycle-t22-20260916.json`；未触碰现有 3080 Profile、业务任务或审批记录。
  - 2026-09-17 环境门禁后复验：使用当前 Bundle `dsh-backend-team-bundle-0.1.0.tgz` 重新执行 `install → use-diagnostic → upgrade → rollback-remove → rollback-restore → uninstall`，六步通过且保留文件摘要一致，证据 `.backend-team/artifacts/profile-lifecycle-t22-20260917.json`。该结果仍只证明 arm64 本机 Profile 生命周期，未把生产组合、x64 或签名制品门禁误标为完成。
  - 2026-09-17 最终 Bundle 复验：预算修复后的当前 Bundle 重新打包后再次完成上述六步，`status=passed`、`preserved=true`；证据仍为 `.backend-team/artifacts/profile-lifecycle-t22-20260917.json`。
  - 限制：升级包沿用同一运行时代码，只用于验证官方 Profile 替换和单行身份；使用检查当前是只读诊断 dump，未宣称生产模型/浏览器链路。T19 的十场景仍有真实生产协调器、模型、DbGate/迁移、双架构和签名制品缺口，T22 保持未勾选。

- 2026-09-15（继续推进 T20）：按工作区 Node 24.19.0 复跑生产接线测试与打包制品验证，14 个测试文件 107/107 通过，Bundle 类型检查、全工作区构建、Agent runtime 及 Host/Session/Agent loopback provenance probe 通过。清理已停止的 T18 临时工作区释放受管 Node 的共享硬链接后，打包安全检查恢复通过。生产 Harness provenance、受保护真实模型、同一生产组合 Chrome 全流程、双架构 PostgreSQL 签名材料仍缺失，T20 保持未勾选；证据 `.backend-team/artifacts/production-wiring-t20-20260915.json`。

- 2026-09-15（继续推进 T21，已被后续修复更新）：重新生成当前 Bundle 的 256 项归档、checksum、CycloneDX 1.5 SBOM 与材料清单。该轮尚未移除 `xlsx`；随后已切换 PostgreSQL-only runtime 并重新生成材料，当前哈希见 T21 条目。

- 2026-09-15（继续修复 T21，已被本轮替代）：确认公开 registry 没有满足公告修复范围的 `xlsx` 版本；本轮采用 PostgreSQL-only runtime 从供应链上移除 Excel 插件路径，并保留签名/双架构等真实外部门禁。

- 2026-09-15（继续彻底修复 T21）：将 DbGate 安装策略收敛为 PostgreSQL-only 运行时，移除会引入 `xlsx` 的 `dbgate-serve`/Excel 插件；新增受审查启动器和插件白名单，安装后复制并核对 PostgreSQL 插件，原生启动前拒绝禁用包、错误版本和篡改启动器。工作区 runtime 的 package-lock、node_modules 和实际 loopback 启动均已复核无 `xlsx`；DbGate GUI 页面仍能正常返回 200。Excel 导入导出明确不属于 Agent Team 数据库 profile，PostgreSQL GUI、迁移、备份链路保留。联网安全审计、签名/attestation、双架构 PostgreSQL 与稳定 HTTPS 下载仍属于正式发布门禁。
- 2026-09-15（T21 递归残留复核）：发现旧安装留下的嵌套连接器与悬空 `.bin` 链接，已用官方 registry 按当前 lock 做干净 `npm ci`，运行时共 503 个审计包，递归检查无 `dbgate-serve`、`dbgate-plugin-excel`、`xlsx`；安装器现在安装前清理旧残留、安装后遇到重新引入则 fail closed。真实 npm 安装器在隔离临时工作区复验插件白名单和启动器，真实 PostgreSQL/DbGate 启停与登录消费复验 2/2 通过。
- 2026-09-15（T21 双架构本机构建与执行复验）：按官方 PostgreSQL 源码 manifest 生成 darwin-arm64 与 darwin-x64 归档，分别通过原生/Rosetta 架构核对；arm64 端口脚本通过真实集群启动、SQL 写读、停止和恢复，x64 端到端 smoke 通过 initdb、loopback 启停和 SQL 写读。证据 `.backend-team/artifacts/postgresql-native-build-t21-20260915.json`。发布 manifest 仍保持 `pending-native-build`，因为本地不能提供可审计的稳定 HTTPS 下载和签名/attestation；T21 仍未勾选，下一步是外部发布服务补齐这些材料后再跑 release audit。
- 2026-09-16（本地 Profile 同步修复）：启动 `127.0.0.1:3080` 时发现临时 `web` Profile 仍加载旧 Bundle，旧代码要求已从 PostgreSQL-only runtime 移除的 `dbgate-serve`，因此启动阶段失败。已用当前 Bundle 重新升级该 Profile 并重启；HTTP 返回 200，Chrome 真实页面可见“添加图片”、模型选择、团队任务入口及任务中心中的已搁置/已完成/当前未运行任务。未执行业务审批、迁移或任务写入。
- 2026-09-16（团队执行阻塞诊断与隔离复验）：真实隔离任务首次 BUILD 在开发 Agent 发起模型请求前失败，Qwen 报 `backend_team_delegate_worker` 参数不是有效 OpenAI JSON Schema；根因是工具只声明 `additionalProperties: true`。已在 `packages/bundle/src/managed-agent-tools.ts` 改为显式 `properties/required/additionalProperties:false` schema，并新增回归测试。Schema 修复后又发现宿主对所有 developer/tester/fixer 无条件要求“编辑后成功测试”，导致只有 `inspection` 验证项的 T-01 即使返回 passed 也被误判失败；已改为仅当任务声明必需 `kind=test` 验证时启用该门禁，默认行为仍保持严格。Bundle 类型检查、相关回归与构建通过；隔离 Chrome 任务在修复后连续通过 T-01（`src/db.mjs`）、T-02（`src/validate.mjs`）、T-03（`test/validate.test.mjs`，`node --test` 21/21）和 T-04（`src/repo.mjs`/`src/domain.mjs`），随后 T-05 已启动并可通过任务进度面板暂停。未触碰冻结客户样例、真实业务审批、数据库迁移或发布材料；隔离复验记录见 `.backend-team/artifacts/local-acceptance-agent-team-20260916.json`。

## 六、已完成的具体能力

以下勾选只覆盖各条描述的能力；业务全流程和发布完成状态看上方待办。

- [x] **C01 ☑️ 模型改为 Qwen/OpenAI Responses 兼容 API，保留 DSH/Team Agent 循环。** 真实文本、工具及图片相关调用已有记录；2026-09-17 在真实 DSH 宿主通过 Qwen3.8 Flash 无工具短请求复验；见 [模型说明](docs/model-api.md) 与 `.backend-team/artifacts/qwen-real-acceptance-20260917.json`。
- [x] **C02 ☑️ 模型输出额度从 4096 调整为 131072，并验证真实短请求使用新配置。** 服务仍有硬上限，未宣称无限输出或满额压力通过；对应 R17。
- [x] **C03 ☑️ 任务中心主要入口（R01/R06）。** 工作区任务列表、搜索筛选、跨会话资源查看、当前关联及实际运行状态、接回/搁置确认已接入；见 [视觉记录](design-qa.md)。
- [x] **C04 ☑️ 统一方案资源、逐题问题与可选审批意见。** 正式宿主已有局部交互验证；整体主题/窄屏及审批来源仍看 T04/T18。
- [x] **C05 ☑️ 需求变更恢复的后端实现及组合测试。** 旧文档、审批、运行证据和检查点保留；两道审批重开；真实取消分支已验收。完整确认后交付仍看 T03。
- [x] **C06 ☑️ 只读项目识别接入规格命令。** 排除运行时、夹具与模板误报；候选脚本明确未执行。见 [项目上下文](docs/operations/project-context.md)。
- [x] **C07 ☑️ 执行计划路径预检。** 规划阶段限次修正，整份计划检查通过后建目录，基线先于建目录检查；40 项相关测试通过。见 [项目上下文](docs/operations/project-context.md)。
- [x] **C08 ☑️ JS/TS 受限 Node 测试链路。** 三种 TS 扩展名、批准证据与最终验收已实测；50 项相关测试通过。见 [开发说明](docs/operations/automatic-development.md)。
- [x] **C09 ☑️ 产物凭据检查工具、最终验收及恢复复查。** 不回显凭据，失败阻止成功交付；34 项相关测试通过。见 [开发说明](docs/operations/automatic-development.md)。
- [x] **C10 ☑️ 文件级类型检查工具。** 固定配置、受限读取、独立包实际运行；9 项相关测试通过。见 [开发说明](docs/operations/automatic-development.md)。
- [x] **C11 ☑️ 显式批准的文件类型检查交付门槛。** 失败阻断、修复重验、恢复核对证据；47 项相关测试通过。项目全量检查仍看 T10。
- [x] **C12 ☑️ 本机 PostgreSQL 与 DbGate 迁移主链路的局部验证。** 已有 GUI 修改→SQL 预览→批准→应用证据；完整 ORM/恢复与发布仍看 T13–T16。
- [x] **C13 ☑️ 本地 Bundle/profile 安装升级和正式页面恢复。** 已有重复验证；干净环境发布验收仍看 T20–T22。

## 七、延期、替换与范围外

- [ ] **D01 ☐ 已延期：Intel/x64 云端与双架构完整验收。** 用户明确“这个先不用”；包含 x64 原生制品、下载/签名及跨架构完整场景。恢复前由用户重新提出，不作为当前 arm64 推进阻塞。
- **S01 已替换：真实 DeepSeek 模型测试与 Codex App Server 接入。** 用户后续选择 Qwen 模型 API；真实 Qwen 局部调用在 C01，完整团队业务验收在 T06。原路线不冒充已完成，也不继续开发。
- **S02 V1 范围外：Windows/Linux、业务生产数据库和业务生产部署。** 产品 Bundle 的发布仍在 T20–T22。

## 本轮记录

- 2026-09-20（阻塞方案固化）：复核 T16/T19/T20/T21/T22 后确认它们不是同一个代码故障：T16/T21 缺少外部双架构 provenance、签名/attestation 和稳定 HTTPS 下载；T20 缺少受保护生产激活组合的 provenance；T19 缺少同一 Profile/Bundle/模型下的完整 Chrome 矩阵；T22 依赖签名 release candidate 才能完成干净 Profile 生命周期。已新增 [发布阻塞处置方案](docs/operations/release-blockers.md)，写明根因、解除顺序、命令边界和不能由本机伪造的材料；本地 Bundle sidecar、Node24 验证、3080 宿主恢复证据沿用上一条记录。下一步按文档第 1–4 步取得外部发布材料后，再回补 T16/T21，并以同一发布组合推进 T19/T20/T22。

- 2026-09-15（继续推进 T13）：在同一隔离 DSH `web` Profile 会话中打开 DbGate 7.2.3，完成 `gui_migration_accounts(id serial primary key, email text)` 的 GUI 建表、SQL 预览和落库；同一 `sessionId` 生成迁移审批卡，Codex Chrome 查看完整 `migration.sql` 后确认，宿主将 ORM `schema.ts` 原子写入并应用 SQL。独立 PostgreSQL 查询回读 `true|id,email`，状态回报 `pendingApproval=null` 且 `migrationMessage=数据库迁移已应用，备份与迁移文件已保存。`。证据 `.backend-team/artifacts/formal-host-t13-same-session-20260915.json`；仅使用临时 Profile/工作区/数据库，T13 完成，下一步转入 T14 正式宿主重启恢复证据。

- 2026-09-14（继续推进 T19→T21）：真实 Codex Chrome 只读核对确认 3080 任务中心可见全部历史/当前任务、状态筛选和并列资源区；工作区 Node 24.19.0 复跑 E2E 7 个文件 16/16、生产 Bundle/Agent 接线 12 个文件 81/81；归档参数复核 checksum/SBOM 通过。T19/T20/T21 仍分别因正式生产组合、Harness provenance、真实模型、双架构制品、签名下载和 DbGate 依赖风险保持部分/阻塞，未执行审批、迁移、业务写入或发布。

- 2026-09-14（继续推进 T14）：修复共享待审批迁移文件造成的跨任务误消费；任务宿主现在按 `taskId` 隔离持久记录并保留 legacy 路径。Node24 相关回归 20/20、Bundle 类型检查、构建、打包和 Profile 升级通过。隔离临时 DSH 在损坏任务记录下重启成功，Codex Chrome 显示“已受阻”、可查看技术详情，且 `sqlApplied=false`；证据 `.backend-team/artifacts/migration-recovery-failure-chrome-t14-20260914.json`。正式 3080 页面重启后仍可访问，未改变客户任务或执行数据库写入。下一步补 T14 有效确认卡与过期/篡改记录真实宿主证据。

- 2026-09-14（继续推进 T17 模型链路）：在真实 DSH Chrome 的新建隔离会话中，通过“添加图片”选择有效 PNG 并发送短请求，Qwen3.8 Flash 成功返回图片描述；会话未关联团队任务，未写业务文件。首次使用的 `host-narrow.png` 实际为 JPEG，宿主按格式拒绝，已将该验收夹具转换为真实 PNG 并复核文件类型。T17 现在只剩正式宿主拖入证据，T06/T19 业务主流程仍未完成。
- 2026-09-14（继续验证 T17）：Node 24 下附件入口与模型发布门禁回归共 2 个测试文件、10 项通过；真实 Chrome 控制台无 warn/error。当前 CUA 只提供文件选择器和鼠标拖动，无法从本地文件管理器向网页合成系统级文件拖入，因此不伪造 T17 的拖入通过。
- 2026-09-14（继续修复 T18 窄屏）：真实 DSH Chrome 390×844 复验发现注入的长文本按钮挤压宿主标题栏；新增窄屏专用图标按钮样式并重建/升级 Profile。复验确认按钮文字在窄屏隐藏但无障碍名称保留，顶部元素不重叠且页面无横向溢出；默认桌面视口保留文字按钮。相关 Web/Bundle 类型检查、构建、Web 资源/任务/附件/覆盖层回归 20 项与 `git diff --check` 均通过。
- 2026-09-14（逐项核对 T04）：真实 DSH Chrome 任务中心列出工作区全部任务（已搁置、已完成、未完成和早期记录）；进入已完成的人员管理任务并展开“审批记录”，两条历史记录均明确显示“来源未知（历史记录未保存来源）”及文档哈希摘要。资源预览与聊天并列，查看过程未触发执行或改变任务归属。当前没有新的待审批记录，因此 T04 仍等待一次带真实会话/任务来源的新审批产生后复验。
- 2026-09-14（逐项核对 T05→T06）：只读 doctor 新报告确认环境依赖齐全，但客户管理任务预算已耗尽，恢复建议为 `inspect-state`。T06 的正式端到端流程因此保持未启动；没有重试旧任务、覆盖任务、代审批或执行任何业务写入。下一步需先完成可审计的预算恢复/任务处置，再进入 T06 的真实模型与正式宿主验收。
- 2026-09-14（T06 前置 UI 门禁）：真实 Chrome 任务中心可查看客户管理任务的资源和历史操作，但页面将其标为“其他会话的任务 · 仅查看”，当前会话名称搜索无匹配；“接回当前对话”和“搁置任务”均为可用的显式操作，本轮只读取按钮状态，未将旧任务接入图片验收会话。
- 2026-09-14（逐项核对 T07）：Node 24 下运行多服务项目分析、边界解析、项目上下文测试，4 个文件 41 项通过；未启动真实业务任务，真实正式宿主的候选选择确认仍待补。
- 2026-09-14（逐项核对 T08）：Node 24 下真实运行空目录模板隔离验收，2 个文件 2 项通过；实际完成模板哈希校验、目标 Node/npm、依赖安装、typecheck、build 与 health 基线测试，宿主 shell/profile 与外部 PATH 未被修改。T08 已勾选完成。
- 2026-09-14（逐项核对 T09）：Node 24 下命令工具、命令执行器和审批令牌回归共 3 个文件 51 项通过；真实工作区未批准或执行安装/迁移命令，T09 保持等待正式宿主授权证据。
- 2026-09-14（逐项核对 T10）：Node 24 下运行全部 workspace 的 typecheck、build、lint 均成功；项目脚本映射与成功/缺失脚本状态测试通过。T10 已勾选完成。
- 2026-09-14（逐项核对 T11）：Node 24 直接运行 Web 客户端、DSH 生产端口、Agent runtime 和 PostgreSQL execution 门禁均通过；安全/契约/最终验收回归 7 个文件 39 项通过。修复了 Agent runtime 验收夹具缺失完整任务契约的问题，T11 已勾选完成。
- 2026-09-14（逐项核对 T12）：Node 24 下 Agent topology、managed Agent 委派、DelegationGuard 和 capability intersection 回归共 4 个文件 19 项通过；真实模型委派尚未在正式宿主中执行，T12 保持待验收。
- 2026-09-14（逐项核对 T13）：隔离 Chrome 迁移审批页面完成一次批准和清理，临时 PostgreSQL 库验证 0→1 张表；随后真实 DbGate 7.2.3 在临时设计库创建 `gui_migration_accounts` 并回读 `id/email`，真实 PostgreSQL arm64 回归验证 ORM 审批前不写入、批准后原子落盘、数据保留和结构漂移拒绝。证据为 `dbgate-gui-acceptance/gui-migration-evidence-20260914.json` 与 `native-migration-orm-t13-20260914.json`；正式宿主同会话接线仍待补，T13 保持待完成。
- 2026-09-14（继续核对发布门禁）：使用工作区 Node 24 运行 `verify-postgresql-runtime.mjs`，按当前 `runtime-manifests/postgresql-18.6-darwin.json` 如实返回 `INCOMPLETE_RUNTIME_PROVENANCE`（manifest 仍为 `pending-native-build`，无原生 artifacts）；没有把本机 arm64 临时运行结果升级为发布证据。同步复跑 Web/Bundle 类型检查与 `git diff --check`，均通过。T16/T20–T22 继续保持未完成，下一步仍需真实发布材料、生产协调器/模型/DbGate 门禁及干净 Profile 生命周期证据。
- 2026-09-14（继续推进 T17/T05）：重新打包并升级本地 `web` Profile，重启真实 DSH 3080 宿主；Codex Chrome 中确认“添加图片”入口可见，载入仓库内非敏感 `host-narrow.png` 后显示待发送缩略图和移除按钮，清理后草稿为空。未发送消息、未调用模型、未改变任务状态。同步运行 `backend-team-doctor`，真实报告识别当前客户管理任务为 BUILD/revision 21、预算耗尽维度为 tokens/wallMs，恢复建议为 `inspect-state`；因此 T05 仍不勾选，避免对历史耗尽任务重复启动。

- 2026-09-14（Agent Team T17）：沿用 DSH rc.6 的官方附件链路，新增 `conversation.input.left` 的 shadcn 局部“添加图片”入口。选择文件后调用宿主 `conversation.createDraftImages()`，再经当前会话 `inputActions.addImages()` 纳入草稿；会话拒绝时立即释放浏览器临时附件，错误通过局部告警展示。官方 InputBar 原有的粘贴、拖入、预览、取消和发送序列保持不变。新增隔离回归 2/2，Web/Bundle 类型检查与构建、相关 ESLint、`git diff --check` 通过；正式 DSH Chrome 中的真实选择、拖入和模型请求证据仍待 T17/T19 验收。

- 2026-09-14（Agent Team T13–T15）：补齐数据库结构同步、迁移审批持久恢复和快照安全边界。新增 `OrmSchemaSynchronizer`，将生成的 ORM 源码纳入同一 hash-bound 迁移审批，批准后原子写入并在迁移失败时尝试回滚；新增 `FileMigrationReviewStore` 持久化待审批迁移，生产宿主保存并校验 DbGate 设计会话，重启后先启动工作区 PostgreSQL 再重建同一审批；`DatabaseSnapshot` 增加清单列出、私有 dump/哈希核验、loopback 目标及可选空库检查后恢复。数据库类型检查、构建、Bundle 类型检查和 3 个聚焦测试文件共 28 项通过；Bundle 构建通过。`workflow-host` 已接入启动恢复，但真实 GUI 修改、真实数据库恢复、重启页面和发布材料仍未验收，T13–T15 保持未勾选。`workflow-host.test.ts` 在当前 Node 运行环境因既有 `execa` 的 `TEXT_ENCODINGS.union` 兼容错误未能执行，不把该环境失败归因于本轮代码。
- 2026-09-14（Agent Team T14）：迁移审批/恢复回归共 9 项（含中断集群诊断）通过；新增篡改待审批记录的安全清理，验证旧 revision、应用失败、宿主重启恢复和原生 PostgreSQL 结构漂移拒绝。Bundle 类型检查、相关 ESLint 与 `git diff --check` 通过；真实 DSH 宿主重启后的确认卡和恢复失败页面仍待补。
- 2026-09-14（Agent Team T15）：真实 PostgreSQL 18.6 arm64 隔离验收完成快照→清单→新空库恢复→数据读取，并验证篡改 dump 被哈希校验拒绝；证据为 `.backend-team/artifacts/postgresql-snapshot-t15-20260914.json`。修复 `DatabaseSnapshot` 传递受管数据库用户，数据库服务回归 19 项通过；正式资源面板的备份/恢复操作仍待真实宿主验收，T15 保持未勾选。
- 2026-09-14（Agent Team T16）：本机 arm64 PostgreSQL 18.6 archive 生命周期与恢复复验通过，SHA-256 `2c91690995dab19f4193b60297a4070f9c28df96bcf2711a49dcc48d6bae4ec0`，证据 `.backend-team/artifacts/postgresql-execution-t16-20260914.json`；manifest 检查明确因 `pending-native-build` 失败。x64、正式下载地址、签名/attestation 仍需发布系统提供，T16 保持未勾选。
- 2026-09-14（Agent Team T17）：真实 DSH Chrome 中将对话内 `compare-review.png` 拖入 composer，DOM 显示“待发送图片”且发送按钮可用，移除后草稿为空；证据 `.backend-team/artifacts/image-drag-chrome-evidence-20260914.json`。结合已有文件选择和图片模型请求证据，T17 已勾选；本地文件系统拖拽无法由当前浏览器接口直接模拟，已记录为限制。
- 2026-09-14（Agent Team T18）：真实 DSH Chrome 深色主题下复验聊天与任务资源并列、需求文档预览和审批历史来源展示，`document/body.scrollWidth=1920`，证据 `.backend-team/artifacts/t18-dark-resource-chrome-evidence-20260914.json`；390px 窄屏浅色证据沿用前次记录，深色窄屏待审批矩阵仍未取得，T18 保持未勾选。
- 2026-09-14（Agent Team T19）：在真实 DSH Chrome 打开任务中心并核对全部工作区任务、当前任务标记、状态筛选和聊天/资源并列；建立十项浏览器交互与十个 `scenarios.ts` 场景的逐项矩阵，真实宿主、隔离验收和发布阻塞分别标为 `passed/partial/blocked/not-run`，证据 `.backend-team/artifacts/browser-acceptance-matrix-t19-20260914.json`。T19 仍未勾选，后续按矩阵补 T13–T16、T20–T22 的正式接线、发布材料和干净 Profile 生命周期证据。
- 2026-09-14（Agent Team T20）：Node24 下官方 Agent runtime 与 DSH Host/Session/Agent 端口验证均通过，Bundle 生产激活/独立生产加载回归 60 项通过；打包验收先暴露固定文件清单、第三方工具内容扫描、客户端 DOM/React 夹具和新增公开导出的契约漂移，已逐项修复并复验 `packed Bundle verified`。证据 `.backend-team/artifacts/production-wiring-t20-20260914.json`。T20 仍未勾选，原因是官方生产 provenance、真实协调器/模型和同一组合 Chrome 全流程仍受门禁限制。
- 2026-09-14（Agent Team T21）：发布脚本补齐材料绑定链路。`build-release.mjs` 现在随 Bundle 生成匹配的 `.sha256`、CycloneDX 1.5 `.cdx.json` 和 `.materials.json`；`verify-release.mjs` 校验 archive/SBOM/package-lock/Bundle package/许可证说明摘要及归档许可证文件，并在 `release-candidate` 频道拒绝未验证签名或缺稳定 HTTPS 地址的材料。新增只读 `audit-release-materials.mjs`，对当前本地制品逐项核对：checksum/SBOM、许可证和 DbGate 版本通过；PostgreSQL 双架构 provenance、DbGate 安全门禁、签名和稳定下载地址阻塞。当前材料和审计记录在 `.backend-team/artifacts/release-materials-t21-20260914/`，release artifact 回归 7/7、脚本 ESLint 与 `git diff --check` 通过。T21 保持未勾选，下一步推进 T22 干净 Profile 生命周期证据。
- 2026-09-14（Agent Team T22）：新增 `profile-lifecycle-smoke.mjs` 并在真实 rc.6 DSH、临时 arm64 Profile 中完成官方安装、诊断使用、0.1.1 升级、remove+0.1.0 回滚恢复和卸载；全过程只写临时 `DSH_HOME`/store/workspace，工作区哨兵文件前后字节摘要一致，唯一 `backend-team` 行在安装/升级/恢复时保持不重复。证据 `.backend-team/artifacts/profile-lifecycle-t22-EBa4rL/result.json`；脚本实际 `passed`，Node 24.19.0 arm64，脚本 ESLint 与 `git diff --check` 通过。生产浏览器/模型十场景、x64 和签名 release candidate 未覆盖，T22 仍保持未勾选，下一步继续处理 T13–T16/T18–T20 的真实外部门禁。
- 2026-09-14（继续推进 T15/T14）：快照清单已接入正式宿主资源链路；发现清单读取异常会把整个资源接口打成 500 后，改为失败时返回空清单，需求和设计文档继续可查看。重新构建、打包、升级本地 `web` Profile 并重启 DSH；Codex Chrome 真实复验任务中心列出 4 个工作区任务，当前任务资源预览显示“数据库备份 / 暂无备份 / 备份原因 / 立即备份”，聊天与资源面板并列。证据 `.backend-team/artifacts/database-snapshot-resource-chrome-evidence-20260914.json`，视觉记录写入 `design-qa.md`；快照/资源/控制回归 11 项、迁移恢复/宿主恢复/PostgreSQL 集群回归 25 项通过，`git diff --check` 通过。为避免替用户在真实客户任务上写入数据库，本轮未点击备份或恢复；T15 仍待隔离真实备份/恢复结果，T14 仍待真实重启确认卡与失败恢复页面，T13 同会话接线及 T16、T19–T21 外部门禁继续保留。
- 2026-09-14（继续推进 T14 恢复失败边界）：将迁移恢复异常从“宿主启动失败”改为“宿主可访问、任务受阻并保留诊断原因”；同时修复宿主第一次读取损坏 JSON 时的错误包装，统一显示“待审批迁移记录无效，已阻止恢复”。进度模型回归验证该错误会显示为“已受阻”，下一步为“查看技术详情并处理阻塞原因”。Node24 `workflow-host`、迁移恢复、会话宿主和进度模型共 19 项通过；隔离真实宿主演练通过并记录于 `.backend-team/artifacts/migration-recovery-failure-host-t14-20260914.json`，相关 ESLint、类型检查、构建和 `git diff --check` 通过。真实 Chrome 重启后任务中心与当前任务资源仍可查看，但当前没有待审批迁移，故未把普通状态保留冒充 T14 的确认卡/失败恢复页面通过。
- 2026-09-14（继续核对 T13）：真实 Codex Chrome 中启动隔离 DbGate 7.2.3，创建 `gui_migration_accounts` 表并增加 `email text` 字段，确认生成的 `CREATE TABLE` SQL 后落库；通过独立查询回读表和字段，监听器保持 `127.0.0.1`，证据 `.backend-team/artifacts/dbgate-gui-acceptance/gui-migration-evidence-20260914.json`。同时扩展原生迁移回归，真实 arm64 PostgreSQL 验证审批前 ORM 未写入、批准后 `schema.ts` 原子落盘、数据保留和结构漂移阻断。正式宿主同一会话的 DbGate→迁移审批接线仍待补，T13 保持未勾选。
- 2026-09-14（继续推进 T13）：真实 Codex Chrome 隔离 DbGate 设计库完成 `gui_migration_accounts(id serial primary key, email text)` 的 GUI 建表、SQL 预览和落库；补回未变更的开发基线后，固定 Drizzle 生成唯一迁移 `0001_serious_raza`，隔离批准流程完成备份、ORM `schema.ts` 原子写入、SQL 应用及表/字段回读。证据 `.backend-team/artifacts/dbgate-gui-acceptance/gui-migration-generated-20260914.json`，JSON、脚本语法和 `git diff --check` 均通过。正式生产宿主同会话接线和用户审批仍未执行，T13 继续保持未勾选。

- 2026-09-14（Agent Team T09–T12）：补齐生产 Agent 的受控命令与受限委派入口。`packages/bundle/src/managed-agent-tools.ts` 新增可选 `backend_team_command`（工作区相对路径、无 shell、默认拒绝网络、安装/迁移能力和短期批准令牌、阶段/预算/审批前后复核）及 `backend_team_delegate_worker`（仅直接专家且存在活动委派回调时注册）；`production.ts`/`backend-team-plugin.ts` 暴露宿主命令边界。`packages/verification/src/project-verification.ts` 从实际 package scripts 生成 typecheck/build/lint argv 并经 `VerificationEngine` 执行，缺失脚本显式列出；`comprehensive-security-verification.ts` 汇总本地凭据/代码气味、依赖、认证授权及宿主提供的数据库/API/契约检查，并要求必需检查通过；`final-development-verification.ts` 支持注入项目级与完整安全验证报告，写入最终报告并在失败时阻断交付。验证：Bundle/Verification 类型检查通过，Bundle managed tools、standalone production、project verification、comprehensive security 共 33 项通过，Bundle 构建和 `git diff --check` 通过。T08 的真实空目录下载验收仍受临时夹具外部运行时下载阻塞；T09–T12 的真实宿主批准、项目脚本、数据库/API 证据及模型委派验收仍待对应宿主配置后执行。

- 2026-09-14：客户管理 S-1 的 T-03 自动 handoff（seq65）再次在 600000ms 墙钟窗口结束时失败，未形成可接受的 tester 证据。核对实际文件后确认 T-01/T-02 已存在，T-03 旧文件仍为重复领域规则；已直接重写 `src/customers/application/create-customer.ts` 为 `Customer.create` → `CustomerInsertInput` 的单次落库编排，并修正 T-02 `phone_key` 的 `null` 类型收窄。三文件 NodeNext strict 类型检查及临时编译后的真实 Node 烟测通过（合法创建、归一化、字段错误、失败不落库）；计划声明的 `test/customer-model.test.mjs` 尚不存在，未伪造该证据。调度器依赖可见性测试、development 类型检查、Bundle 构建/打包和 web Profile 升级已通过；未执行迁移、真实数据库变更或发布。下一步由宿主重新核对 T-03 后继续 T-04～T-06。

- 2026-09-14（本轮）：宿主 seq68 已落地 T-05 `src/customers/api/create-customer.ts`，随后因 Agent result failed 结束；未接受宿主失败为完成或代码失败。主任务补齐 T-06 `test/customer-model.test.mjs`，用 Node24 真实运行 4/4 通过，覆盖 T-01/T-02/T-03、T-04 loopback 应用及 T-05 POST 201/422 契约；五个客户源文件 NodeNext strict 类型检查通过。已将证据发送回真实宿主，要求核对并收口 T-03～T-06，再进入 T-07；未修改 `tasks.md`，未执行迁移、真实数据库变更或发布。

- 2026-09-14（自动继续）：宿主 seq69 在 20 分钟窗口内因 declared token budget exhausted（1,350,337 > 1,000,000）阻塞，随后自动续起 seq71；在没有新切片证据的情况下停止无进展回合，避免继续消耗。按清单推进客户切片 T-07～T-10：新增 `src/customers/domain/phone-key.ts`，以 `regexp_replace(phone, '[^0-9+]', '', 'g')` 等价语义生成唯一键；`MemoryCustomerRepository.insert` 增加电话唯一冲突及已有客户摘要；创建用例透传冲突；创建路由映射 409 `CUSTOMER_PHONE_TAKEN`。Node24 `test/customer-model.test.mjs` 共 26/26 通过，客户源文件 NodeNext strict 类型检查和 `git diff --check` 通过。T-03～T-10 的官方切片账本仍为空，代码和隔离证据待宿主接纳；未修改 `tasks.md`，未执行迁移、真实数据库变更或正式发布。

- 2026-09-14（自动继续）：按清单推进客户 S-3 的 T-15～T-17/T-19。内存仓储新增名称/联系人/电话关键词匹配及稳定分页；新增 `src/customers/application/search-customers.ts` 做关键词 trim、page/pageSize 校验和 CustomerPage 映射；新增 `src/customers/api/search-customers.ts` 提供 GET 查询路由、参数 400 错误和挂载函数。`test/customer-model.test.mjs` 当前 29/29 通过，客户源文件 NodeNext strict 类型检查和 `git diff --check` 通过。PostgreSQL 查询仓储（T-18）未实现，官方 `customer-search-test` 账本仍待宿主接纳；未执行迁移、真实数据库变更或正式发布。

- 2026-09-14（自动继续）：按清单推进客户 S-4 的 T-20～T-23。新增 `src/customers/support/redaction.ts`（电话/邮箱脱敏）、`src/customers/domain/changelog.ts`（字段白名单与脱敏值对象）、`src/customers/application/get-customer.ts`（详情读取与 CustomerNotFound）和 `src/customers/api/customer-detail.ts`（GET 详情、404、ETag）。`test/customer-model.test.mjs` 当前 33/33 通过，客户源文件 NodeNext strict 类型检查和 `git diff --check` 通过。更新事务、真实变更表和 PostgreSQL 适配尚未实现；官方 `customer-update-test` 账本仍待宿主接纳；未执行迁移、真实数据库变更或正式发布。

- 2026-09-14（自动继续）：按清单推进客户 S-4 的 T-24/T-25。新增 `src/customers/application/update-customer.ts`（领域更新、If-Match 版本结果、电话冲突与 ChangeLog 组合写入）和 `src/customers/api/update-customer.ts`（PATCH、412/409/422、ETag）；内存仓储补充更新电话唯一守卫、留痕读取与原子组合写入。修复测试装载器的递归 TypeScript 依赖改写后，`test/customer-model.test.mjs` 共 36/36 通过；客户源文件 NodeNext strict 类型检查和 `git diff --check` 通过。T-26/T-27 PostgreSQL 命令仓储及真实事务尚未实现，官方 `customer-update-test` 账本仍待宿主接纳；未执行迁移、真实数据库变更或正式发布。

- 2026-09-14（自动继续）：按清单推进客户 S-5 的 T-29/T-30。新增 `src/customers/application/list-changes.ts` 与 `src/customers/api/customer-changes.ts`，提供按客户编号分页的脱敏历史、total、404 和非法分页 400；内存仓储暴露留痕读取。修正同一更新时间下按领域字段顺序保留的回归断言后，`test/customer-model.test.mjs` 共 38/38 通过；客户源文件 NodeNext strict 类型检查和 `git diff --check` 通过。T-26/T-27/T-33 PostgreSQL 命令与历史仓储尚未实现，官方 `customer-change-log-test` 账本仍待宿主接纳；未执行迁移、真实数据库变更或正式发布。
- 2026-09-14（自动继续）：按清单先收口客户模块装配缺口。新增 `src/customers/api/module.ts`，显式注入仓储、当前用户、时钟和电话归一化器，并把 POST/查询/详情/PATCH/变更历史五个端点接入同一 `createCustomersApp`；Node24 loopback 连续调用回归由 38/38 增至 39/39，客户源文件 ESLint、NodeNext strict 类型检查和 `git diff --check` 均通过。未修改 `tasks.md`，未执行迁移、真实数据库变更或正式发布。下一步仍是先确认客户 Schema/Drizzle 事务边界，再决定是否进入 T-26/T-27。
- 2026-09-14（范围校正）：确认上一轮提前处理了客户样例的 T-05/T-06 装配缺口，偏离了当前 TODO 的 Agent Team 主流程。客户样例代码及 `test/customer-model.test.mjs` 现冻结为验收夹具；后续开发回到 Agent Team 本身，按 T04→T05 推进，不把样例代码或其隔离回归当作 Agent Team 完成证据。
- 2026-09-14（Agent Team T04）：修复 Web 事件投影遗漏审批历史的问题。新的 `approval-recorded` 事件现在会写入来源状态和文档哈希，并替换同一审批类型的旧投影，避免实时审批完成后资源/进度视图仍为空。事件投影、面板、进度和待审批回归 20/20，Web 类型检查、相关 ESLint 和 `git diff --check` 通过。真实需求仍等待用户本人批准，未代办审批或迁移；下一步继续核对 T04 的真实新审批来源展示，之后进入 T05。

- 2026-09-14（Agent Team T07）：补齐多服务项目边界的显式选择信息。项目分析结果保留 `ServiceBoundaryDecision`，规格上下文暴露候选服务、评分和证据路径；多个候选时要求 Agent 在需求确认中让用户选择，选择前不生成业务写入计划；显式选择只接受 manifest-backed、工作区内且无敏感/符号链接逃逸的路径。项目分析、服务边界和规格上下文 40 项通过，project-analyzer 构建/类型检查、Bundle 类型检查、相关 ESLint 与 `git diff --check` 通过。客户样例继续冻结；真实宿主中的多服务选择仍待实际项目触发验收。

- 2026-09-13：自动测试真实 DSH 页面时发现 319×881 窄视口下需求审批卡的图标、文案和按钮被强制排在一行，文案区仅 23.59px，出现逐字竖排。已在 `packages/web/src/ui/theme.css` 为 399px 以下视口增加响应式换行：图标与文案保留首行，确认按钮独占下一行并铺满卡片；重建 Bundle、打包、升级 `web` Profile 并重启 3080。新 Tab 在同一 319×881 视口复验：卡片宽 222.63px、文案宽 138.63px、按钮宽 180.63px、`flex-wrap=wrap`，页面无横向溢出（`scrollWidth=319`），未再出现竖排。相关 8 个 Bundle/Web 回归 23/23 通过；T04 仍等待用户本人批准需求，T18 全矩阵验收未完成。

- 2026-09-13：T04 等待用户审批期间转入 T05。doctor 真实只读检查已生成 `.backend-team/artifacts/doctor-t05-current.json`：正确识别客户管理任务 `9dca7f07-d6da-4096-b41a-ecf4cbc51883`、`AWAIT_REQUIREMENTS_APPROVAL`、revision 11；50 条预算记录中 13 条为耗尽，新增 `budget.blockedDimensions=["tokens"]` 和可操作提示；当前恢复建议仍为 `preview-and-confirm`，没有自动恢复、批准、安装或迁移。补充 doctor/profile 4 个集成文件共 14/14 通过，脚本 ESLint 与 `git diff --check` 通过。T05 仍未勾选，原因是实际恢复动作必须等待审批门禁，下一步继续补齐隔离恢复验证。

- 2026-09-13：继续 T05，修复诊断状态指向旧任务的问题。doctor 现在读取会话任务注册表及对应 `state-<taskId>`，选择唯一未完成任务并使用该任务的检查点；多个未完成任务时返回 `inspect-state`，要求先处理当前对话中的任务冲突。Node 24 下 doctor 集成 5 项通过；真实报告正确指向客户管理任务 `AWAIT_REQUIREMENTS_APPROVAL` revision 9，并给出 `preview-and-confirm`，不再误报 greeting 的 VERIFY revision 23。未自动恢复、未批准需求或执行迁移。

- 2026-09-13：完成 T04 持久审批恢复阻塞修复。根因是 durable phase 恢复后，控制审批端的 pending request 仍只在内存中，且会话任务宿主曾未绑定调用 DSH `userQuestions.ask`，重启后只能显示“需求待确认”而没有真实确认入口。现由生产宿主在存在 DSH `userQuestions` 时按 durable phase 重建审批，再由会话任务宿主桥接为逐题需求/设计确认，保留可选意见、版本校验和用户最终批准；关闭时吞掉预期中止拒绝，避免重启异常。Node 24 下相关 4 个测试文件 33 项通过；Bundle 构建、打包、Profile 升级、`git diff --check` 通过。重启后的真实 Chrome 已显示“需求确认 1 / 3”、Q1–Q3、选项、补充说明和“下一题”，未代用户答题或批准；下一步等待用户完成需求确认后再验收设计审批来源记录。

- 2026-09-13：继续推进 T05 的可执行恢复边界。发现 doctor 在 BUILD/VERIFY 仍可能因已有通过切片而建议 `continue`，即使账本已有耗尽记录；现改为 `inspect-state`，要求先核对耗尽维度和对应任务，待审批阶段仍优先 `preview-and-confirm`。补充预算耗尽和待审批阶段回归，doctor 集成 3 项通过，脚本 ESLint 与 `git diff --check` 通过；未自动恢复、未批准审批、未启动服务。

- 2026-09-13：继续 T04 实际页面复验。使用 Codex Chrome 插件在真实 DSH 打开人员管理任务资源，展开“审批记录”后确认两条历史审批均显示“来源未知（历史记录未保存来源）”及文档哈希摘要；审批记录默认折叠，资源面板与聊天并列。当前工作区没有新的待审批记录，未发送消息、未改变任务归属、未代用户审批或执行迁移；T04 仍等待一次真实新审批页面进入待确认状态后的来源展示验收。设计证据已写入 `design-qa.md`，下一步仍为 T04 新审批真实验收，无法独立生成时再转入 T05 恢复执行。

- 2026-09-13：继续 T04 真实任务中心复核。总览确认工作区历史任务可见：greeting 与客户管理任务为已搁置，人员管理任务为已交付且属于当前对话，早期记录为未完成；查看任务资源未触发执行。进入需求确认记录后，审批记录仍为两条历史记录，均明确显示来源未知和文档哈希；当前无新的待审批记录，未改变任务归属、未批准审批或执行迁移。该证据补充到 `design-qa.md`，T04 的真实新审批仍待业务任务进入待确认阶段。

- 2026-09-13：继续核对 T04/T05。审批来源链路补齐认证会话、任务 ID 与文档哈希的持久化回归；doctor 扩展为只读环境/依赖/预算/检查点诊断并提供受约束恢复建议。审批服务、生产命令、视图模型和面板模型 33 项，doctor/profile 集成 7 项通过，相关 lint 与 `git diff --check` 通过。真实工作区诊断发现预算账本存在 13 条历史耗尽记录并明确提示先检查原因；未重写历史记录、未执行真实审批或自动恢复。T04 仍等待一次真实新审批页面验收，T05 仍需真实任务按建议完成一次恢复操作。

- 2026-09-13：按用户授权代选需求澄清项，真实 DSH Chrome 逐题提交 Q1–Q3 推荐项（最小字段集合、联系电话唯一、授权人员均可修改）；系统已将结论写回 `spec.md`/`clarification.md`，并重新生成需求审批卡。真实页面当前显示“需求审批 / 查看并确认”，未代用户批准；下一步由用户本人在该入口查看完整方案并批准，之后继续设计重审与来源记录验收。

- 2026-09-13：完成 T24 运行循环诊断与修复。确认墙钟计时晚于 Agent 创建、超时未写入预算账本、生产端未区分墙钟超时及同一终态任务可重新注册是主要根因；调度器现覆盖创建/连接/结果阶段并持久化超时用量，生产运行记录保留 `blocked` 原因，账本拒绝终态重注册并显示耗尽维度，已通过切片逐片写入检查点，`wait` 读取真实运行状态。补充 running 状态等待回归。预算/调度/生产 41 项、开发恢复 25 项、对话与任务宿主 35 项通过；Agent Team/Core/Bundle 类型检查、相关 ESLint 与 `git diff --check` 通过。全量 Vitest 仍保留 3 项与本改动无关的既有基线失败（旧开发恢复夹具、隔离 Bundle 外部 React 依赖），未伪造历史账本记录或运行 600 秒真实任务。下一步进入 T04 新审批来源的真实页面验收。
- 2026-09-16（团队执行阻塞修复）：真实隔离 Chrome 复现 T-05 因累计模型用量 `1,452,870 > 1,000,000` 进入 `blocked`；宿主重启后原实现只恢复文档状态，没有恢复开发运行失败原因，页面错误显示“可以开始”。现已让协调器持久化调度/校验失败，宿主从最新终态事件恢复受阻状态，并在用户明确点击“恢复任务”时清理旧错误、按检查点和已存在文件继续。顶层预算错误改为“task budget exhausted”，避免把普通任务写成“父任务”。本轮 Core/Agent Team/Development 聚焦回归 4 文件 44 项、Bundle 4 文件 55 项通过，类型检查、构建、`git diff --check` 通过；Chrome 已验证“重启显示受阻 → 恢复后进入运行态”，随后为避免重复消耗模型额度主动安全暂停隔离任务，未提前宣称 T-05 后续完成。

- 2026-09-16（T25 宿主接线边界）：新增 `LongTaskExecutionSession` 作为生产中立的 execution kernel 接线层，并让隔离 LangGraph kernel 通过它访问上下文、工具幂等和预算。它要求先取得宿主跨进程运行锁、核对现有 `OwnershipManager` 的读写租约，再加载 ContextManager checkpoint；会话内串行化上下文与工具操作，完成工具按幂等键只执行一次，模型/压缩 token 同时进入窗口预算和可选的 `DurableBudgetLedger`。Agent Team 会话回归 5/5、Development 使用真实 `FileDevelopmentCheckpointStore` 运行锁回归 1/1、LangGraph spike 4/4 通过；生产 Bundle 尚未接入，T25 保持未勾选，下一步是正式 Agent runtime 的真实模型请求接线及跨进程故障注入/生产依赖审计。
- 2026-09-16（T25 正式 runtime 边界）：`HarnessAgentRuntime` 增加可选 `executionSessionFactory`，真实 DSH Agent 仍负责模型请求，会话只负责在创建前记录 prompt、准备上下文，在 assistant/message 后记录 transcript 并计入实际 token，格式修复/取消统一走关闭流程；Bundle/DSH 只透传显式工厂，不默认启用会话。新增 LangGraph 子进程 SIGKILL 运行锁恢复回归，统一升级直接使用的 `yaml` 到 2.9.1；Harness 82/82、LangGraph 5/5、工作区生产依赖 audit 0 vulnerabilities、Bundle 类型检查/构建及相关 lint 通过。T25 仍保持未勾选，下一步是接入正式宿主切片生命周期并解决共享运行锁的重入边界。
- 2026-09-16（T25 进程内锁共享）：新增 `SharedLongTaskRunLease`，在保持底层跨进程互斥的前提下，对同一宿主内的并发会话做引用计数和幂等释放；并发回归确认底层锁只获取/释放一次，最后一个会话结束后才释放。Agent Team 会话回归 6/6、类型检查、lint 和 `git diff --check` 通过。T25 仍保持未勾选，下一步是把会话工厂和共享锁接到正式宿主切片生命周期。
- 2026-09-16（T25 正式宿主共享锁）：配置了 development execution 的文档工作流宿主现在把长任务会话工厂接到真实切片运行；开发运行与嵌套 Agent 通过 `SharedLongTaskRunLease` 共用同一跨进程锁，规格 Agent 无持久源代码租约时明确跳过绑定。Bundle 生产入口与工作流宿主类型检查、长任务绑定/宿主回归通过；T25 仍保持未勾选，下一步是用真实 DSH Agent Team 切片取得 checkpoint、实际 token 计账和重启恢复证据。
- 2026-09-16（T25 上下文预算边界）：`HarnessAgentRuntime` 的长任务墙钟起点前移到会话打开前，上下文准备超时会关闭会话且不启动模型；绑定会话的 `hostUsage.wallMs` 覆盖上下文准备耗时。Harness 全量回归 83/83，T25 仍保持未勾选。

- 2026-09-12：继续推进 T03。定位真实宿主 `STALE_VIEW` 根因是持久化 revision 23 与缓存事件投影 revision 22 不一致；控制服务新增权威 durable revision 读取，Bundle 正式宿主接入同一状态源，并为关闭时的进行中控制调用增加 drain。补齐最终验证的人员模块伴随源码路径，避免 Node 24 权限边界把合法依赖误判为缺失。Web 控制回归 14/14、Bundle 边界与最终验证 16/16 通过；Web/Bundle 类型检查、Bundle 构建与打包通过；Profile 已升级并重启。
- 2026-09-12：真实宿主以 revision 25 恢复运行，最终进入 DELIVER revision 27。`.backend-team/final-verification-cqAQHW/report.json` 显示 AC-001–AC-011 全部 passed、delivery ready、testStatus passed、unresolvedItems 为空；Chrome `http://127.0.0.1:3080/` 实测团队进度和统一任务资源面板可见验收方案与证据。未执行数据库迁移、未修改 `tasks.md`；DELIVER 结果为只读验收，T03 完成，迁移应用留在 T13/T14。

- 2026-09-10：建立统一清单，拆分已完成能力和待验收主流程；纳入 Stage 06/07、Intel 延期和模型路线替换。后续从 T01 开始。
- 2026-09-10：完成 T01 真实日志复现与隔离缩小；确认任务处置结果误配、任务基线目录漂移和 Node 版本噪声的边界；补充处置结果一致性保护及可执行边界错误提示。未改变真实任务或审批记录，下一步进入 T02。
- 2026-09-10：完成 T02 隔离实现与验证；补齐安全暂停等待、持久排队、重启恢复、排队任务自动衔接及“排队中”状态展示。未改变真实任务或审批记录，下一步先完成 T02 真实宿主验收，再进入 T03。
- 2026-09-10：完成 T02 真实宿主验收；确认队列衔接、旧任务搁置后的自动激活，以及嵌套 Markdown 设计产物校验修复。真实任务已进入实施方案审批，未代用户执行审批，下一步等待用户确认后进入 T03。
- 2026-09-10：T03 继续推进；用户确认实施方案后，真实人员管理任务进入 BUILD。清理失效 DbGate 连接后，在宿主分配的设计库完成 `person`、`assignment` 建表与关键约束设计，并生成独立副本校验通过的迁移预览；当前等待用户审批迁移，未代用户批准。
- 2026-09-11：按用户要求继续 T03 代码配套；补齐 T04 的审批来源与记录展示链路。新审批保存认证会话、任务 ID和文档哈希，旧记录来源缺失时显示未知；未运行测试、未执行审批、迁移或浏览器操作。
- 2026-09-11：用户授权自动操作验收；修正审批来源接线的类型契约与回归断言，补齐 lint 阻断项。相关回归 11 个文件 73 项通过；人员模块 Node 场景 40 项通过；恢复相关 6 个文件 21 项通过；Bundle 构建、全仓类型检查、网页校验与 lint 通过；本地 web Profile 已升级并在 Chrome 验收历史审批来源未知提示与文档哈希。全量 Vitest 集合运行无输出后停止，未报告为通过；未执行迁移或业务审批，T03/T04/T05 仍待完整业务链路验收。
- 2026-09-11：按用户要求从已保存检查点恢复真实人员管理任务的开发运行。DSH 完成 S-1 可执行代码配套并在其隔离 Node 运行器中通过 `test/personnel-validation.test.mjs` 30/30；`service.ts` 与人员回归测试有本轮变更。T-03 迁移 SQL 的 CHECK/索引补充被 DSH 角色策略（`migration=false`、`deny-path-requires-handle`）拒绝写入，未执行迁移或业务审批；局部 TypeScript 检查还受隔离环境缺少 `undici-types`/`drizzle-orm` 阻断。当前下一步是由宿主授予迁移文件句柄/迁移能力后重放 T-03，或由用户明确指定由宿主代办该受限文件写入。
- 2026-09-11（本会话第二轮）：以宿主身份逐窗口复验并下发定向修正。人员模块五文件独立复跑（Node 24.19.0）：validation 43/43（先后修复 contact 嵌套映射、schema 列 `('col',` 选项形态、REFERENCES "public"."person" 带引号前缀三条测试断言）、roster 2/2、lifecycle 3/3、assignment 3/3、access 2/2；api 层（access/host-adapter/routes）与 domain（status/roster/lifecycle/assignment/audit/employee-no）文件齐备，仅向前迁移 0001–0004 在盘，0004 完整承载 CHECK/索引。S-1 两次由团队记为 passed（含绑定测试证据）。未执行任何数据库迁移，未代用户审批；0001/0002 的两份原地改写补丁保持 prepared 未应用，T-03 承载方式（0004 vs 内嵌）连同运行循环缺陷（T24）留待用户裁决，下一步在裁决或预算窗口重置后推进 T-10。

- 2026-09-14（继续推进 T14）：修复任务进度页“查看方案”只发请求不回写预览的问题；真实隔离 Chrome 重启后确认卡能显示哈希匹配的 `migration.sql`，并显示“退回修改/确认并继续”，未触发决定。继续用旧 revision 和篡改迁移摘要重启，真实页面分别显示过期/哈希不匹配原因并清理待审批文件。证据为 `.backend-team/artifacts/migration-review-restart-confirmation-chrome-t14-20260914.json`、`.backend-team/artifacts/migration-review-expired-chrome-t14-20260914.json`、`.backend-team/artifacts/migration-review-tampered-chrome-t14-20260914.json`。Web 回归 19/19、Web 类型检查、Bundle 构建/打包、Profile 升级和 Codex Chrome CUA 复验通过；未执行真实审批、迁移或生产写入。下一步转入 T15 正式宿主备份/恢复结果验收。

- 2026-09-14（继续推进 T15）：修复资源面板加载资源后没有同步当前任务 ID，导致备份/恢复按钮看似可用但静默 no-op；现在资源响应会保留任务上下文，并在操作完成后显示成功结果。隔离真实 Chrome 通过“立即备份”创建 `20260914T130653Z-postgres-95fe05fc`，页面显示备份成功并列出 3 份备份；将该快照恢复到预先创建的空库 `restored_gui2` 后，页面显示恢复成功，独立查询回读 `1|t15-ui`。证据 `.backend-team/artifacts/database-snapshot-resource-chrome-t15-20260914.json`；截图由 Codex Chrome CUA 直接检查。相关 Web 回归 25/25、类型检查、构建、打包和 `git diff --check` 通过。仅使用临时 Profile/工作区/PostgreSQL，未执行正式审批、迁移或生产写入；T15 仍待正式客户任务边界验收，下一步转入 T13 同会话 DbGate→迁移接线。
- 2026-09-15（继续推进 T14）：在同一隔离正式 DSH 宿主中通过 DbGate 7.2.3 完成设计库 GUI 变更、迁移预览和待审批记录；停止并重启宿主后实际 PostgreSQL 端口由 `56273` 变为 `53510`，Chrome 仍显示待审批迁移及完整 `migration.sql`。独立回读 source/design 数据库分别为 `0/1`，证明未自动应用 SQL；Bundle 类型检查、8 个迁移/宿主/DbGate/安全回归文件 `58 passed | 2 skipped`、`git diff --check` 和证据 JSON 解析均通过。证据 `.backend-team/artifacts/migration-review-restart-confirmation-formal-host-t14-20260915.json`；T14 完成，下一步转入 T16、T19–T21 外部门禁。
- 2026-09-15（继续推进 T16）：重新运行 PostgreSQL 18.6 arm64 原生执行端口检查，Node 24.19.0 下生命周期、SQL 读写、停止和新集群恢复通过，产物 SHA-256 `2c91690995dab19f4193b60297a4070f9c28df96bcf2711a49dcc48d6bae4ec0`；`verify-postgresql-runtime.mjs` 仍因 `pending-native-build` 以退出码 1 阻断。审计确认本地没有 darwin-x64 包、稳定 HTTPS 下载地址、checksum sidecar 或签名/attestation，证据 `.backend-team/artifacts/postgresql-execution-t16-20260915.json` 与 `.backend-team/artifacts/postgresql-release-t16-20260915.json`；T16 保持未勾选，下一步转入 T19–T21，等待外部发布材料后再回补。
- 2026-09-15（继续推进 T18）：真实隔离正式宿主 390×844 视口发现摘要卡三列网格导致说明文字逐字竖排；在 `packages/web/src/ui/theme.css` 的 760px 以下规则改为图标列 + 单一内容列，重新构建、打包并升级同一临时 Profile。Codex Chrome 切换深色后复验摘要、待审批 `migration.sql`、退回/确认按钮、资源面板和任务中心，`document/body.scrollWidth=390` 且 composer 可见，未代用户审批或执行迁移。证据 `.backend-team/artifacts/t18-dark-narrow-approval-chrome-20260915.json`，视觉记录见 `design-qa.md`；T18 完成，下一步转入 T19。
- 2026-09-16（继续推进 T21）：旧材料因 `package-lock` 摘要过期而被审计拒绝，已按当前 Bundle 重新生成 256 项归档、checksum、CycloneDX 1.5 SBOM 与 materials；`release-artifact`、`release-content-policy`、`release-model-gate` 共 20/20 通过，新的 `audit.json` 确认本地 archive/SBOM/许可证和 DbGate PostgreSQL-only 检查通过。正式 PostgreSQL provenance、签名/attestation 与稳定 HTTPS 下载仍缺失，T21 保持未勾选，下一步等待外部发布材料后再做 release-candidate 审计。
- 2026-09-15（继续推进 T19）：用 Node 24.19.0 复跑 `tests/e2e`，7 个文件 16/16 通过；矩阵合并 T13/T14/T18 最新真实宿主证据，更新 `.backend-team/artifacts/browser-acceptance-matrix-t19-20260915.json` 和 `tests/e2e/browser-acceptance.md`。T19 仍保持 `partial`，剩余同一生产组合全流程、官方 Harness/模型 provenance、双架构签名发布和签名包卸载证据。
