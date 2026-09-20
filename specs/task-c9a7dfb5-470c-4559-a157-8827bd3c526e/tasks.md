# Tasks: Greeting Demo（GET /greeting）

输入：`plan.md` §2/§3、`architecture.md`、`test-plan.md`、`contracts/openapi.yaml`；`data-model.md` 证实无持久化，故无 persistence 层任务。
范围：仅新增 3 个源文件 + 3 个测试文件；不修改或删除任何既有文件；零第三方依赖。证据 ID 与测试文件路径原样保留自 `test-plan.md`，未新增证据。
组织：本接口规模小，全部实现与测试归入单一端到端切片 S-1，每层先测试后实现（TDD）；宿主的最终验证（运行测试与快照比对）自动执行，不单设任务。

<!-- backend-team:task id=T-1 slice=S-1 requirements=AC-002,AC-003,AC-004,AC-005 owner=developer risk=standard layer=test files=test/greeting-demo/format.test.mjs evidence=greeting-format -->
- [ ] 先核对环境事实：`node --version` ≥ 18（不足则 T-5 改用 `node:http.request`，证据 ID 与路径不变）、`package.json` 的 `"type"`（为 `commonjs` 时仍以 `.mjs` 交付，不改该文件）、两个交付目录不存在同名既有文件；随后编写纯函数用例：无参 → `你好，访客`；`''` → 访客；`'  '`、`'\t\n'` → 访客；`'  小明  '` → `你好，小明`；`'小 明'` → `你好，小 明`（中间空白保留）

<!-- backend-team:task id=T-2 slice=S-1 requirements=AC-002,AC-003,AC-004,AC-005 owner=developer risk=standard layer=domain files=src/greeting-demo/format.mjs evidence=greeting-format depends=T-1 -->
- [ ] 实现并具名导出 `greetingMessage(name?)`：`String(name ?? '').trim()`，为空返回 `你好，访客`，否则返回 `你好，<trim 后原值>`；零 IO、不引用任何 Node API、不记录原始 `name`（D-4），使 T-1 转绿

<!-- backend-team:task id=T-3 slice=S-1 requirements=AC-006,AC-007 owner=developer risk=standard layer=test files=test/greeting-demo/handler.test.mjs evidence=greeting-handler depends=T-2 -->
- [ ] 编写进程内断言（`http.createServer` + 临时监听，无第三方框架）：`statusCode === 200`；`content-type` 以 `application/json` 开头且含 `charset=utf-8`；`Object.keys(body).length === 1` 且键为 `message`；`?name=张三&name=李四`（`getAll('name').length === 2`）→ `你好，张三`；`POST /greeting` 与 `GET /other` → 404、响应头无 `Allow`、体为 `{"message":"接口不存在"}`

<!-- backend-team:task id=T-4 slice=S-1 requirements=AC-006,AC-007 owner=developer risk=standard layer=contract files=src/greeting-demo/handler.mjs evidence=greeting-handler depends=T-3 -->
- [ ] 实现 `createGreetingHandler()`（仅依赖 format.mjs）：`new URL(req.url,'http://localhost')` 解析，异常 try/catch → 404；仅 `pathname === '/greeting'` 且 `method === 'GET'` 走问候分支，其余 404 且不写 `Allow`，体为 `{"message":"接口不存在"}`（按契约）；取 `searchParams.getAll('name')[0]`；成功响应 `200` + `Content-Type: application/json; charset=utf-8` + `Content-Length: Buffer.byteLength(body,'utf8')` + `JSON.stringify({ message })`；意外异常兜底 `500` + 固定文案，错误体不含 `name`

<!-- backend-team:task id=T-5 slice=S-1 requirements=AC-001,AC-002,AC-003,AC-004,AC-005,AC-006,AC-010 owner=developer risk=high layer=test files=test/greeting-demo/server.test.mjs evidence=greeting-server depends=T-4 -->
- [ ] 编写端到端用例：`startDemoServer({host:'127.0.0.1',port:0})` 读回真实端口，内置 `fetch` 依次请求 `?name=%E5%B0%8F%E6%98%8E`、`?name=小明`（裸中文，验证 URL 解码与 UTF-8 回显，FR-004）、无参、`?name=`、`?name=%20%20`、`?name=%20小明%20`，断言状态码、`Content-Type` 与逐字节响应体，用例后 `close()` 确保进程退出；同文件对 6 个交付文件做 import 静态检查：说明符仅允许 `node:` 内建或 `.`/`..` 相对路径，且未 import 任何既有文件。测试不得调用 Git、不得启动子进程、不得读取未声明既有文件

<!-- backend-team:task id=T-6 slice=S-1 requirements=AC-001,AC-002,AC-003,AC-004,AC-005,AC-006,AC-010 owner=developer risk=standard layer=domain files=src/greeting-demo/server.mjs evidence=greeting-server depends=T-5 -->
- [ ] 实现 `startDemoServer({host,port})` 与 CLI 入口：`http.createServer(handler)` 绑定 `127.0.0.1`、`port` 默认 `0`，启动后仅打印实际监听地址；`SIGINT` 优雅关停；`listen` 失败打印不含用户输入的简述并以非 0 退出；不导入、不触碰既有服务入口与健康检查，使 T-5 转绿

<!-- backend-team:task id=T-7 slice=S-1 requirements=AC-008,AC-009 owner=developer risk=high layer=test files=src/greeting-demo/format.mjs,src/greeting-demo/handler.mjs,src/greeting-demo/server.mjs,test/greeting-demo/format.test.mjs,test/greeting-demo/handler.test.mjs,test/greeting-demo/server.test.mjs evidence=greeting-workspace-boundary depends=T-1,T-2,T-3,T-4,T-5,T-6 -->
- [ ] 变更集边界复核：确认新增文件恰为上列 6 个且全部位于 `src/greeting-demo/` 与 `test/greeting-demo/` 之下，既有文件（含 `package.json`、既有服务入口与既有测试）零修改零删除；该结论由宿主快照证据 `greeting-workspace-boundary` 出具，范围仅此文件级边界，验收表述不得声称「健康检查运行时响应已实测一致」（AC-008 收窄为未改既有文件 + T-5 的 import 检查）

## 依赖与顺序

`T-1 → T-2 → T-3 → T-4 → T-5 → T-6 → T-7`（单切片 S-1，无环）；`T-7` 在元数据 `depends` 中依赖全部前序任务，为终态复核。各层测试先于实现，任务间无并行机会。

## AC → 证据（原样沿用 test-plan.md 绑定）

- `greeting-format`（AC-002~AC-005）：T-1、T-2
- `greeting-handler`（AC-006、AC-007）：T-3、T-4
- `greeting-server`（AC-001~AC-006、AC-010）：T-5、T-6
- `greeting-workspace-boundary`（AC-008、AC-009，宿主证据）：T-7

10 条 AC 全部有承载任务与已批准证据；统一运行命令 `node --test test/greeting-demo/`，无需安装、无需网络。

## 验证限制

- `node --version` 与 `package.json` 的 `"type"` 属实现阶段核对的环境事实（T-1）；Node < 18 时按 test-plan 降级路径改写 T-5，证据 ID 与路径不变。
- 宿主快照只证明文件级边界，不覆盖既有健康检查的运行时响应；如需该证明须另行安排，且不得通过测试内子进程获取。
- 契约的 404 体 `{"message":"接口不存在"}` 在 `plan.md` §3 断言清单中未列出，T-3/T-4 按契约补入以避免漂移。
