# Data Model: Greeting Demo

对应 `spec.md`（FR-005、FR-007、Data and Privacy、Non-Goals、Integrations）、`architecture.md`、`contracts/openapi.yaml`。

**结论：本功能没有持久化数据模型。** 已批准需求明确「不引入任何数据存储（无数据库、无文件写入、无缓存）」，FR-007 要求接口不读写状态，Non-Goals 排除数据库迁移，Integrations 标注数据库与外部服务不适用。因此本文件不设计 PostgreSQL schema：无表、无列、无索引、无约束、无迁移、无种子数据，也不存在备份/恢复面。以下各节逐条说明「为什么不适用」，并给出替代性事实——仅存在请求作用域内的临时数据形状。

## Table Purpose

不适用：表数量 0，无任何表用途可描述。唯一的数据形态是单次请求生命周期内的内存临时值，不跨请求、进程退出即消失、从不落盘：

| 临时值 | 产生位置 | 语义 | 是否持久化 |
| --- | --- | --- | --- |
| `name`（解码后 / trim 前后） | `handler.mjs` 解析 `searchParams` | 用户可控输入，trim 结果为空时按「访客」处理 | 否 |
| `message` | `format.mjs` 返回值 | 固定文案 `你好，<对象>` | 否 |

## Fields and Types

不适用：无表即无列，无需选择 PostgreSQL 列类型（`TEXT`/`UUID`/`TIMESTAMPTZ` 等），也没有 SQL 类型映射或字符集/Collation 决策。仅存在内存与传输层类型：

| 名称 | 宿主类型 | 传输表示 | 校验 |
| --- | --- | --- | --- |
| 请求路径 | `string`（WHATWG `URL.pathname`） | 请求行 | 必须等于 `/greeting`，否则 404 |
| `name` | `string \| undefined` | query（URL 解码，UTF-8） | 仅 `trim()`；无长度、无白名单校验 |
| `message` | `string` | JSON 值，UTF-8 编码 | 由固定模板生成，不接受外部结构 |
| 响应体 | `string`（`JSON.stringify`） | `application/json; charset=utf-8` | 单字段 `message`（FR-005） |

## Keys and Constraints

不适用：无表故无主键、唯一键、外键、CHECK、非空列，也无数据库级默认值。输入侧的等价规则由代码与契约承担，而非数据库约束：缺省 / 空值 / 仅空白 → 「访客」（AC-002~AC-004）；首尾空白剥离、中间空白原样保留（AC-005）；重复 `name` 取第一个值（FR-006 / AC-007）。`name` 在契约中只有 `type: string` 与 `required: false`，需求未提出长度限制，服务端不截断、不因超长报错，超长输入与其它输入一样原样参与拼装。响应侧的结构约束（`additionalProperties: false`、必填 `message`）由序列化代码保证（FR-005 / AC-006），不依赖数据库完整性机制。

## Indexes

不适用：无表、无持久化查询，故无 B-tree/GIN 索引、无覆盖索引、无统计信息或执行计划需求，也不存在需要索引支撑的查询路径。每次请求只做一次 O(1) 的 URL 解析与 `getAll('name')` 读取。需求未提出吞吐或延迟目标，不臆造指标（D-5）。

## Relationships

不适用：无实体，故无一对一 / 一对多关系、无级联、无联接视图或物化视图。`server → handler → format` 是模块依赖方向（见 `architecture.md` 的 Module Boundaries），不是数据关系，不产生任何外键语义，也不共享可变状态（FR-007）。

## Lifecycle

不适用数据库生命周期：无状态机、无状态转换列、无保留期、无分区 / 归档 / 软删 / 硬删策略、无触发器或审计表。实际生命周期发生在单个请求内：接收 → URL 解码 + `trim()` → 生成 `message` → 写出响应 → 内存可回收。进程关停（`SIGINT`，或测试结束时的 `close()`）不遗留任何需要清理或迁移的数据。

## Sensitive Data

不存储任何个人身份信息。`name` 是一次性输入，仅在内存中参与消息拼装（FR-007）；按 D-4 不记录原始 `name` 到日志或任何持久载体，错误响应与启动输出均不回显用户输入，除「监听地址打印 + 不含 `name` 的简述」外无其它输出面（`architecture.md: Observability`）。因此无加密、无脱敏、无密钥管理、无数据主体删除请求的处理路径。若未来引入问候历史或访问日志，`name` 将进入持久载体，属范围变更，需新需求与澄清后再更新本文件。

## Migration Notes

无迁移：不执行 `CREATE DATABASE` / `CREATE TABLE` / 任何 DDL，无版本化脚本、无 up/down 对、无数据回填、无锁与停机窗口考量，也不需要团队流程中的数据库准备或迁移生成环节。撤销方式为删除 `src/greeting-demo/` 与 `test/greeting-demo/` 两个新增目录（`plan.md` §5），不涉及数据回滚。
