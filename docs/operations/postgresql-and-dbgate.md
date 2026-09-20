# 本地 PostgreSQL 与 DbGate

数据库服务只使用工作区下的 PostgreSQL 18.6 运行时，Unix socket 和随机高位回环端口均由工作区管理。凭据存储通过注入的凭据实现，不写入连接字符串或仓库。

DbGate 是可选的本地 GUI：安装脚本被禁用，服务必须认证并绑定 `127.0.0.1`，shell 连接和脚本功能关闭。结构设计在一次性 `design_<id>` 数据库中完成，确认后转换为项目 schema 与迁移；开发库不会被 GUI 原始 DDL 直接改写。

DbGate 安装器只接受一次明确的安装批准，并把 `dbgate-api@7.2.3`、
`dbgate-web@7.2.3` 与 `dbgate-plugin-postgres@7.2.3` 放在
`.backend-team/runtime/dbgate`。安装器随后生成 PostgreSQL-only 启动器和插件白名单，
不会安装 `dbgate-serve`、Excel 插件或 `xlsx`。启动器会在
启动前拒绝工作区外的运行时或可执行文件；启动后只接受回环 TCP/Unix socket，
发现非回环监听或未就绪服务会立即停止进程。macOS 的 `/var` 与 `/private/var`
符号链接会先规范化，避免把合法的临时工作区误判成路径逃逸。

安装前逐层检查 `.backend-team`、`runtime`、`dbgate` 为真实目录，禁止把这些
受管目录设为符号链接（包括指向工作区内部的链接）。检查在创建下一层目录前
完成，并在调用安装 runner 前及其成功返回后复核，避免先写入链接目标再报告越界。
直接使用进程适配器时，也检查工作区之下到运行时根目录的各层路径，禁止绕过安装器
使用目录链接。启动前同样检查 DbGate 的 `home`、`tmp`、`user-data` 目录；`HOME`、`TMPDIR` 和
`WORKSPACE_DIR` 固定为这些路径，不接受调用方提供的外部数据目录。
这些是安装与启动前的路径检查，不是操作系统文件写入沙箱，也不能保证抵御另一个
进程在检查后替换目录。真实运行时的文件写入审计仍是 GUI 验收的必要证据。

启动和停止请求按顺序执行，重复打开会复用已验证的进程；启动尚未结束时请求
停止，会等待启动结果再清理。监听检查或就绪探测抛异常时也会尝试停止子进程，
只有全部检查通过才发布 GUI URL。若停止失败，状态为 `interrupted`，保留进程
句柄并撤回 URL；必须重试 `stop()` 完成清理后才能重新启动。启动与清理同时失败
时会返回包含两项原始错误的 `AggregateError`，不能把这种状态报告为已停止。

用户已于 2026-09-05 明确批准工作区本地下载及真实 GUI 验收。下载后核对
`dbgate-api@7.2.3` 源码发现旧的 `DBGATE_*` 配置名称不被实际运行时消费，现已改为
`LOGIN`、`PASSWORD`、`PORT`、`WORKSPACE_DIR`、`TOKEN_LIFETIME`、`LANGUAGE`。
`SHELL_CONNECTION`、`SHELL_SCRIPTING`、`SKIP_ALL_AUTH`、`ALLOW_DBGATE_PRIVATE_CLOUD`
必须为空或缺省；字符串 `"0"` 在此版本中仍被视为开启。只有提供真实预定义连接的 ID
和数据库名时才能设置 `SINGLE_CONNECTION` / `SINGLE_DATABASE`，不能用 `"1"` 冒充。
自动化适配器测试本身不证明这些第三方能力；发布状态以实际运行与安全审计记录为准。
启动现在最多等待 30 秒，确认子进程拥有指定回环监听后才探测 HTTP；冷启动期间
没有监听会继续等待，异常监听立即拒绝，超时会清理进程。实际启动器已测得约
494–504 毫秒进入就绪状态，这不是跨机器性能保证。

生产宿主打开 GUI 时把已认证会话 ID 传给执行端口，形成 60 秒内的一次性登录
交付授权。专用同源 POST 接口验证会话、工作区与写权限后消费授权；登录信息只在
临时界面显示，普通状态、事件和导航 URL 不包含密码。停止 GUI 会撤销授权。
真实 Chrome 已验证此交付链路；官方 Harness 完整生产宿主仍需单独验收。

安装器固定四个经过调用兼容验证的依赖替换版本，根包保持 7.2.3；冲突配置直接
报错。运行时采用 PostgreSQL-only 依赖闭包，明确排除 DbGate Excel 插件及其
`xlsx` 依赖；安装后会核对插件目录只含 PostgreSQL，并拒绝回退到 `dbgate-serve`。
工作区 Node 24 使用官方 npm registry 对新锁复核为 0 critical、0 high、8 moderate，
没有 `xlsx` 或 `dbgate-serve` 条目；正式发布仍需满足 PostgreSQL 双架构和签名门禁。

原生二进制尚未完成双架构构建证明前，不能把数据库体验标记为可发布状态。

### Owned design database connection

A `DbGateLauncher` now requires the same `CredentialStore` that owns the active
PostgreSQL endpoint's `credentialRef`. It generates the predefined connection
from that endpoint; do not inject connection environment variables in a host
wrapper. `createDatabaseExecutionPort` also requires `designSession` before
`openGui` is available. This provider clones the project development database
into a disposable `design_<16 hex characters>` database and owns its discard.
Missing credentials or a missing design provider fail closed.

The GUI connects to this disposable database. Saving a GUI change does not
apply it to the development database. The configured migration workflow below
verifies a clone and requests approval before applying SQL to the development database.

### 数据目录与凭据恢复

`FileCredentialStore` 可把自动生成的本地数据库凭据保存到宿主指定的私有目录：目录权限为 `0700`，文件为 `0600`，拒绝符号链接、硬链接、过宽权限和非法引用。它是当前用户权限保护的本地文件存储，不是加密保险库；目录必须放在 `.backend-team` 等不参与提交、会话导出或制品打包的位置，不要输出文件内容。

新建集群保存 `.cluster.json`，其中只有工作区、数据目录与凭据引用，不含密码。重新构造集群时，读取并验证元数据、`PG_VERSION` 和原凭据，复用已有数据；不重新执行 `initdb`。已有数据缺少元数据、凭据丢失、版本不符或存在 `postmaster.pid` 时停止恢复并保留原数据，需要确认原因后处理，不自动删除进程标记或重置密码。

旧测试目录不会自动升级：缺少上述元数据的已有目录应保留，不能直接作为新集群初始化。

### 配置宿主的数据库按钮（2026-09-08）

生产插件现在支持可选 `database: { enabled: true, executableRoot: '<工作区绝对路径>/.backend-team/runtime/<已验证的 PostgreSQL 目录>' }`。该目录需要预先安装，配置本身不下载运行时。当前实现仅支持 macOS，验证 PostgreSQL 18.6 及二进制依赖后，使用独立的 `.backend-team/runtime/workflow-postgresql` 持久化目录。

页面提供启动和停止按钮，并实时显示正在启动、就绪、停止或失败。启动同时准备项目数据库；操作完成不会把内部连接信息作为页面导航结果返回。宿主正常退出时停止自己持有的进程，重启后复用原有目录和凭据。强制退出留下进程标记时仍需检查原因，不自动覆盖。

已用 Codex Chrome 插件在真实 DSH 页面完成启动、停止、宿主重启后再次启动及停止；启动时独立确认 PostgreSQL 只监听 `127.0.0.1`。长工作区路径会使 Unix socket 超过 macOS 的 103 字节限制，此时关闭 Unix socket，仍通过本机 TCP 和 SCRAM 认证连接。

上述验收只覆盖数据库控制。这个配置入口尚未接入 DbGate 的一次性登录和设计数据库流程，不显示可用的 DbGate 按钮；不能据此把整个数据库体验或生产发布标为完成。

### 配置宿主 DbGate 接入（2026-09-08）

后续接入已完成：在 `database` 下配置 `dbgate: { enabled: true, runtimeRoot: '<工作区>/.backend-team/runtime/dbgate', port: 3081 }` 可启用已安装的 7.2.3 运行时。端口需要空闲；Node、DbGate 和随包提供的回环预加载文件均需位于工作区内。配置不会下载软件，也不会豁免发布审计。

真实 Codex Chrome 验收经过 DSH 按钮、临时登录信息、DbGate 登录页，连接状态显示 Connected，数据库为独立的 design_ 临时库。通过 DSH 停止数据库后，DbGate 监听释放；再次启动 PostgreSQL 查询确认该临时库已删除。该验收未覆盖图形建表或保存迁移，不等同于完整数据库设计功能已发布。

进程使用已有 ProcessSupervisor 和 WorkspaceDbGateProcessAdapter，限定启动参数和环境，检查进程身份与回环监听。设计库使用已有 SchemaDesignSession 和执行端口清理顺序。发布仍受依赖审计、双架构构建证明和迁移审批流程等既有门槛约束。

### 图形建表验收（2026-09-08）

当前 7.2.3 在空数据库页面点击 `New table` 未打开编辑器；通过右上角 `＋ → Table` 可以打开。未修改第三方压缩代码，也未证明快捷入口失效的内部原因。当前页面入口说明明确给出已验证的主菜单路径。

使用 Codex Chrome 插件实际完成：打开 Table 编辑器，输入 `gui_edit_acceptance`，保留默认 id 主键，点击 Create table，检查生成的 CREATE TABLE 预览后确认。页面显示 Saved to database，刷新后对象列表仍显示该表，结构包含 integer id 与 PK_gui_edit_acceptance 主键。独立 PostgreSQL 查询确认临时设计库内该表数量为 1，项目开发库内为 0，原始结果记录在本机 `.backend-team/artifacts/dbgate-edit-isolation.json`。

本轮仅验证建表、保存和刷新，以及测试表没有进入开发库；未验证全部字段编辑、索引、外键、迁移生成或审批。后续接入迁移不能把完整 schema dump 的文本差异直接当成可执行升级 SQL。

### 迁移预览边界（2026-09-08）

迁移转换已调整为只生成和验证预览：`GuiToMigration.convert()` 不再调用执行器。验证通过不能代替用户审批，宿主必须另行将精确 SQL、校验摘要及验证证据交付审批，再执行获准的内容。该阶段尚未提供页面操作，后续接入结果见下方正式页面验收。

`SchemaDiff` 现在传递 `beforeSql`、`afterSql`、两份 SHA-256 和字节级 `changed` 标记；不再按分号拆分、删除注释、排序后将文本差集视为升级 SQL。删除对象及字符串/函数里的分号、空格、注释样式文本均保留。`normalizeSchemaSql` 已从公开导出移除，生成器需要读取完整前后结构并使用项目迁移工具生成 ALTER/DROP 等操作。字节差异不保证语义变化，生成器仍需识别无实际变更的快照。

设计会话保留只读的 `beforeSchemaSql`，`beforeSchemaHash` 是该原始 SQL 的摘要；原生宿主的 `captureSchema` 返回完整 schema-only SQL（不包含 owner/privilege 声明）。这些快照留在宿主内存，未加入普通页面状态或事件。

该阶段回归覆盖仅删除的变更、带分号与注释样式文本的 SQL、无变化不调用生成器、验证预览不执行、快照内容与摘要一致；当时尚未接通真实生成器和页面审批，不能单独作为完整功能验收。

### 应用已审查的迁移

`MigrationAdapter.apply` 现在接收先前审查过的 `MigrationPreview` 与审批令牌，不会在执行时再次调用生成器。SQL 摘要或风险等级与内容不符、令牌为空时，在调用执行器前拒绝。传给执行器的是不可变预览；执行器必须在真正执行前通过宿主审批服务验证、消费与该预览绑定的令牌。非空字符串本身不构成有效审批，本次接口调整不代表宿主审批功能已接通。

当前 `/health` 验收项目的批准范围明确不含数据库，没有 Drizzle 模型和迁移命令；不能为完成迁移验收直接改变它的业务要求。需要在独立数据库验收项目或用户指定的已有业务项目中继续接入和端到端验收。

### 正式页面迁移接入与验收（2026-09-08）

在已有数据库配置下增加 `database.migrationToolingRoot`，指向工作区 `.backend-team/runtime/` 内独立安装了 `drizzle-kit@0.31.10`、`drizzle-orm@0.45.2`、`pg@8.23.0` 的绝对目录。本机使用 `migration-acceptance` 子目录。配置不会自动下载依赖。更新插件或配置后需要重启 DSH 后端。

操作顺序：打开数据库工具，在右上角 `＋ → Table` 建表并保存；返回 DSH 点击“生成数据库迁移”；点击“查看方案”阅读 SQL，随后“确认并继续”或“退回修改”。生成阶段只读取源库及设计库，在独立副本上执行并比较完整结构；审批前不会修改开发库。Drizzle 对单列主键名称的丢失由宿主根据 PostgreSQL 元数据补上明确的 RENAME CONSTRAINT，该 SQL 同样纳入预览、摘要和验证。

批准后先检查工作流版本、设计会话和前后结构是否仍匹配，再保存开发库完整备份，使用事务执行内存中的获准 SQL。审批不会再次生成 SQL。结构改变、重复批准、预览摘要不符或验证失败会阻止应用；页面显示具体迁移结果，不把迁移验证失败误报为数据库启动失败。

SQL、Drizzle schema、验证记录及应用记录保存在工具目录下本次 `generation-*` 目录；这些是本机持久制品，停止数据库不会删除。备份库名称在 `backup.json` / `applied.json` 中，不自动清理。需要同步业务 ORM 源码时，配置 `database.ormSchemaPath`；该文件会作为同一审批中的独立预览，批准后在原文件摘要未变化时原子写入，迁移失败会尝试回滚。待审批记录和受管设计会话会保存到工作区，重启后在集群、设计库、版本和 SQL 均一致时恢复，任一条件不符则要求重新生成。当前入口只应用到本工作区开发库，不连接外部生产数据库。Drizzle 要求交互确认的重命名会停止生成；未验证的数据库对象不能因本次建表成功而宣称全部支持。

真实 Codex Chrome 已完成 DbGate 建表 → DSH 生成 → 查看 SQL → 批准 → 应用。验收表为 `dsh_migration_acceptance`：批准前开发库计数 0，批准后计数 1；主键 `PK_dsh_migration_acceptance` 保留，SQL SHA-256 为 `76cd27c879947558cff434f253ae7bd2785cb0b9c196f5c16b65917111fa03f2`，应用记录摘要相同。验收只使用本地测试表，不修改 `/health` 业务要求及源码。独立 PostgreSQL 集成测试另覆盖已有数据保留、索引/外键生成和审批期间结构变更的拒绝。

验收后确认测试表没有业务数据，已只删除该空测试表并停止临时设计库；迁移文件、审批前备份和验收证据保留。证据包含 `testTableCleaned: true`。

本机证据位于 `.backend-team/artifacts/dsh-migration-browser-evidence.json`、`native-migration-review.log`、`drizzle-real-upgrade.log`、`migration-all-tests.log`。264 项相关测试通过，2 项默认关闭的原生测试未在该测试批次运行；Chrome 和真实数据库验证按上述独立记录执行。类型检查、构建及 12 文件打包检查通过。这完成本机迁移操作链路，不解除依赖审计和双架构原生发布证明等其他发布阻塞。
