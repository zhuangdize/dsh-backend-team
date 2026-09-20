# 卸载

默认卸载只移除 Bundle Profile 行并停止已验证的 Team 进程，保留 specs、state、reports、PostgreSQL 数据和 snapshots。必须显式传入 `--confirm preserve-data`；删除项目数据是另一个需要再次确认的流程。

在项目工作区执行以下命令即可卸载工作区内的默认 Profile：

```bash
./.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node scripts/backend-team-uninstall.mjs --confirm preserve-data
```

如果 Bundle 是安装到真实用户的 `~/.dsh`，必须明确指定该目录；这不会删除项目数据：

```bash
./.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node scripts/backend-team-uninstall.mjs --profile web --dsh-home ~/.dsh --confirm preserve-data
```
