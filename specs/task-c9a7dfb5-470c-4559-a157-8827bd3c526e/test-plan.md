# Test Plan: Greeting Demo

把 `spec.md` 的 AC-001 ~ AC-010 绑定到具体 Node 测试文件与证据 ID。运行环境 Node ≥ 18（内置 `node:test`、内置 `fetch`），零第三方依赖。无数据库类证据（见 `data-model.md`：本功能无持久化）。测试文件固定为 3 个，不新增第 4 个（不设边界审计类文件）。

## Requirement ID

覆盖已批准的全部验收标准，不新增 AC：AC-001 ~ AC-010（规则 FR-001~FR-007、决策 D-1~D-4）。

<!-- backend-team:evidence id=greeting-format file=test/greeting-demo/format.test.mjs requirements=AC-002,AC-003,AC-004,AC-005 -->
<!-- backend-team:evidence id=greeting-handler file=test/greeting-demo/handler.test.mjs requirements=AC-006,AC-007 -->
<!-- backend-team:evidence id=greeting-server file=test/greeting-demo/server.test.mjs requirements=AC-001,AC-002,AC-003,AC-004,AC-005,AC-006,AC-010 -->
<!-- backend-team:host-evidence id=greeting-workspace-boundary kind=workspace-boundary requirements=AC-008,AC-009 -->

## Evidence Type

| 证据 ID | 类型 | 文件 | 需求 |
| --- | --- | --- | --- |
| `greeting-format` | 纯函数单元断言（无 IO，import `src/greeting-demo/format.mjs`） | `test/greeting-demo/format.test.mjs` | AC-002~AC-005 |
| `greeting-handler` | 进程内 HTTP 断言（`http.createServer` + 临时监听，无第三方框架） | `test/greeting-demo/handler.test.mjs` | AC-006、AC-007 |
| `greeting-server` | 端到端断言 + import 静态检查（`port: 0` 真实回环监听 + 内置 `fetch`） | `test/greeting-demo/server.test.mjs` | AC-001~AC-006、AC-010 |
| `greeting-workspace-boundary` | 宿主证据（本设计不创建对应测试文件）：把当前工作区与本任务开发前的工作区快照比较，含开发前已存在的本地改动 | — | AC-008、AC-009 |

宿主证据的证明范围**仅限**：本次交付未修改、未删除既有文件，且新增文件路径全部位于 `src/greeting-demo/` 与 `test/greeting-demo/` 之下。它**不声称**已实测既有健康检查接口的运行时响应；因此 AC-008 的验收表述收窄为「既有文件未被改动（宿主快照证明）+ 本功能代码路径不导入、不触碰既有接口」，后半句由 `greeting-server` 的 import 静态检查支撑（全部说明符仅为 `node:` 内建与相对路径）。

## Command or Scenario

统一执行命令：`node --test test/greeting-demo/`（无需 `npm install`，无需网络）。

测试硬性限制（对全部 3 个文件生效）：不得调用 Git；不得启动子进程（禁用 `node:child_process`、spawn/exec 等外部命令）；不得读取本功能未声明的既有文件（import 静态检查只读取本次交付的 6 个新文件）。允许回环网络。

- `greeting-format`：`greetingMessage()` 无参 → `你好，访客`；`greetingMessage('')` → 访客；`greetingMessage('  ')`、`greetingMessage('\t\n')` → 访客；`greetingMessage('  小明  ')` → `你好，小明`；`greetingMessage('小 明')` → `你好，小 明`（中间空白保留）。
- `greeting-handler`：构造 `GET /greeting?name=...` 与 `res` 桩，断言 `statusCode === 200`、`content-type` 以 `application/json` 开头且含 `charset=utf-8`、`Object.keys(body).length === 1` 且键为 `message`；`?name=张三&name=李四`（`getAll('name').length === 2`）→ `你好，张三`；`POST /greeting` 与 `GET /other` → 404 且响应头无 `Allow`。
- `greeting-server`：以 `host: 127.0.0.1, port: 0` 启动真实监听并读回实际端口，用内置 `fetch` 依次请求 `?name=%E5%B0%8F%E6%98%8E`（编码）与 `?name=小明`（裸中文，验证 URL 解码与 UTF-8 回显，FR-004）、无参、`?name=`、`?name=%20%20`、`?name=%20小明%20`；断言状态码、`Content-Type` 与逐字节响应体；`afterEach` 中 `close()` 确保进程退出。同文件对 `src/greeting-demo/` 与 `test/greeting-demo/` 内 6 个文件做 import 静态解析，断言说明符仅落在 `node:` 内建或 `.`/`..` 相对路径内（AC-010）。
- `greeting-workspace-boundary`：由宿主在实现完成时执行快照比对并出具结果；设计阶段仅声明其范围与局限（见上一节）。

## Expected Result

| 需求 | 期望的可观察结果 |
| --- | --- |
| AC-001 | 200 + `{"message":"你好，小明"}`，编码与裸中文两种请求一致 |
| AC-002 | 200 + `{"message":"你好，访客"}` |
| AC-003 | 200 + 访客消息 |
| AC-004 | 200 + 访客消息 |
| AC-005 | 200 + `你好，小明`；`小 明` 的中间空格原样保留 |
| AC-006 | `Content-Type: application/json; charset=utf-8`，体可解析且只含 `message` 字段 |
| AC-007 | `你好，张三`（取第一个值） |
| AC-008 | 宿主快照：既有文件未被修改或删除；且交付代码不导入既有入口（不含「健康检查运行时响应已实测一致」的声明） |
| AC-009 | 宿主快照：新增文件全部位于 `src/greeting-demo/`、`test/greeting-demo/` 之下 |
| AC-010 | `node --test test/greeting-demo/` 全部用例通过；6 个交付文件的 import 仅引用 `node:` 内建与相对路径，运行过程未执行任何安装 |

## Status

| 证据 ID | 状态 | 说明 |
| --- | --- | --- |
| `greeting-format` | not-run | 目标测试文件与被测源码尚未实现 |
| `greeting-handler` | not-run | 同上 |
| `greeting-server` | not-run | 同上；另需核对真实 `node --version` ≥ 18 |
| `greeting-workspace-boundary` | not-run | 宿主证据，需实现完成后由宿主与开发前快照比较；设计角色无执行能力 |

本计划中没有任何用例被实际执行，不声明任何通过结论。限制与依赖：(1) 全部自动化断言受上文「测试硬性限制」约束，故仓库/文件边界的证明只能来自宿主快照证据，测试内不可获取；(2) `greeting-workspace-boundary` 不覆盖既有接口的运行时行为，若需该证明须另行安排且不通过子进程实现；(3) 若实际 Node < 18，`greeting-server` 改用 `node:http.request`，证据 ID 与文件路径不变；(4) 环境事实（`node --version`、`package.json` 的 `"type"`）待实现阶段核对。tasks 阶段必须原样保留上述证据 ID 与文件路径，不得新增证据 ID。
