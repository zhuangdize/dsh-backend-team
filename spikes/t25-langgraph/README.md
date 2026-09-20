# T25 LangGraph.js 隔离执行 spike

这个目录只用于验证长任务的执行内核，不会被根工作区打包，也不会改变现有 Backend Agent Team 的生产依赖。

验证范围：

- LangGraph `StateGraph` 的 `thread_id + checkpoint` 持久化；
- `interrupt` / `Command({ resume })` 人工介入后继续；
- 进程重启后从 PostgreSQL 恢复，不重复执行已完成工具；
- ContextManager 压缩投影与 LangGraph 状态同时落盘；
- `LongTaskExecutionSession` 接线：运行锁、OwnershipManager 租约、工具幂等和窗口/任务预算先于图节点生效；
- 压缩失败时保留原始 transcript，且检查点不被半成品覆盖。

默认 PostgreSQL 连接使用本机 Unix socket：`postgresql:///postgres?host=/tmp`。可用 `T25_POSTGRES_URL` 覆盖。测试会为每次运行生成唯一 thread，结束后删除对应 LangGraph checkpoint 和 ContextManager 行。默认测试使用隔离的 no-op 运行锁；宿主接线回归在 `packages/development/test/long-task-host-integration.test.ts` 使用真实 `FileDevelopmentCheckpointStore` 锁和文件 checkpoint；`test/cross-process-recovery.test.ts` 通过子进程 SIGKILL 验证运行锁释放和下一进程恢复。正式 DSH Agent 的上下文绑定位于 `packages/harness-adapter/src/harness-agent-runtime.ts`，由宿主显式传入 `executionSessionFactory`，本 spike 不把 LangGraph 依赖带入生产 Bundle。

运行：

```bash
npm install
npm test
npm run typecheck
npm run verify:postgres
```
