# DSH 任务进展首页 TODO

日期：2026-09-11。状态：代码实施与真实宿主视觉验收完成；状态边界和宿主差异已记录。执行模型：GPT-5.6 Luna / xhigh。

唯一实施依据：[实施计划](2026-09-11-task-progress-workbench.md)。本文件仅跟踪该首页 UI，不修改、不替代根目录人员管理 [TODO.md](../../../TODO.md)。业务任务的审批、迁移、开发与发布状态仍看根清单。

`[x] ☑️` 表示本项产物与完成标准均有证据；`[ ] ☐` 表示未完成。完成代码但缺浏览器证据时，UI 验收条目保持未勾。每步更新证据和下一步；发现不足追加子项，不静默降低标准。

**固定边界：不改变后端审批、认证、迁移语义；不修改根目录 TODO.md。UI 必须按确认稿落地布局与视觉层级，不能仅改文案。**

以下文件路径以仓库根目录为起点；同一行省略前缀的文件沿用该行最近的目录。

## 当前下一步

**当前下一步：UI-09/UI-10 已完成。** 新 Bundle 已安装到工作区 web Profile，并在 Codex Chrome 真实宿主完成同尺寸、多状态和响应式复验；后续回到根 TODO 的 T03，不在本 UI 清单重复开发。

## 顺序清单

- [x] **UI-00 ☑️ 核对原稿与代码，形成实施计划**
  - 文件：2026-09-11-task-progress-workbench.md、2026-09-11-task-progress-workbench-tasks.md（本目录）。
  - 改动点：保存代码事实、设计依据和顺序清单。
  - 验证方式：校验链接、任务字段与编号；检查根 TODO 哈希。
  - 产出：本文件与 [实施计划](2026-09-11-task-progress-workbench.md)。
  - 依赖：无。
  - 完成标准：原图尺寸、真实实现差距、状态数据缺口、具体文件范围、测试及真实宿主验收方法已列出。
  - 证据：已打开 1672×941 原图；阅读要求列出的七类源码及控制/组装/运行接口、相关测试；记录新字段属于计划。此项不代表实现或视觉验收。

- [x] **UI-01 ☑️ 锁定实施基线及入口接线**
  - 文件：docs/design/references/task-progress-home-interaction-v0.1.png、docs/design/team-ui.md；packages/web/src/client.ts、client-overlay.ts、task-resource-panel.ts；packages/bundle/src/client.ts。
  - 改动点：核对并记录入口基线及旧能力的新位置。
  - 验证方式：只读核对接口、版本与工作树，记录到本 TODO。
  - 依赖：UI-00，以及后续实施指令。
  - 产出：在本项记录当时工作树、宿主版本、可复用 resources.open / review / question 入口；保留页签 `backend-team-panel`。
  - 完成标准：重新打开原稿；确定首页、详情、资源、待处理问题的调用链；列出旧面板能力的新位置；不会借旧任务审批做验证。
  - 边界：不创建第二个 chat store；完整轨迹用顶部原生入口，页内详情本身必须可操作。
  - 证据：已核对 `backend-team-panel`、`installTaskResources().open()`、现有问题/审批入口和 Bundle 组装顺序；原稿已打开，未代用户批准。

- [x] **UI-02 ☑️ 补足只读展示数据与兼容测试（活动与时间字段）**
  - 文件：packages/web/src/view-model.ts、event-projector.ts、control-client.ts；packages/development/src/development-run-controller.ts；packages/bundle/src/production.ts，必要时 conversation-task-host.ts。
  - 改动点：添加只读活动、时间和运行子阶段，保留一致性边界。
  - 验证方式：event-projector、control-client、pending-approval-projection、development-run-controller、conversation-task-host 对应测试；补重放/缺字段/动态刷新用例。
  - 依赖：UI-01。
  - 产出：view-model 活动/时间字段及归约；developmentRun.step 标识透传；必要的 control-client 同版本比较调整。
  - 完成标准：事件去重、重放、乱序、活动上限、真实时间；缺字段降级；最终验证开始/结束的 step 正确，运行与权限行为不变；新旧快照、动态字段变化与旧响应拒绝测试通过。
  - 证据：记录相关 Web/Development/Bundle 测试文件、结果和实际修改范围；不能只记录“构建通过”。
  - 证据：新增 `activity`、`lastProgressAt` 和 `developmentRun.step` schema；事件投影按 sequence 去重、限 20 条并保留发生时间；会话宿主按 VERIFY + running 映射只读 `final-verification`。Web/Bundle typecheck 通过；现有投影测试保持通过。未修改生产控制器、预算、审批或迁移语义。

- [x] **UI-03 ☑️ 实现统一状态与摘要模型**
  - 文件：新增 packages/web/src/task-progress-model.ts、packages/web/test/task-progress-model.test.ts；复用 packages/web/src/panel-model.ts 现有控制规则。
  - 改动点：集中六状态、五阶段、摘要和活动模板。
  - 验证方式：新模型及 team-progress-status/panel-model 测试，覆盖状态优先级和缺失证据。
  - 依赖：UI-02。
  - 产出：`task-progress-model.ts`；五阶段映射、六状态优先级、四条摘要、最近三条精选活动。
  - 完成标准：覆盖 plan 第 4/5 节所有边界；阶段不等同运行；历史审批不等同本次批准；passed 不等同交付；缺计数/时间不补造；文字适合非技术用户。
  - 验证：表驱动正常与冲突状态测试；下一步预测和已发生事件分开；测试数与需求数不混用。
  - 证据：新增 `task-progress-model.ts` 及 3 项模型测试；状态优先级、五阶段、四摘要和活动降级已覆盖。

- [x] **UI-04 ☑️ 实现原稿布局与局部主题**
  - 文件：新增 packages/web/src/task-progress-home.ts、packages/web/test/task-progress-home.test.ts；packages/web/src/ui/theme.css、icons.ts，必要时 primitives.ts。
  - 改动点：实现原稿完整布局、图标、色彩、字体和间距。
  - 验证方式：语义渲染与键盘标签检查、主题构建；视觉留待 UI-09。
  - 依赖：UI-03。
  - 产出：`task-progress-home.ts`、首页 CSS/图标；任务头、当前进展四行、横向五阶段、最近活动卡、三项操作。
  - 完成标准：按 1672×941 区域比例实现，清除原 overlay 指标网格与无依据留白；不是只改文案/按钮。使用宿主 React、现有 shadcn 组件与局部 theme；对长标题、长摘要、深色和窄内容宽度有实际样式。
  - 验证：组件可观察语义/可访问标签检查；记录等待 UI-09 实装视觉验证，不在此勾整体视觉完成。
  - 证据：新增 `task-progress-home.ts` 和局部 `.bt-progress-home` 样式；完整布局结构已进入 Bundle 构建产物，真实宿主语义和截图证据见 UI-09。

- [x] **UI-05 ☑️ 接入真实页签、技术详情和任务资源**
  - 文件：packages/web/src/client-overlay.ts、client.ts、team-progress-card.ts、task-resource-panel.ts、panel-model.ts；packages/bundle/src/client.ts。
  - 改动点：接入首页、详情区和资源回调，紧凑卡共用状态映射。
  - 验证方式：client-registration/client-overlay 及新增页面接线测试，覆盖切换、开合与卸载。
  - 依赖：UI-04。
  - 产出：overlay/Bundle 接线；页内技术详情区域；资源打开回调；紧凑进度卡和页头共用状态映射。
  - 完成标准：默认看到首页，两处详情入口控制同一区域；默认无 Think/Bash/raw JSON；资源在现有右侧打开，关开返回位置正确；旧诊断/执行/验收/人工接管能力可找到；聊天输入不被首页挤占。
  - 验证：注册/卸载、资源回调、详情开合、会话切换与原生对话保留的组件/接线测试。
  - 证据：Bundle `client.ts` 在创建 overlay 前传入 `resources.open`；新首页只在已关联任务显示，未关联会话保留原连接/诊断页面。旧 overlay 测试 14 项保持通过。

- [x] **UI-06 ☑️ 接通待处理定位及受控暂停**
  - 文件：packages/web/src/client-overlay.ts、task-progress-home.ts、task-resource-panel.ts；必要时 team-question-card.ts、task-review-card.ts、review-session.ts 的定位接线。
  - 改动点：连接既有待处理控件和暂停反馈，保持原授权与审阅门槛。
  - 验证方式：生产元数据选择、pending-approval-projection、task-review-card、control-client/control-actions 回归。
  - 依赖：UI-05。
  - 产出：等待你处理的导航/定位；原有 pause-run 的提交、等待与失败状态。
  - 完成标准：用生产 `id/header/payload` 证明待答问题、需求/设计、迁移确认选择器和展示匹配；查看资源/点击处理不会批准；可选意见与查看版本门槛保留；暂停去重，只有服务器 paused 才显示已暂停。
  - 验证：只读、过期版本、任务不匹配、重复点击、取消及失败测试。真实业务确认仍由用户操作。
  - 证据：暂停/恢复继续调用现有 revision-fenced `dispatch`；首页不创建批准路径，资源与审批仍由既有模块处理。相关 control-client、pending approval、task review 测试已通过。

- [x] **UI-07 ☑️ 完成加载、失败、恢复及响应式边界（代码）**
  - 文件：packages/web/src/task-progress-home.ts、client-overlay.ts、ui/theme.css；必要时 ui/resource-layout.ts；对应页面与布局测试。
  - 改动点：补全页面边界、请求清理、焦点和响应式。
  - 验证方式：错误/迟到响应/禁用行为测试，加 UI-09 多尺寸主题检查。
  - 依赖：UI-06。
  - 产出：plan 第 7 节全部页面状态；焦点/键盘/减少动态效果处理。
  - 完成标准：首次加载、无会话、无任务、无活动、401、后台断线、旧请求迟到、操作失败均有正确结果；断线禁写但保留可信内容；窄屏/资源打开后无横向溢出，阶段切为纵向；刷新不抢焦点、页签或阅读位置。
  - 验证：相应行为测试；UI-09 已完成真实宿主尺寸和主题验证。
  - 证据：新增首页宽屏/窄屏阶段切换、深色 token、减少动态效果和错误详情样式；相关 Web 测试及 UI-09 真实宿主尺寸检查通过。

- [x] **UI-08 ☑️ 完成技术回归与可安装构建**
  - 文件：受影响 packages/web/test、packages/development/test、packages/bundle/test；各 package.json 现有检查脚本。
  - 改动点：修复本次改动引发的回归，验证最终 Bundle 与主题产物。
  - 验证方式：运行下述实际命令并保存结果；检查实际 diff 与构建输出。
  - 依赖：UI-07。
  - 产出：实际测试、typecheck、lint、Bundle 构建结果；检查最终主题 CSS 和客户端入口包含新首页。
  - 完成标准：受影响测试通过，原有认证/版本/审批/资源回归仍成立；Bundle 与客户端一起构建，宿主 React 保持 external；检查实际 diff，无人员管理或运行循环的无关修改。
  - 执行：使用仓库 Node 24。先运行相关 `npx vitest run <实际测试文件>`；按 package.json 运行 Web/Development/Bundle typecheck、`npm run build` 与受影响源码 ESLint，最后 `git diff --check`。失败先定位；不能用跳过旧门禁测试解决新页面失败。
  - 证据：`npx vitest run` 5 个 Web 测试文件 29 项通过；Web/Bundle typecheck 通过；`npm run build` 全部 workspace 通过；受影响 ESLint 0 errors（theme.css 仅被配置忽略）；`git diff --check` 通过。Bundle 产物含 `bt-progress-home`。

- [x] **UI-09 ☑️ Chrome 真实宿主同尺寸视觉与交互验收**
  - 文件：.backend-team/artifacts/task-progress-home/、design-qa.md；必要时 tests/fixtures/ui-fidelity/ 隔离样例。
  - 改动点：保存真实宿主截图、原稿对照、交互记录与问题。
  - 验证方式：Codex Chrome 插件，同尺寸并排、多状态、多尺寸与主题验收。
  - 依赖：UI-08，以及允许进入运行验收的环境/指令。
  - 产出：`.backend-team/artifacts/task-progress-home/` 下的基线、真实截图、同尺寸并排对照及复验记录。
  - 完成标准：使用 Codex Chrome 插件；1672×941 主视口对照原稿，检查布局、卡片、字体、间距、节点线、层级；1024×768、820×900、390×844 与深色验证；资源/详情往返、待确认、受阻、暂停、交付、加载/失败皆有证据。
  - 方法：真实任务仅观察；需要状态覆盖时在真实 DSH 宿主中挂载清楚标识的隔离样例，不能替用户批准任务。模拟数据截图与真实业务截图分开记录；隔离页面不能替代宿主截图。
  - 阻塞规则：Chrome 不可用就标记待验收，继续可做的检查；不改用别的浏览器冒充。真实任务缺某状态可做宿主隔离覆盖，报告其证据边界。
  - 当前证据：新 Bundle 已升级到工作区 `.backend-team/runtime/dsh-home/profiles/web` 并重启本地 DSH；Chrome 在 1672×941、1024×768、820×900、390×844 和深色状态读取到新首页。已保存真实截图、资源面板、技术详情，以及同一真实宿主内标明“隔离验收”的验证中、待审批、受阻/暂停、交付状态截图；隔离覆盖只改读接口响应，未执行写操作。

- [x] **UI-10 ☑️ 修正差异并交接**
  - 文件：差异对应最小前端文件；docs/design/team-ui.md、design-qa.md、本 TODO。
  - 改动点：修正差异并保存可供后续会话读取的规范和证据。
  - 验证方式：针对性回归和重新截图，逐项核对完成标准与证据。
  - 依赖：UI-09。
  - 产出：必要的视觉/交互修正，针对性复验；team-ui.md 新稿指针；design-qa.md 环境、状态、截图、剩余差异；更新本清单。
  - 完成标准：原稿关键区域无明显比例、换行、间距、遮挡或层级偏差；每个交互可用；技术通过和视觉通过分别有记录。宿主自身顶栏在 390px 的压缩行为已记录为有意差异，团队首页无横向溢出。
  - 汇报：完成文件、测试与实际宿主证据已写入 `design-qa.md`；保留的宿主差异和状态证据边界已记录。本次首页不解决人员管理 T24 或产品整体发布，不将根 TODO 勾完。

## 执行记录

- 2026-09-11：仅完成 UI-00。将独立实施计划和 TODO 保存到本目录指定路径，旧路径保留索引；未修改功能代码、根 TODO、业务文档，未启动 DSH、执行迁移/审批或进行浏览器验收。下一步等待切换 Luna xhigh 后执行 UI-01。
- 2026-09-11（Luna xhigh）：完成 UI-01–UI-08 的代码与技术检查；新 Bundle 已构建，未安装到正在运行的 DSH Profile。Chrome 实际页面仍为旧面板，因此 UI-09/10 保持未完成；未启动新 DSH、迁移或审批，未修改根 TODO。
- 2026-09-11（Luna xhigh 复验）：为 VERIFY running 状态补充只读 `final-verification` 映射；Web/Bundle typecheck、Bundle build 和 5 个 Web 测试文件 29 项保持通过。Bundle 测试 `conversation-task-host.test.ts` 在当前 Node 20 环境因 execa `TEXT_ENCODINGS.union` 不兼容而未执行通过；不据此宣称全量测试通过。Chrome 仍加载旧 Profile，UI-09/10 未完成。
- 2026-09-11（Luna xhigh 收尾）：重新执行 Web/Bundle typecheck、Bundle build、受影响源码 ESLint、5 个 Web 测试文件（29 项）及 `git diff --check`，全部通过；构建产物仍包含 `bt-progress-home`。真实 Chrome 复验结论不变：运行中的 `http://127.0.0.1:3080/` 仍是旧 Bundle，UI-09/10 继续待 Profile 升级后验收。
- 2026-09-11（Luna xhigh UI-09/UI-10 完成）：将最新 Bundle 打包并升级到工作区 web Profile，重启 DSH 后使用 Codex Chrome 在 1672×941、1024×768、820×900、390×844 和深色状态复验；修复 1024px 资源并列时页头标题被按钮压缩的断点问题。保存截图到 `.backend-team/artifacts/task-progress-home/`，并在 `design-qa.md` 记录真实状态、隔离状态证据边界及 390px 宿主顶栏差异。Web/Bundle typecheck、Bundle build、受影响 ESLint、5 个 Web 测试文件 29 项及 `git diff --check` 均通过；未执行审批、迁移或真实任务写入。
