# 开源 Codex-like 长任务 Agent 方案调研

调研日期：2026-09-16

## 结论先行

对当前 Node.js + TypeScript Agent Team，首选 **LangGraph.js**。它直接提供 TypeScript/Node 包、图级状态、按 super-step 保存的 checkpoint、线程恢复、人工介入、时间旅行和故障恢复；这些机制可以作为现有任务状态与 Agent 循环的执行内核，逐步接入，而不必迁移到 Python 或重写成独立桌面产品。[仓库 README](https://github.com/langchain-ai/langgraphjs) [持久化文档](https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/persistence.md)

上下文压缩专项复核后，最值得借鉴的不是一个独立的“压缩 SDK”，而是 **Cline SDK 的上下文管线设计**：规范的 turn-preparation seam、agentic compaction、无需模型调用的 deterministic fallback、追加写入的完整原始 transcript、独立的 compaction artifact，以及用 canonical-prefix hash 校验恢复是否仍然有效。[Cline SDK 架构](https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md) [Cline Auto Compact](https://github.com/cline/cline/blob/main/docs/features/auto-compact.mdx)

选择是针对“在现有 Node/TS Agent Team 中补强长任务能力”的判断。LangGraph.js 不会自动替当前项目实现审批语义、工作区安全边界、预算策略或 UI；这些仍需保留在宿主层。若目标是直接采用成熟的任务执行基础设施，**Temporal TypeScript SDK** 更强，但部署和改造成本明显更高；若目标是采用更完整的 TypeScript Agent 产品框架，**Mastra** 是第二选择。

## 评估口径

- “上下文压缩”只在来源明确描述 compaction、summarization、context management 或 memory 回收时记录；持久化 checkpoint 本身不等于压缩。
- “检查点恢复”要求来源明确说明保存状态、从故障/重启/中断处继续，或提供 resume/fork API。
- 活跃度/成熟度只记录 GitHub 仓库页可见的证据（提交历史、Stars/Forks、维护声明、发布/文档结构），不把 Stars 当作质量证明。动态数字是本次查询时的快照，不代表长期趋势。
- “适配性”和“风险”是基于来源与当前项目 Node/TS、PostgreSQL、持久化任务状态和既有 Agent 编排的工程判断；不是候选项目的自我宣称。

## 候选总览

| 候选 | 长任务/恢复 | 上下文管理 | Agent 编排 | Node/TS 适配 | 许可证与主要风险 |
| --- | --- | --- | --- | --- | --- |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | 图状态 checkpoint、故障后恢复 | 短期线程状态 + 长期 Store；可自行接摘要 | 图节点、子图、HITL | **高** | MIT；需要自行设计业务状态、存储和压缩策略 |
| [Mastra](https://github.com/mastra-ai/mastra) | storage 保存执行状态，支持 suspend/resume | history、retrieve、Observational Memory | Agent + graph workflow、MCP | **高** | 核心 Apache-2.0；`ee/` 为企业许可证，API 迭代快的风险需锁版本 |
| [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript) | durable workflow、重试、worker 重启后继续 | 不提供 Agent 上下文压缩，需要在 Activity/Workflow 中实现 | Workflow/Activity/Child Workflow；有 OpenAI Agents 集成 | **高（基础设施层）** | MIT；需要 Temporal 服务、Worker 和确定性约束 |
| [Inngest](https://github.com/inngest/inngest) | 按 step 持久化、重试、waitForEvent、可运行数月 | 不负责 LLM 上下文压缩 | 事件、并发控制、step.invoke 子 Agent | **高（任务层）** | Server/CLI 为 SSPL + DOSP，SDK Apache-2.0；依赖服务协议和一次 round-trip/step |
| [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) | ConversationState/EventLog 持久化、resume、fork/navigate | 有 condenser/事件历史，可替换；不是 Node 原生 | Agent Server、事件流、工作区、自动化 | **中** | MIT；核心 SDK Python，TS 主要是 API client |
| [Letta / letta-code](https://github.com/letta-ai/letta-code) | 持久 Agent 身份、会话和 Git-backed MemFS | 记忆块、召回/归档记忆、上下文满时摘要/compaction | Agent + recall subagent、dreaming | **中高（可调用/嵌入），核心运行时偏 CLI/Python** | Apache-2.0；记忆架构复杂，`letta` 与 `letta-code` 源码边界需固定 |
| [goose](https://github.com/aaif-goose/goose) | JSONL session、`--resume`、recipe/sub-recipe | 有会话文件和上下文命令；压缩/跨版本恢复需自行验证 | Recipe、MCP 扩展、ACP | **中（CLI/API），低（库内嵌）** | Apache-2.0；Rust 主体，历史 issue 暴露 recipe 扩展未随 resume 恢复 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | `@persist` + SQLite 快照，可 resume/fork | 提供 memory，但压缩不是核心机制 | Crews + 事件驱动 Flows | **低** | MIT；Python-only，需服务边界或重写 |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai) | Temporal/DBOS/Prefect/Restate 等 durable backend | 自动 conversation summarization、context management | typed Agent、Graph、SubAgents/Harness | **低（核心 Python）** | MIT；需要 Python 运行时和外部 durable engine |
| [OpenAI Codex CLI/App Server](https://github.com/openai/codex) | thread resume、compact、fork、archive | App Server 的 contextCompaction；checkpoint 提案 | thread/item 协议、工具与会话生命周期 | **中（协议参考）** | Apache-2.0；完整产品边界与当前业务语义不同 |

## 逐项研究

### 1. LangGraph.js

- **仓库**：[`langchain-ai/langgraphjs`](https://github.com/langchain-ai/langgraphjs)。仓库 README 将它定义为构建有状态 Agent 的低层编排框架，提供 Node/TypeScript 安装包，并明确列出 durable execution、人工介入、短期/长期 memory 和生产部署能力。[README](https://github.com/langchain-ai/langgraphjs)
- **核心机制**：编译图时绑定 checkpointer；每个 super-step 保存图状态快照，快照挂在 `thread_id` 下，可以读取当前状态和历史，并从失败的最后成功步骤恢复。官方持久化文档还说明失败 super-step 中已完成节点的 pending writes 会被保存，恢复时不会重复执行这些节点；checkpointer 同时支撑 HITL、memory、time travel 和 fault tolerance。[Persistence](https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/persistence.md)
- **许可证**：MIT，仓库页明确标注。[LICENSE](https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE)
- **活跃度/成熟度证据**：本次 GitHub 快照显示约 3,134 次提交、3.3k Stars、578 Forks，并有独立的 JS/TS 文档、示例和 API reference 入口。[仓库页](https://github.com/langchain-ai/langgraphjs)
- **与当前项目适配性（判断）**：最高。现有 Node/TS Agent Team 可把一次任务或一个 Agent slice 映射为 graph node，把任务 ID 映射为 `thread_id`，把现有 PostgreSQL/SQLite 状态存储适配到 checkpointer；控制面仍可保留当前审批、预算、工作区边界和事件投影。摘要可作为独立 node 或在 checkpoint 前的状态变换，不必把摘要行为误当作引擎默认能力。
- **明显风险**：图状态序列化、节点幂等和副作用边界必须严格定义；官方文档也提醒内存 checkpointer 重启即丢失、checkpoint 会无限增长，需要生产持久化和 retention。[官方持久化说明](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)

### 2. Mastra

- **仓库**：[`mastra-ai/mastra`](https://github.com/mastra-ai/mastra)。它是面向现代 TypeScript stack 的 Agent/AI 应用框架，可嵌入 Node、React、Next.js 或作为独立服务运行。[README](https://github.com/mastra-ai/mastra)
- **核心机制**：Agent 自主循环负责目标、工具选择和迭代；Workflows 用 `.then()`、`.branch()`、`.parallel()` 组织多步流程；Agent 或 Workflow 可以 suspend 等待用户输入/批准，storage 保存执行状态后无限期 resume。README 还列出 conversation history、retrieve、Observational Memory 和 MCP。[README](https://github.com/mastra-ai/mastra)；源码类型定义显示 suspended agent run 会持久化等待输入的快照，并可列出待恢复运行。[agent.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/agent.ts)
- **许可证**：核心及大多数代码 Apache-2.0；目录名为 `ee/` 的代码使用 Mastra Enterprise License，生产使用需要企业许可。[LICENSE.md](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md) [README licensing](https://github.com/mastra-ai/mastra#licensing)
- **活跃度/成熟度证据**：仓库页快照显示约 28.1k Stars、2.8k Forks，且为 pnpm monorepo，包含 workflow、stores、e2e-tests、Vitest 配置和 TypeScript 配置。[仓库页](https://github.com/mastra-ai/mastra)
- **与当前项目适配性（判断）**：高。对 Node/TS 代码、MCP、审批等待和可恢复 Workflow 的映射直接，能较快承接当前聊天、资源审阅和 Agent 编排。若希望保留现有控制面，可只引入 workflow/storage 层，不必采用 Mastra Studio。
- **明显风险**：仓库同时包含 Apache 核心和 `ee/` 企业目录，依赖审计需按实际 import 路径做许可证边界检查；suspend/resume、memory 和 workflow API 仍需锁定版本并做恢复回归。README 的“上下文管理”描述 memory/retrieve，不等于保证自动上下文压缩。[README](https://github.com/mastra-ai/mastra)

### 3. Temporal TypeScript SDK

- **仓库**：[`temporalio/sdk-typescript`](https://github.com/temporalio/sdk-typescript)。Temporal 被定义为分布式、可扩展、持久且高可用的长时间业务编排引擎；TypeScript SDK 用 TypeScript/JavaScript 编写 Workflow 和 Activity。[README](https://github.com/temporalio/sdk-typescript)
- **核心机制**：Workflow 代码负责确定性编排，Activity 承载外部 I/O，可由 Temporal 进行重试和恢复；Child Workflow、Signal、Query、Timer、continueAsNew 支持长生命周期流程。官方 TypeScript integration 还提供 OpenAI Agents SDK 集成：Agent loop、工具选择和 handoff 在 Workflow 中运行，模型调用作为 Activity 执行，Worker 重启后继续运行。[OpenAI Agents integration](https://github.com/temporalio/documentation/blob/main/docs/develop/typescript/integrations/openai-agents.mdx) [samples](https://github.com/temporalio/samples-typescript)
- **许可证**：MIT。[LICENSE](https://github.com/temporalio/sdk-typescript/blob/main/LICENSE)
- **活跃度/成熟度证据**：SDK 仓库页快照显示约 1,540 次提交、913 Stars、221 Forks，包含 client/worker/workflow/activity/testing 等拆分包和 API 文档链接；README 明确官方支持 Node 20/22/24。[仓库页](https://github.com/temporalio/sdk-typescript)
- **与当前项目适配性（判断）**：基础设施层适配高。现有任务状态、审批等待、预算租约、重启恢复可映射到 Workflow/Signal/Activity，Node 24 运行边界与官方支持范围一致。它适合承接真正跨进程、跨机器、长时间运行的主循环。
- **明显风险**：需要部署 Temporal Server/Cloud、Worker 和运维链路；Workflow 必须确定性可重放，模型上下文摘要、事件审计和业务幂等仍需自行设计。引入它会把当前轻量 Bundle 变成外部编排基础设施项目。

### 4. Inngest

- **仓库**：[`inngest/inngest`](https://github.com/inngest/inngest)。其核心是 durable functions，以事件、队列、step 和状态存储替代手写队列/调度。[README](https://github.com/inngest/inngest)
- **核心机制**：`step.run()` 把 LLM 调用、工具执行或保存结果变成可重试、可恢复的步骤；`waitForEvent` 暂停并由匹配事件恢复，Runner 把初始事件、step 输出和错误写入 State store；`step.invoke()` 可同步等待子函数结果，适合把子 Agent 当作子任务。[README](https://github.com/inngest/inngest) [AI durable steps](https://github.com/inngest/website/blob/main/content/blog/ai-agents-inngest-durable-steps.mdx) [SDK checkpoint spec](https://github.com/inngest/inngest/blob/main/docs/SDK_SPEC.md)
- **许可证**：Server 和 CLI 使用 Server Side Public License + delayed open source publication（DOSP）下的 Apache 2.0；SDK 使用 Apache 2.0。[README license](https://github.com/inngest/inngest#license)
- **活跃度/成熟度证据**：仓库页快照显示约 6,320 次提交、5.8k Stars、354 Forks；README 列出 TypeScript/JavaScript、Python、Go、Kotlin/Java SDK，并有 self-hosting、Dev Server、Dashboard 和公开架构说明。[仓库页](https://github.com/inngest/inngest)
- **与当前项目适配性（判断）**：任务层适配高。Node/TS 任务可以按切片包成 step，利用现有 PostgreSQL 或 Inngest State store 保存增量结果；事件、并发、取消和人工等待很适合当前任务队列与审批流程。
- **明显风险**：它持久化“步骤结果”，不提供 Codex 式消息上下文压缩或 Agent 身份模型，摘要、上下文窗口和 tool-call 语义仍需在业务代码中实现。Server/CLI 的许可证和 SDK 不同；每一步的 checkpoint/网络往返也会改变现有运行时性能与故障模型。[SDK spec](https://github.com/inngest/inngest/blob/main/docs/SDK_SPEC.md)

### 5. OpenHands Software Agent SDK

- **仓库**：[`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk)。README 明确 SDK 提供 Python、TypeScript 和 REST API，可处理一次性任务、日常维护和多 Agent 重构，并支持本机或 Docker/Kubernetes 工作区。[README](https://github.com/OpenHands/software-agent-sdk)
- **核心机制**：`ConversationState.create()` 会从持久化目录/FileStore 创建或恢复会话，状态与 EventLog 可自动保存；恢复时验证会话 ID、Agent 和工具兼容性。`LocalConversation` 支持按事件追加状态、fork 会话、按事件导航 HEAD，保留分支历史；Agent Server 负责 conversations、workspaces、events 和 REST/WebSocket API。[state.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/state.py) [local_conversation.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py) [README architecture](https://github.com/OpenHands/software-agent-sdk#repository-boundaries)
- **许可证**：MIT。[LICENSE](https://github.com/OpenHands/software-agent-sdk/blob/main/LICENSE)
- **活跃度/成熟度证据**：SDK 仓库页快照显示约 2,345 次提交、250 Issues、281 PR，包含 TypeScript client、Agent Server、SDK、tools、workspace、tests 等分层；上层 OpenHands 仓库显示约 8,234 次提交、88.1k Stars、11.5k Forks。[SDK 仓库页](https://github.com/OpenHands/software-agent-sdk) [OpenHands 仓库页](https://github.com/OpenHands/OpenHands)
- **与当前项目适配性（判断）**：Agent 语义和代码工作区能力很接近 Codex-like 长任务，EventLog/fork/navigate 也适合检查点与分支恢复；但现有主代码是 Node/TS，实际更可能通过 REST/WebSocket 或 TS client 作为远程执行层，而不是直接嵌入核心循环。
- **明显风险**：Python SDK、Agent Server、TypeScript client、Automation 是多仓库边界；升级和部署需同时锁定协议与 Agent/工具配置。源码还要求恢复时工具集合匹配，工具变更可能使旧会话无法直接恢复。[state.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/state.py)

### 6. Letta / letta-code

- **仓库**：[`letta-ai/letta-code`](https://github.com/letta-ai/letta-code)；平台仓库 [`letta-ai/letta`](https://github.com/letta-ai/letta)。Letta README 指出当前运行时、CLI、App Server 和桌面/Web 使用的源码已转到 `letta-code`，并提供 npm 安装与 TypeScript Agent SDK。[平台 README](https://github.com/letta-ai/letta) [letta-code README](https://github.com/letta-ai/letta-code)
- **核心机制**：Letta 把 context 分为始终在窗口中的 core memory、窗口外的 archival memory 与可搜索 conversation history；MemFS 用 Git 跟踪 memory blocks，dreaming 用后台 subagent 整理经验。官方文档说明历史消息在上下文满时移入 history，Agent 可以触发 summarization；release notes 记录 context window compaction 的修复和默认窗口调整。[memory architecture](https://github.com/letta-ai/skills/blob/main/letta/agent-development/references/memory-architecture.md) [letta-code context architecture](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md) [release notes](https://github.com/letta-ai/letta/releases)
- **许可证**：平台仓库标注 Apache-2.0。[LICENSE](https://github.com/letta-ai/letta/blob/main/LICENSE)
- **活跃度/成熟度证据**：平台仓库页快照显示约 7,474 次提交、24.8k Stars、2.6k Forks，并明确标记 actively developed；同时提示旧 `archive` 分支是历史 API，当前项目应使用 `letta-code`。[平台仓库页](https://github.com/letta-ai/letta)
- **与当前项目适配性（判断）**：若当前主要缺口是跨会话 memory、上下文压缩和长期 Agent 身份，Letta 的机制最贴近需求；npm CLI、App Server 和 TypeScript SDK 也降低 Node 集成门槛。它更适合作为 memory/context 服务，任务审批、切片验证和工作区边界仍留在现有 Team。
- **明显风险**：平台 README 已提示源码迁移边界，旧 API 和当前 `letta-code` 不能混用；自动 summarization/dreaming 会改变 Agent 可见上下文，必须保留可审计的原始事件和摘要版本。MemFS/数据库/Cloud 三种持久化路径也会增加运行时与数据治理复杂度。

### 7. goose

- **仓库**：[`aaif-goose/goose`](https://github.com/aaif-goose/goose)（原链接 `block/goose` 会重定向）。README 将它定义为可在本机运行的开源通用 Agent，提供桌面应用、CLI 和 API，Rust 实现，支持多模型和 MCP 扩展。[README](https://github.com/aaif-goose/goose)
- **核心机制**：CLI 提供命名 session、`--resume`、可选 JSONL session path、recipe/sub-recipe、`--max-turns` 等控制；recipe 把指令、模型和扩展配置打包成可复用流程。[CLI commands](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/goose-cli-commands.md) [recipe reference](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/recipes/recipe-reference.md)
- **许可证**：Apache-2.0。[LICENSE](https://github.com/aaif-goose/goose/blob/main/LICENSE)
- **活跃度/成熟度证据**：仓库页快照显示约 54.3k Stars、6.2k Forks，包含 Cargo lock、桌面 UI、CLI、API、release checklist、security 文档，并属于 Linux Foundation Agentic AI Foundation。[仓库页](https://github.com/aaif-goose/goose)
- **与当前项目适配性（判断）**：可作为外部 coding Agent 或 ACP/MCP backend 参考，尤其适合观察 session、recipe 和终端工作流；对当前 Node/TS Team 的内嵌适配较弱，更合理的接入是通过进程/ACP/API 适配。
- **明显风险**：Rust 原生实现导致直接复用成本高；社区 issue 曾记录从 recipe 启动的扩展没有随 session resume 一并恢复，说明“会话可恢复”不自动等于“工具/配置完全恢复”。[issue #4295](https://github.com/aaif-goose/goose/issues/4295)

### 8. CrewAI

- **仓库**：[`crewAIInc/crewAI`](https://github.com/crewAIInc/crewAI)。README 将 Crews 定义为角色化自主 Agent 协作，将 Flows 定义为事件驱动、精确控制的生产流程。[README](https://github.com/crewAIInc/crewAI)
- **核心机制**：`@persist` 为 Flow 自动持久化状态，默认使用 SQLite；`kickoff(inputs={id})` 从最新 snapshot 恢复并延续同一 flow，`restore_from_state_id` 可从 checkpoint fork，源历史保留。文档还说明可将 `@persist` 放在类级或方法级，并支持 structured/unstructured state。[Flow persistence](https://github.com/crewAIInc/crewAI/blob/main/docs/v1.15.12/en/concepts/flows.mdx)
- **许可证**：MIT。[LICENSE](https://github.com/crewAIInc/crewAI/blob/main/LICENSE)
- **活跃度/成熟度证据**：仓库页快照显示约 58.6k Stars、8.5k Forks；README 有 Crews/Flows、教程、生产架构、遥测和贡献说明。[仓库页](https://github.com/crewAIInc/crewAI)
- **与当前项目适配性（判断）**：Agent 编排和持久 Flow 概念清楚，适合拿来对照“团队 + 工作流 + checkpoint/fork”设计；对当前 Node/TS 项目只能通过 Python 服务或重写协议接入。
- **明显风险**：核心要求 Python 3.10–3.13 和 `uv`，不能作为 Node 进程内依赖；Flows 的持久化是应用状态快照，模型消息上下文压缩和安全审批仍需自建。[README installation](https://github.com/crewAIInc/crewAI#installation)

### 9. Pydantic AI

- **仓库**：[`pydantic/pydantic-ai`](https://github.com/pydantic/pydantic-ai)。README 将它定义为端到端类型化的 Python Agent SDK，并把 Harness 的 memory、sub-agents、context management、coding agent 作为可组合 capability。[README](https://github.com/pydantic/pydantic-ai)
- **核心机制**：官方文档明确支持长时间、异步、HITL Agent 的 durable execution，并维护 Temporal、DBOS、Prefect、Restate、AWS Lambda durable functions 等后端；README 的 coding-agent 示例把 context management 描述为可支撑长会话，multi-agent 文档说明自动 conversation summarization。[durable execution overview](https://github.com/pydantic/pydantic-ai/blob/main/docs/durable_execution/overview.md) [multi-agent applications](https://github.com/pydantic/pydantic-ai/blob/main/docs/multi-agent-applications.md) [README](https://github.com/pydantic/pydantic-ai)
- **许可证**：MIT。[LICENSE](https://github.com/pydantic/pydantic-ai/blob/main/LICENSE)
- **活跃度/成熟度证据**：仓库页快照显示约 3,002 次提交、20.0k Stars、2.7k Forks；仓库含 pydantic-graph、evals、durable execution 文档和测试目录。[仓库页](https://github.com/pydantic/pydantic-ai)
- **与当前项目适配性（判断）**：机制上覆盖“类型化 Agent + 上下文管理 + 子 Agent + durable execution”，适合作为设计参照或独立 Python Agent 服务；Node/TS 主项目若直接采用，需要跨语言 RPC 或运行第二套 Python 服务。
- **明显风险**：核心和 Harness 均是 Python；durable 能力依赖 Temporal 等外部运行时，必须遵守 workflow determinism 和持久化兼容约束。Pydantic AI 文档还说明 standalone graph builder 不负责 snapshot，保存/恢复/分叉需要 `StepPersistence` capability 或 durable backend。[changelog](https://github.com/pydantic/pydantic-ai/blob/main/docs/changelog.md)

### 10. OpenAI Codex CLI / App Server（基准实现）

- **仓库**：[`openai/codex`](https://github.com/openai/codex)。它是本次比较的基准实现，不建议把整个 CLI 当作当前 Team 的库依赖。
- **核心机制**：App Server 协议提供 `thread/resume` 继续已保存 thread，`thread/compact/start` 触发手动历史压缩，并发出 `contextCompaction` item；协议还覆盖 thread fork、archive 和持久附件。源码 issue 的 deterministic session checkpoint 提案进一步说明了“无需额外 model call、压缩后注入 checkpoint”的目标。[App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) [checkpoint issue](https://github.com/openai/codex/issues/8573)
- **许可证**：Apache-2.0。[LICENSE](https://github.com/openai/codex/blob/main/LICENSE)
- **活跃度/成熟度证据**：仓库页快照显示约 124.5k Stars、19.2k Forks；包含 Rust CLI、App Server、SDK、安装器、CHANGELOG、security 和多平台发布资产。[仓库页](https://github.com/openai/codex)
- **与当前项目适配性（判断）**：对“长任务 + 压缩 + resume + thread 生命周期”的产品行为最有参考价值；协议分层也适合当前宿主继续保留 Node/TS。直接复用需要接受 Codex 的 thread/item 协议、模型/工具生命周期和 Rust App Server 边界，若只借鉴机制，LangGraph.js 或 Temporal 更容易渐进接入。
- **明显风险**：它是完整 coding-agent 产品，接口随 App Server 演进；Codex 的 compaction 语义与当前项目审批、预算、任务切片和 evidence ledger 不同，不能把 `thread/resume` 当作业务任务恢复的充分条件。

## 上下文压缩专项调研

### 结论

上下文压缩不能只做成“把最早的消息删掉”。长任务里最容易膨胀的是工具输出，最不能丢的是用户约束、已确认决策、当前文件/检查点、未解决问题和待审批项。因此最终方案采用分层压缩：先做无需模型调用的工具结果清理，再做结构化摘要；只有模型供应商明确支持时才启用服务端原生 compaction。

### 可复用的实现模式（基础路径）

| 模式 | 证据与做法 | 适合当前项目的用法 |
| --- | --- | --- |
| 工具结果清理 | LangChain/LangGraph 的 `contextEditingMiddleware` 可按阈值清除旧工具结果，并保留最近若干结果；它不需要摘要模型，行为可预测。[context editing](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in) | 作为第一层，优先处理日志、搜索结果、命令输出等可重新获取内容 |
| 滑动窗口/裁剪 | LangGraph.js 提供 `trimMessages`，按 token 数裁剪并保持 human/tool 边界；官方同时把 trim、delete、summarize 和 checkpoint 列为短期记忆管理策略。[短期记忆](https://docs.langchain.com/oss/javascript/langgraph/add-memory) | 作为硬上限兜底；不能切断 assistant tool call 与对应 tool result 的原子组 |
| 结构化摘要 | LangChain 的 `summarizationMiddleware` 按 token、消息数或上下文比例触发，保留最近消息并用摘要替换旧历史。[summarization middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in) | 主压缩路径；摘要必须写成可校验字段并保留原始事件引用 |
| 供应商原生压缩 | OpenAI Responses API 的 `/responses/compact` 返回压缩后的 response；OpenAI 建议在长、工具密集流程的阶段边界执行，并把压缩结果当作 opaque item 继续传递。[OpenAI compact API](https://developers.openai.com/api/reference/java/resources/responses/methods/compact) [模型指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2) | 对支持 Responses compaction 的模型作为可选高保真路径；Qwen/DeepSeek 的普通 OpenAI-compatible 接口没有该能力时不能假设可用 |
| 供应商原生压缩（Anthropic） | Anthropic 的 server-side compaction 在阈值到达后生成 `compaction` block，后续请求只需 round-trip 该 block；文档将其定位为长任务的主要策略。[Anthropic compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) | 通过 provider adapter 接入，和 OpenAI 路径保持同一 `ContextManager` 接口 |
| 预留式阈值 | Microsoft Conductor 用 `Context Window - Output Limit - Effective Tool Buffer` 计算触发点，并把目标压到触发点以下，避免刚压缩完下一轮立即再次触发。[阈值算法](https://github.com/microsoft/conductor/blob/main/docs/workflow-syntax.md) | 采用该计算方式，不再用固定“累计 token 到 1M”判断上下文是否安全 |

### 高级压缩方案比较

以下方案解决的是“如何少放上下文、仍可找回事实”，能力强于单纯 trim + 一次性 summary。成熟度证据只取公开仓库的源码、文档结构或仓库页面；“适配”是对当前 Node/TS Team 的判断。

| 方案 | 分层/增量/检索机制 | 回滚与审计能力 | 成熟度证据 | Node/TS 接入判断与风险 |
| --- | --- | --- | --- | --- |
| **DeepAgents.js 历史外置摘要** | 摘要触发后把旧消息追加写入 backend 的 `/conversation_history/{thread_id}.md`；状态记录 cutoff，后续有效上下文由 summary + cutoff 后消息重建；同时支持旧 tool arguments 截断。[TypeScript 源码](https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/middleware/summarization.ts) | 每次驱逐的原文追加保存，适合保留 `cutoffIndex`、来源范围和 hash；可从 backend 重新取回。 | 官方仓库包含 TypeScript middleware、backend protocol、测试和 JS 示例源码，机制可直接检查。 | **高**；最接近当前 LangGraph.js。需要把 markdown/backend 换成现有 artifact store，并补充事件权限、hash 校验和并发锁；源码版本需锁定。 |
| **LangChain Context Editing** | `ClearToolUsesEdit` 按 token 阈值清理旧工具结果，保留最近 N 个，可排除指定工具、设占位符和是否清理输入；与 `SummarizationMiddleware` 分离，能先做无模型调用的低损压缩。[官方 JS 文档与源码索引](https://github.com/langchain-ai/docs/blob/main/src/oss/langchain/middleware/built-in.mdx) | 原消息被编辑后不能单凭上下文恢复，因此完整 tool output 必须先存 artifact，并让占位符包含引用。 | LangChain 官方文档给出 JS 配置和参数；机制在开源 middleware 中实现。 | **高**；可作为 provider-agnostic 的第一层。风险是工具调用/结果配对和 provider role 顺序，必须在发送前校验；工具结果若未外置会不可逆丢失。 |
| **Mem0 OSS 事实记忆 + 混合检索** | Node SDK 支持 `add`/`search`；OSS 搜索组合语义、BM25、实体信号，并支持 `userId`、类别等过滤，适合只取当前问题相关的历史事实。[Node quickstart](https://github.com/mem0ai/mem0/blob/main/docs/open-source/node-quickstart.mdx) [搜索文档](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/memory-operations/search.mdx) | 每条 memory 带 ID/metadata，可回指任务或用户范围；但检索结果是派生记忆，不能代替原始事件账本或 checkpoint。 | 仓库提供 OSS Node/TS quickstart、可替换 LLM/embedder/vector store 的配置和搜索 API；README 还区分 OSS 与托管平台能力。[README](https://github.com/mem0ai/mem0/blob/main/README.md) | **高（作为外部记忆层）**；适合跨任务稳定事实。风险是抽取错误、过期事实和跨租户污染，必须强制 scope、时间、来源事件和人工/规则纠错。 |
| **Graphiti 时间上下文图** | episode 保存原始输入；bi-temporal fact 记录摄入时间、事件发生时间以及 valid/invalid 关系；可增量更新、混合检索和按时间查询。[仓库 README](https://github.com/getzep/graphiti) [MCP 源码](https://github.com/getzep/graphiti/blob/main/mcp_server/src/graphiti_mcp_server.py) | 每个派生事实可追溯到 episode，历史保留且被新事实替代时不必覆盖旧事实，适合可解释回溯。 | 官方仓库有 core、MCP server、Neo4j/FalkorDB 配置和测试；MCP 源码明确 `group_id`、episode 与双时间字段。 | **中**；通过 MCP/HTTP 作为独立服务接入 Node。核心 Python + 图数据库增加部署、抽取错误和并发复杂度；建议仅用于跨任务检索，不放进任务恢复主链路。 |
| **Mem0/Graphiti 之外的 LangGraph Store 检索** | LangGraph 将短期 thread state 与跨线程长期 store 分开；memory 文档建议把长期记忆写入 store，按查询取回，而不是把全部历史塞进每次模型调用。[LangGraph memory](https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/memory.md) | Store 记录可与 `thread_id`、checkpoint 和 source event 关联；checkpoint 本身保存状态快照，支持读取历史和时间旅行。[LangGraph persistence](https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/persistence.md) | LangGraph.js 官方 JS/TS 仓库、概念文档和持久化实现形成同一生态，已有 PostgreSQL/SQLite checkpointer 选择。 | **最高**；先用项目现有 DB 建最小 scoped store，避免立即引入向量/图数据库。检索排序和记忆更新策略需自建，不能把“命中”当成事实正确。 |
| **供应商原生 compaction 适配器** | OpenAI Responses `/responses/compact` 返回 opaque/encrypted compaction item；Anthropic 文档描述阈值触发的 compaction block。两者均要求后续请求原样携带压缩项。[OpenAI API](https://developers.openai.com/api/reference/java/resources/responses/methods/compact) [Anthropic API](https://platform.claude.com/docs/en/build-with-claude/compaction) | 原生压缩项适合 continuation，不适合作为业务审计内容；本地 manifest、原始事件和 artifact 仍需保留。 | OpenAI Node SDK 已暴露 `responses.compact` 类型/API；Anthropic 是官方 API 文档能力，非当前仓库可嵌入实现。[OpenAI Node](https://github.com/openai/openai-node/blob/main/src/resources/responses/api.md) | **条件性高**；通过 provider capability adapter 做多供应商路由。风险是 Qwen/DeepSeek 的普通 OpenAI-compatible 接口可能不支持该扩展，不能按名称推断；必须有本地 tool edit + summary fallback。 |
| **Cline SDK 分离式 compaction** | `@cline/agents` 保持 canonical transcript append-only，`@cline/core` 在 turn preparation 中选择 agentic/basic 策略，并把工作上下文另存为 `${sessionId}.compaction.json`；恢复时按 canonical prefix hash 校验 compaction state，再拼接边界后的新消息。[架构文档](https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md) | 原始 session messages 与 compaction artifact 分离，hash 不匹配就不能复用旧压缩状态；源码还提供自定义 compaction plugin 示例，支持中段历史摘要、保留首个用户消息和近期工作上下文。[自定义插件](https://github.com/cline/cline/blob/main/sdk/examples/plugins/custom-compaction.ts) | 仓库有公开 SDK、`@cline/core`/`@cline/agents` 分层、CLI、插件示例和 changelog；changelog 记录 agentic 默认、tool-heavy cut point、OpenAI-compatible base URL 和 deterministic overflow fallback 的修复。[SDK README](https://github.com/cline/cline/blob/main/sdk/README.md) [changelog](https://github.com/cline/cline/blob/main/sdk/CHANGELOG.md) | **最高（压缩架构参考）**；Node/TS 边界、append-only transcript、独立 artifact、hash 校验和 agentic/deterministic 双策略与当前 Team 最契合。建议借鉴数据流和恢复协议，保留现有 LangGraph checkpoint/审批/预算；直接依赖 Cline SDK 会引入另一套 session/tool/provider 生命周期，需先做依赖与许可证审计（仓库 LICENSE 为 Apache-2.0）。[LICENSE](https://github.com/cline/cline/blob/main/LICENSE) |

推荐的强度分层是：**事件/产物账本（事实源）→ 工具结果编辑（无模型调用）→ 滑动窗口（确定性硬上限）→ Cline 式独立 compaction artifact + canonical prefix hash → 增量摘要并外置原文 → scoped retrieval（长期事实）→ 原生 compaction（有能力时的优化）**。每一层都输出来源 ID 和策略版本；恢复只重建上下文投影，不覆盖事实源。

**专项结论**：压缩实现只借鉴 Cline SDK 的分离式 compaction 协议，不直接把 Cline runtime 接入 Agent Team；执行、checkpoint、人工介入和故障恢复继续由 LangGraph.js 承担；Mem0/Graphiti 只作为后续的跨任务记忆层候选。

### 最终整合方案

1. **执行内核**：使用 LangGraph.js。现有 `taskId` 映射为 `thread_id`，开发切片映射为 graph node；PostgreSQL checkpointer 保存每个 super-step。现有审批、预算账本、工作区边界、事件投影和 evidence ledger 继续由宿主掌管。
2. **上下文管理器**：`ContextManager` 是当前项目要实现的本地适配层接口，不是另一个需要下载的开源产品。在模型调用前统一经过它，不让每个 Agent 自己决定是否删消息。实现可组合 LangChain/LangGraph.js 的 tool-result editing、裁剪与摘要能力，并采用 Cline 的“独立 compaction artifact + canonical prefix hash”恢复协议；按 provider 能力调用原生 compaction。它输出 `contextHash`、估算 token、压缩动作和来源事件列表，便于重启和审计。[LangChain JS middleware](https://github.com/langchain-ai/docs/blob/main/src/oss/langchain/middleware/built-in.mdx) [Cline compaction architecture](https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md)
3. **触发计算**：以模型上下文上限为基础，预留最大输出、工具结果缓冲和安全余量：`trigger = contextWindow - outputLimit - toolBuffer - margin`。达到预警阈值时先清理旧工具结果；达到 trigger 才生成摘要；摘要目标保持在 trigger 以下，形成滞后区间。
4. **保留规则**：始终保留系统指令、当前用户需求、已确认需求/设计、未解决问题、待审批项、最新检查点、最新验证结果、下一步动作和当前轮工具组。旧工具输出只保留摘要和 `eventId/artifactId` 引用，原始内容留在事件日志中。
5. **摘要格式**：摘要使用版本化结构，至少包含 `objective`、`constraints`、`decisions`、`approvedArtifacts`、`filesChanged`、`verification`、`pendingApprovals`、`blockers`、`nextAction`、`sourceEventIds`。模型可读文本只是渲染结果，恢复依据是结构化字段和来源引用。
6. **供应商适配**：Responses-compatible 模型优先调用原生 compaction；其他模型走本地工具清理 + 结构化摘要。原生返回的加密/opaque block 只原样保存和回传，不解析内部格式。摘要请求单独计入预算，不能绕过预算账本。
7. **原子恢复**：压缩前先写 checkpoint；压缩成功后再写新 checkpoint。压缩请求超时、取消或返回无效摘要时回滚到旧 checkpoint，原始事件不删除，任务显示可恢复。OpenAI Agents SDK 的实现也把“清空并重写历史”视为需要恢复保护的替换操作，并提示自动压缩可能延迟流结束。[compaction session](https://github.com/openai/openai-agents-python/blob/main/docs/sessions/index.md)
8. **预算切分**：区分“单次模型窗口预算”“压缩预算”和“任务累计预算”。达到单次窗口预算时继续使用新 checkpoint/window，任务累计上限仍保留硬门禁，避免当前项目再次出现累计用量超过单任务上限后才暴露问题。
9. **用户体验**：压缩是 Agent 的后台阶段产物，在聊天时间线显示轻量状态“正在整理上下文 / 已保存检查点”；失败时显示原因和“恢复任务”，不弹居中遮罩，也不要求用户寻找隐藏面板。

本轮隔离实现位于 [`packages/agent-team/src/context-manager.ts`](../../packages/agent-team/src/context-manager.ts)，只作为 provider-neutral 的本地适配层，不会自动替换当前 Agent Team。新增的 [`spikes/t25-langgraph/`](../../spikes/t25-langgraph/) 锁定 LangGraph.js 与 PostgreSQL checkpointer 版本，已验证真实 `StateGraph` 的 interrupt/resume、压缩投影、进程重启恢复和工具幂等；该 spike 依赖审计为 0 high/0 critical（见 `.backend-team/artifacts/langgraph-t25-dependency-audit-20260916.json`），不属于生产 Bundle，未宣称生产可用。

其中 `ContextBudgetWindow` 只负责窗口级 token、压缩 token 和任务累计 token 的边界计算；实际模型请求和压缩请求仍必须由宿主在调用前后向它计账，再由现有 durable budget ledger 记录任务级终态，避免把“换了窗口”误判成“获得了额外任务预算”。

### 与现有宿主的接线边界

| 现有能力 | LangGraph 接入方式 | 保留的权威来源与门禁 |
| --- | --- | --- |
| 任务与恢复 | `taskId` 映射为 `thread_id`；一个开发切片对应图的一次可恢复运行 | 任务注册表、`BackendTeamState.revision`、阶段和运行终态仍由现有 StateStore/EventStore 掌管 |
| 工作区并发 | 只有持有 `OwnershipManager` 的任务租约才允许驱动图；同进程由 kernel 按 `thread_id` 串行化 prepare/resume | `.backend-team/locks/ownership` 的跨进程互斥和 recovery token 继续生效；PostgreSQL checkpoint 不能替代工作区租约 |
| 预算 | 每次模型/压缩请求向 `ContextBudgetWindow` 计账；窗口轮换不增加任务累计上限 | `DurableBudgetLedger` 仍记录 AgentTask 的总 tokens、wallMs、toolCalls 等终态，预算耗尽仍进入 blocked |
| 人工介入 | LangGraph `interrupt` 只负责挂起和恢复值传递 | 现有审批服务负责来源、文档哈希、版本校验、会话和用户权限；不能在 graph node 内直接批准 |
| 事件与审计 | graph checkpoint 与 compaction artifact 保存恢复状态和来源 ID | 原始事件、审批记录、handoff、验证证据继续写现有账本；LangGraph 输出不能绕过证据校验 |

因此，真实生产接线的最小形态应是“宿主先取得任务租约和预算，再调用带 `thread_id` 的 LangGraph kernel；kernel 在模型调用前经过 ContextManager，遇到人工审批返回 interrupt，最终结果仍交回现有 verifier/StateStore”。跨进程恢复必须先确认租约归属和运行终态，再读取 checkpoint；单独读取 PostgreSQL 最新 checkpoint 不能证明任务可以继续。

本轮已把这条边界整理为 `LongTaskExecutionSession`：它先取得宿主提供的跨进程运行锁，再通过 `LongTaskOwnershipPort` 核对现有工作区租约，之后才打开 ContextManager；会话内对 append、prepare、tool side effect 和 checkpoint 写入串行化，成功工具以幂等键记录，模型/压缩 token 同时进入窗口预算和可选的 `DurableBudgetLedger`。该 session 不依赖 LangGraph，因此可以由隔离 kernel 调用，也不会另起一套审批或权限语义。使用真实 `FileDevelopmentCheckpointStore` 运行锁、文件 checkpoint 与 durable ledger 的回归已通过；Bundle 提供显式绑定工厂，正式文档宿主在开启 development execution 时把它接到真实切片运行，并与嵌套 Agent 共享同一进程内重入锁。

### 高级方案的边界与验证重点

分层记忆和检索提高可用上下文的密度，却引入派生事实错误、过时事实和权限串线风险；工具结果编辑提高确定性，却要求完整结果已经外置；原生 compaction 降低自建摘要成本，却可能是不可读、不可移植的供应商格式。最小 PoC 应覆盖：工具输出超过窗口、连续多次增量摘要、检索到过时事实、压缩中断后重启、artifact 缺失或 hash 不匹配、旧 tool-call 配对、审批等待/恢复和并发 resume/compaction。验收要记录恢复正确性、审计可追溯性、摘要遗漏和 token/cost，不能只看最终回答是否生成。

### 验收标准

- 连续工具调用达到阈值后，下一次模型请求不超过上下文安全上限。
- 压缩后 Agent 仍能回答原始需求、遵守已确认约束，并识别待审批项。
- 已成功的工具调用在恢复后不重复执行；失败工具可以按幂等键重试。
- 压缩失败、进程重启、网络超时和用户审批中断均能回到最近可用 checkpoint。
- 原始事件、摘要版本、压缩触发原因、压缩用量和恢复关系可在任务资源中查看。
- Qwen/DeepSeek 普通 OpenAI-compatible 接口不提供原生 compaction 时，仍能依靠本地策略完成同一恢复闭环。

## 推荐落地顺序

1. 本轮已完成本地 `ContextManager` 隔离 spike：先验证 append-only transcript、独立 compaction artifact、工具结果清理、确定性兜底、文件 checkpoint、恢复幂等和失败回滚，并补充模型窗口/压缩/任务累计预算分账。
2. 本轮已完成 LangGraph.js + PostgreSQL 的隔离执行 spike：将一个可恢复切片映射为 `thread_id + checkpoint`，真实验证 PostgreSQL 持久化、故障后不重做已成功工具、HITL 后继续、压缩前后原始上下文一致、同线程并发压缩串行化和进程重启恢复。
3. 已将 spike 的边界整理为 `LongTaskExecutionSession` 并接入隔离 LangGraph kernel：它先取得宿主运行锁、核对 workspace boundary，再开放 durable context；模型/压缩预算可回写现有 durable ledger。`HarnessAgentRuntime` 现在提供可选 `executionSessionFactory`，在真实 DSH Agent 请求前后接入 transcript、context preparation（可返回压缩后的 model prompt）和实际 token 计账；未提供工厂时保持原行为。子进程崩溃后的运行锁恢复、进程内 `SharedLongTaskRunLease` 重入和工作区生产依赖审计已通过；正式文档宿主已在 development execution 配置下把工厂和共享锁接到真实切片运行，规格 Agent 会按所有权选择跳过绑定。LangGraph 仍只放在 Agent execution kernel，摘要作为显式、可审计的状态变换并保存原始消息引用。若后续确实需要跨进程/跨机器调度，再评估 Temporal；若更看重 TypeScript 内置 Agent/Studio/Observational Memory，再对 Mastra 做同样的恢复与许可证审计。

## 来源与限制

本调研使用候选项目 GitHub README、源码、许可证文件及其官方 GitHub 文档；活跃度数字是 2026-09-16 的仓库页面快照。未对任何候选执行安装、压力测试、故障注入或生产兼容性验证，因此“适配性”是源码/文档基础上的筛选判断，不能替代 PoC 和许可证审计。
