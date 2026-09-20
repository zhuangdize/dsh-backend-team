# 诊断

`backend-team-doctor.mjs` 只读检查当前 Profile（默认 `web`）、Profile 配置来源、工作区内 DSH/Node 运行时、Bundle 是否已安装、项目依赖、状态 schema、预算账本、开发检查点、Spec Kit 运行时，以及 PostgreSQL/DbGate 运行时目录；不安装、不修复、不启动进程，也不输出凭据、连接串或绝对源代码路径。存在会话任务注册表时，脚本会按 `state-<taskId>/current.json` 识别唯一未完成任务，并以该任务作为状态和检查点来源；旧的 `.backend-team/state/current.json` 只作为无活动任务时的 legacy 参考。

报告中的 `tasks`、`activeTaskId`、`stateSource`、`budget`、`checkpoint` 和 `recovery` 用于决定下一步：预算已耗尽时，`budget.blockedDimensions` 会列出记录中的耗尽维度，先查看对应记录，开发或验证阶段不会再建议直接 `continue`；有通过切片且预算可用时，`recovery.action` 会建议在审批和交接复核后 `continue`；待审批阶段会建议 `preview-and-confirm`；已交付任务返回 `none`。如果同时存在多个未完成会话任务，脚本强制返回 `inspect-state`，要求先在当前对话处理冲突。所有建议均受状态约束，不会由诊断脚本自动执行，也不会绕过审批。

`nodeVersion`/`nodeExpectedVersion`、`dependencies` 和 `runtime` 反映当前检查环境。`notes` 只保留可操作的原因，不包含工作区绝对路径；发现历史预算记录为受阻不代表脚本会替你重写记录，需在任务对话中按耗尽原因处理。

在项目工作区执行：

```bash
./.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node scripts/backend-team-doctor.mjs
```

如果检查真实用户 Profile，显式指定 DSH 配置目录：

```bash
./.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node scripts/backend-team-doctor.mjs --profile web --dsh-home ~/.dsh
```

输出中的 `harness: present` 表示工作区托管的 DSH 可执行文件存在，不等同于生产宿主兼容性已经通过；生产兼容性仍以 `docs/compatibility/release-evidence.md` 为准。
