# DSH Backend Agent Team

[English](README.md) | [简体中文](README.zh-CN.md)

Backend Agent Team 是一个 DSH Bundle，用于运行以对话为入口的后端交付流程。它把用户需求推进为需求确认、方案设计、实现、测试和交付证据，同时把认证、权限、审批和模型访问交给 DSH 宿主管理。

> **项目状态：** 仓库包含源码实现和本地验证工具。正式发布仍需外部签名的 PostgreSQL 制品、带签名的分发材料和稳定 HTTPS 下载地址。详见[发布阻塞项](docs/operations/release-blockers.md)。

## 提供的能力

- **对话优先的交付：** 需求和设计在对话中展示，必须经过用户明确确认后才能进入下一阶段。
- **任务中心与恢复：** 未完成任务、排队任务、检查点、预算、冲突和恢复状态可以跨重启查看和恢复。
- **Agent Team 编排：** 规格、规划、开发、测试和验证角色使用受限的文件所有权和写入范围。
- **可审阅产物：** 任务进展视图与对话并列展示文档、审批、问题、测试证据和交付结果。
- **数据库流程：** 可选的 loopback PostgreSQL 与 DbGate 7.2.3 集成支持 Schema 审阅、完整 SQL 预览、备份和审批门禁迁移。
- **模型接入：** 模型 API 和凭据由 DSH 宿主提供。Bundle 不保存 API Key，也不替换 DSH 的授权机制。

## 工作方式

```text
用户对话
   │
   ▼
DSH 宿主（会话、认证、模型、审批）
   │
   ▼
Backend Team Bundle
   ├─ 需求 → 设计 → 规划
   ├─ 受限 Agent 任务与检查点
   ├─ 测试、证据与交付审阅
   └─ 可选 loopback 数据库流程
```

当宿主没有提供经过验证的生产能力时，Bundle 默认处于诊断、只读模式。生产激活必须显式配置，并要求宿主提供会话、Agent、工作区、恢复和策略能力。Bundle 不会静默安装依赖、执行任意 Shell 命令、部署应用或自动批准文档。

## 使用要求

- Node.js **24.x**（工作区声明为 `>=24 <25`）。
- DSH **0.1.0-rc.6** 的 Bundle 运行时和客户端依赖。
- 用于浏览器访问的 DSH Web Profile。
- macOS（仅可选的原生 PostgreSQL 和 DbGate 运行时需要）。
- 在 DSH 中配置模型凭据。凭据应保存在 DSH 凭据服务中，不要写入仓库或聊天消息。

## 从源码开始

```bash
git clone https://github.com/zhuangdize/dsh-backend-team.git
cd dsh-backend-team

# 安装依赖前请先使用 Node.js 24.x。
npm ci
npm run typecheck
npm test -- --run
npm run build
```

根目录是用于构建的私有 workspace。`npm run build` 只生成本地 Bundle，不会发布 npm 包，也不会部署 DSH Profile。要把本地 Bundle 安装到 Profile，请参考 [macOS 安装](docs/operations/install-macos.md) 和[详细 Bundle 指南](packages/bundle/README.md)。

## 在 DSH 中使用

将 Bundle 安装到已配置的 DSH Web Profile 后，直接在对话中提出需求。例如：

- `查看后端团队进度`
- `继续后端团队任务`
- `展示待确认的设计方案`
- `确认这份设计并继续`

使用**团队进展**视图查看产物、问题、审批和证据。它与对话并列，不替换 DSH 的会话列表和授权流程。

当前模型 API 配置见[模型 API 接入](docs/model-api.md)。旧的 Codex App Server 适配器说明保留在 [Codex App Server](docs/codex-app-server.md)，当前默认路由不是它。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `packages/bundle` | DSH Bundle 清单、生产激活、浏览器入口和包说明 |
| `packages/core` | 工作流状态、审批、需求/设计协调和交付生命周期 |
| `packages/agent-team` | 任务调度、所有权、预算、检查点和结果验证 |
| `packages/development` | 受限开发运行和最终验证 |
| `packages/database` | PostgreSQL、DbGate、快照、Schema 设计和迁移边界 |
| `packages/web` | 任务中心、进展视图、资源、审阅卡和 DSH 客户端桥接 |
| `packages/harness-adapter` | DSH 会话、Agent 和模型适配器 |
| `docs/` | 安装、运维、兼容性、设计和发布文档 |
| `tests/` | 集成和端到端契约 |

## 验证命令

根据修改范围运行对应检查：

```bash
npm run typecheck
npm test -- --run
npm run lint
npm run build

# 可选的宿主和发布检查
npm run verify:web-client
npm run verify:agent-runtime
npm run audit:release-materials
```

这些检查验证源码行为和本地打包，不能单独证明正式公开发布、真实模型额度或生产部署。剩余发布门禁记录在 [TODO.md](TODO.md) 和[发布阻塞项](docs/operations/release-blockers.md)中。

## 安全与本地状态

`.backend-team/` 保存本地任务状态、检查点、日志、运行时文件和凭据。该目录已被忽略，不能提交。生成的压缩包和 sidecar 也只用于本地发布流程，不应随源码公开。创建 fork 或提交补丁前，请检查 API Key、私钥、带凭据的 URL、本地路径和模型配置。

当前仓库还没有声明项目级许可证。Bundle 的第三方许可说明位于 [`packages/bundle/LICENSES`](packages/bundle/LICENSES)。在补充项目许可证前，不要假定可以重新分发本项目。

## 文档

- [自动开发](docs/operations/automatic-development.md)
- [任务冲突与恢复](docs/operations/task-conflicts.md)
- [macOS 安装](docs/operations/install-macos.md)
- [数据库与 DbGate](docs/operations/postgresql-and-dbgate.md)
- [升级与回滚](docs/operations/upgrade.md)
- [发布证据](docs/compatibility/release-evidence.md)
- [Bundle API 与生产激活](packages/bundle/README.md)
