# Implementation Plan: Greeting Demo

输入：`spec.md`、`clarification.md`。设计：`architecture.md`、`contracts/openapi.yaml`。
范围：仅新增 `src/greeting-demo/`、`test/greeting-demo/` 下的文件；无数据库、无第三方依赖、不修改任何已有文件与配置。

## 0. 前置门禁

- 本计划为设计产物：须经展示并获得用户明确确认后才进入编码，未确认前不动手。
- 已裁决结论（作为设计结论写入，无需再确认）：
  - Q2 承载方式 = `src/greeting-demo/` 内独立监听：`http.createServer` 绑定 `127.0.0.1`，`port: 0`（OS 分配临时端口）。「演示接口与既有健康检查不在同一端口」是用户已接受的代价。
  - Q3 非 GET 访问 `/greeting` = 返回 404，不写 `Allow` 头。
  - Q1 重复 `name` 取第一个值，AC-007 维持不变。
- 未决项仅剩两条真实运行环境事实核对（不阻塞设计）：`node --version` 实际值；`package.json` 的 `"type"` 值。

## 1. 基线记录（仅运行环境事实）

- 运行 `node --version`，需 ≥ 18（稳定 `node:test` + 内置 `fetch`）。
- 读取 `package.json` 的 `"type"`：若为 `commonjs`，以 `.mjs` 形式交付，不为此改动已有文件。
- 确认两个交付目录下不存在与第 2 节清单同名的既有文件（避免覆盖）。
- 不采集既有健康检查的响应基线，也不记录既有文件哈希：AC-008/AC-009 的证明由宿主在本功能开发前的工作区快照提供（见 §4、§5）。

## 2. 文件清单（固定 3 个源文件 + 3 个测试文件，不扩）

| 路径 | 职责 | 约束 |
| --- | --- | --- |
| `src/greeting-demo/format.mjs` | `greetingMessage(name?)` 纯函数：trim → 空则 `访客`，否则 `你好，<值>` | 零 IO，唯一逻辑源 |
| `src/greeting-demo/handler.mjs` | `createGreetingHandler()`：路由/方法判定、`getAll('name')[0]`、JSON 编码与 UTF-8 长度 | 依赖 format.mjs |
| `src/greeting-demo/server.mjs` | `startDemoServer({host,port})` + CLI 入口；`127.0.0.1`，port 默认 `0` | 依赖 handler.mjs |
| `test/greeting-demo/format.test.mjs` | 缺省 / 空 / 仅空白 / 前后空白 / 中间空白 | 仅测纯函数 |
| `test/greeting-demo/handler.test.mjs` | 200 + `application/json` + 单字段体；非 GET 与其它路径 404 | 临时监听 |
| `test/greeting-demo/server.test.mjs` | 端到端覆盖 AC-001~AC-007；含 AC-010 的 import 静态检查 | 内置 fetch |

不新增第四个测试文件（不设边界审计类文件）；不新增 `package.json` 脚本、配置文件、Dockerfile、依赖、迁移。

## 3. 实施顺序（TDD）

1. **format 层**：先写 `format.test.mjs`，再实现 `format.mjs`。断言：无参 → AC-002；`''` → AC-003；`'  '` / `'\t\n'` → AC-004；`'  小明  '` → `你好，小明`；`'小 明'` → `你好，小 明`（AC-005 中间空白保留）。
2. **handler 层**：写 `handler.test.mjs`，实现 `handler.mjs`。断言：`status === 200`；`content-type` 以 `application/json` 开头（含 `charset=utf-8`）；`Object.keys(body).length === 1` 且键为 `message`（AC-006）；`?name=张三&name=李四` → `你好，张三`（AC-007）；`POST /greeting` → 404 且无 `Allow`；`/other` → 404。
3. **server 层**：写 `server.test.mjs`，`listen(0)` 后用内置 `fetch` 请求真实回环端口；URL 以 `'%E5%B0%8F%E6%98%8E'` 编码与裸中文各发一次，验证解码与 UTF-8 回显（FR-004 / AC-001）；结束 `close()` 保证进程退出。该文件同时对本次交付的 6 个文件做 import 静态检查（AC-010）：全部 import 说明符仅允许 `node:` 内建模块或相对路径。
4. **手工验证**（属自动化测试之外）：`node src/greeting-demo/server.mjs` 后 `curl -i 'http://127.0.0.1:<port>/greeting?name=小明'`，确认 200 与中文回显；`SIGINT` 关停。

## 4. 验证与验收映射

运行：`node --test test/greeting-demo/`

测试硬性限制：自动化用例不得调用 Git；不得启动子进程（禁 `node:child_process`、禁 spawn/exec 等外部命令）；不得读取本功能未声明的既有文件（import 静态检查只读取本次交付的新文件）。

| AC | 覆盖方式 |
| --- | --- |
| AC-001 | server.test（含 URL 编码变体） |
| AC-002 / 003 / 004 | format.test + handler/server.test |
| AC-005 | format.test（前后空白、中间空白） |
| AC-006 | handler.test + server.test 头与体断言 |
| AC-007 | handler.test，`getAll` 长度 2 |
| AC-008 | host-evidence `greeting-workspace-boundary`：既有文件未被修改/删除（宿主开发前工作区快照比较证明）；且本功能代码路径不导入、不触碰既有接口。既有健康检查的运行时响应未实测，不作声明 |
| AC-009 | host-evidence `greeting-workspace-boundary`：新增路径全部位于 `src/greeting-demo/`、`test/greeting-demo/` 之下 |
| AC-010 | 3 个测试文件内的 import 静态检查：仅引用 `node:` 内建与相对路径；`node --test` 全绿且未执行任何安装 |

## 5. 交付边界

- `greeting-workspace-boundary` 的证明范围仅限「本次交付未修改/删除既有文件、新增文件路径全部落在上述两个目录」；不覆盖既有接口运行时响应的任何比较。
- 无数据变更、无部署、无破坏性操作，无需回滚脚本；撤销方式为删除这两个新增目录。
- 文档改动仅限本 feature 目录；实现阶段不得顺带格式化或修复无关文件。

## 6. 提交前检查清单

- [ ] 仅新增文件，路径全部落在 `src/greeting-demo/`、`test/greeting-demo/`
- [ ] 无任何已有文件被修改/删除（含 `package.json`、既有入口、既有测试），由宿主快照比较证明（AC-009）
- [ ] `node --test test/greeting-demo/` 全绿；测试不调用 Git、不启动子进程、不读取未声明既有文件
- [ ] import 静态检查通过：仅 `node:` 内建与相对路径（AC-010）
- [ ] 未把原始 `name` 写入任何输出（D-4）
- [ ] 验收表述不含「健康检查运行时响应已实测一致」类声明（AC-008 边界）
