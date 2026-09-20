# Architecture — GUI Workflow Acceptance (Local `GET /health`)

**Feature ID**: `gui-workflow-acceptance` · **Date**: 2026-09-07 · **Companions**: `spec.md`、`clarification.md`、`plan.md`、`contracts/openapi.yaml`
**Status**: 设计工件，不含业务代码。本特性无任何运行时执行验证：AC-001–AC-005 与契约工具校验均 **NOT RUN**。

## Context

单机、单路由、无状态、匿名的存活应答端点。已批准需求的完整暴露面：一个请求形状 `GET /health`（含查询串变体）与三种结果（200/404/405）。

- 运行时：Node.js 24 内置模块（`node:http` 提供，`node:test`/`node:assert` 验证），零依赖、零安装步骤（AC-004/AC-005）。
- 网络：仅绑定 IPv4 字面量 `127.0.0.1:3001`，不监听通配地址；host/port 为代码常量，无 env/CLI 配置（R-03、Q-07）。
- 路由硬规则：`/health` 唯一、精确、大小写敏感（R-01）；路径判定优先于方法判定，即 404 优先于 405（Q-02）；`HEAD`/`OPTIONS` 按非 GET 返回 405，有意偏离 RFC（Q-01）。
- 明确排除：认证/授权、限流、会话、持久化、TLS/HTTP2/IPv6、其他端点与根路径页、CORS、内容协商、请求日志、富健康信息，以及一切自拟性能指标（Non-Goals、Q-11）。

## Module Boundaries

单进程、四个逻辑模块（实现轮可合并为「单服务文件 + 单测试文件」）：

| 模块 | 职责 | 边界规则 |
|---|---|---|
| M1 启动入口 | `createServer` + `listen(3001, '127.0.0.1')`；导出带默认值的内部工厂，仅测试注入临时端口（D-08） | 唯一调用 `listen` 之处；进程停止即释放端口（F-03） |
| M2 决策函数 | 纯函数 `decide(method, path) → 200\|404\|405`；先精确路径比较、后方法白名单；不解码、不归一化、不 strip 尾斜杠 | 无 IO、无状态、不感知 socket；R-01/Q-02/Q-06 的唯一裁决点 |
| M3 响应写出 | 200 写 `Content-Type: application/json` + 11 字节字面量 `{"ok":true}`；404/405 仅保证完整终止（Q-05）；不回显请求内容 | 不经 JSON 序列化器（D-04）；除状态码/头/常量体外无其他输出 |
| M4 测试模块 | `node:test`：行为用例走临时回环端口；AC-004 以代码字面量 + 仅 `node:*` 导入清单断言 | 不占用 3001，避免并行争抢（Q-09） |

不存在数据层、缓存层、消息层、代理层模块；依赖方向单向 M1→M2→M3，无环。

## Request Flow

```text
client ──TCP(loopback only)──▶ node:http
 1 取 method 与原始 req.url
 2 截断首个 '?' → 路径原始子串（查询不参与路由，Q-06）
 3 M2 互斥判定（顺序固定）：
   a) path !== '/health'                   → 404  ('/', '/health/', '/HEALTH', '/healthz', 'POST /nope' 止于此)
   b) path === '/health' && method !== GET → 405  (含 HEAD、OPTIONS，Q-01)
   c) 其余，即 GET /health                  → 200 + Content-Type + 11 字节常量体
 4 M3 res.end 完整终止；零连接状态，重复/并发应答一致（R-03）
 5 进程停止 → 释放监听端口（F-03）
```

无会话建立、无数据读写、无出站调用，单跳完成。

## API and Authentication

- 契约唯一来源 `contracts/openapi.yaml`（OpenAPI 3.1.0）：`paths` 仅 `/health`，其下 7 个操作（`get`→200；`post/put/patch/delete/head/options`→405）；`servers` 单项 `http://127.0.0.1:3001`。
- 200 体在 schema 层只约束形状（`ok` 恒 `true`、`additionalProperties: false`）；11 字节逐字节相等由验收测试断言（R-02、Q-03、AC-001）。`Content-Type` 发裸媒体类型，断言大小写不敏感并容忍可选 `charset`（Q-04）。
- 404 是「未匹配路径」的全局规则而非端点：以文档根扩展 `x-unmatched-path-rule` 承载，不用通配 path 模板伪装；`components.responses.NotFound` 仅作追溯、不被任何 path 引用。404/405 只断言状态码与完整终止，其正文、`Content-Type`、`Allow` 不在验收内（Q-05，见 `x-out-of-scope-response-details`）。
- 查询串以 `components.parameters.HealthQuery` 记录「不参与路由」这一事实（Q-06），不引入新资源。
- 认证：应用层无认证、授权、角色、会话、Cookie、凭据——属批准需求而非缺漏，契约以根级 `security: []` 显式记录且不发明任何 securityScheme（Q-08）。唯一访问控制即回环绑定本身（R-03）：凡能到达 `127.0.0.1:3001` 者获相同匿名只读探测；3001 为非特权端口无需提权；IPv6 `::1` 连不上属预期且不在验收内（Q-07）。响应不回显任何请求内容。

## Failure Model

| 情形 | 行为 | 依据 |
|---|---|---|
| 任意方法的非 `/health` 路径 | 404（优先于 405） | F-02、Q-02、AC-002 |
| `/health` 非 GET（含 HEAD/OPTIONS） | 405 | F-03、Q-01、AC-003 |
| 畸形请求行、客户端中途断开 | 交由 `node:http`；进程不崩溃、不半写响应 | R-03 稳定性 |
| 启动时端口占用（EADDRINUSE） | 快速失败：非零退出、不重试、不改端口 | Q-07 禁静默换绑 |
| 非回环 / IPv6 连接尝试 | 绑定层面不收连接，属预期，不作错误处理对象 | R-03、Q-07、AC-004 |
| 下游依赖不可用 | 不存在该路径：零第三方运行时依赖 | AC-004 |
| 实现附带诊断输出 | 不得改变任何 HTTP 应答、不得落盘数据 | spec Data and Privacy |
| 降级 / 熔断 / 重试 / 健康聚合 | 均不适用（无下游、无状态、无 SLA 指标） | Q-11 |

## Observability

日志非需求，默认不记录；无指标、无追踪、无告警集成（Non-Goals）。可观测性由契约级验证替代：`node:test` 套件枚举 F-01/F-02/F-03 全部行为分支（AC-005），行为用例走临时回环端口、AC-004 以配置字面量与导入清单断言完成（Q-09）。理由：零状态单路由的可观察行为已被 HTTP 应答本身完全覆盖，任何附加遥测只扩大暴露面而无验收价值。

## Alternatives

- **Express/Fastify 等框架**：否——违反零依赖/零安装（AC-004）；其默认路由行为（尾斜杠归一化、大小写选项、HEAD 自动镜像 GET）与 R-01、Q-01、Q-06 直接冲突。
- **框架式方法表（先 405 后 404）或 HTTP 语义路由**：否——与 Q-02「404 优先」固定规则冲突。
- **按 RFC 让 `HEAD`/`OPTIONS` 走 200/正常语义**：否——Q-01 已由用户明确采纳 405，该偏离即需求本身。
- **405 附 `Allow` 头、404/405 统一 JSON 错误体**：不纳入——Q-05 已排除在验收外；如需须作为新需求重新澄清。
- **env/CLI 配置 host 与端口，或通配绑定 + 防火墙兜底**：否——Q-07 定死代码字面量，R-03 禁止通配。
- **同时监听 `::1`**：否——IPv6 列 Non-Goals，且「连不上」已定为预期。
- **多进程 cluster / 并发与延迟目标**：否——本轮无容量指标（Q-11），单进程内置 server 足够。
- **契约中为 404 增设 `/{proxy+}` 式通配 path**：否——会凭空制造未批准端点（D-10）。

## Risks

1. **`HEAD`/`OPTIONS`→405 偏离 RFC 惯例**：成熟监控组件可能对 `HEAD /health` 报红或降频探测。缓解：Q-01 为用户明确裁决，架构与契约双处记录；变更须走新需求。
2. **逐字节断言脆弱性**：序列化器或中间件注入空白/BOM 即破坏 AC-001。缓解：D-04 冻结字符串字面量直写 + 测试断言 `byteLength === 11` 与逐字节相等。
3. **`localhost` 与 `127.0.0.1`/`::1` 解析差异**：测试若用 `localhost` 可能命中 IPv6 或 hosts 改写。缓解：显式使用 IPv4 字面量与临时端口（D-05、Q-09）。
4. **端口 3001 争抢**：本机其他进程占坑会让真端口冒烟失败。缓解：行为测试全部 `listen(0)`，AC-004 用配置断言（Q-09）。
5. **契约表达妥协**：404 全局规则放在根 `x-` 扩展中，严格消费方需同时读 `info.description`；且契约尚未经工具校验（由 plan.md 任务 T-00 承接）。
6. **D-08 工厂参数的解读面**：内部默认参数注入被判定不违反 Q-07（禁的是对外配置面）；若验收方不认可，回退为测试直接 import 决策函数（D-02 已保证其可测）。
7. **零运行时验证**：本特性目录内全部结论均为设计断言；在 `node --test` 真实跑绿之前，任何 AC 不得记为 passed。
