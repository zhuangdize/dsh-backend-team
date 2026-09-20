# 升级与回滚

升级保留唯一 `backend-team` Profile 行和工作区数据。升级前暂停活动任务并保存状态快照；启动失败时恢复旧 Bundle 和状态快照。冲突行、重复行或缺少运行时 provenance 都会阻止升级。
