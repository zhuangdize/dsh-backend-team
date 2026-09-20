# macOS 安装

安装目标是用户指定的 DSH Profile 和工作区。安装前显示 Bundle 版本、SHA-256、Profile 和工作区路径，并通过官方 DSH `plugin ... add` 命令完成操作。运行时 Node/NVM 必须来自目标工作区 `.backend-team/runtime`。

安装失败时保留诊断文件，不删除 `.backend-team`。原生 PostgreSQL 运行时只有在双架构构建证明完成后才允许安装。

## 默认选择

首发 macOS 默认使用 `web` Profile，因为它提供浏览器界面，适合非技术用户使用 Backend Agent Team。`dsh web` 与 `dsh --profile web` 是同一种启动方式。

“自动开发”的含义和安全边界见[自动开发说明](./automatic-development.md)。

Profile 可以理解为一套 DSH 启动配置：它决定加载哪些 Bundle 和界面，不代表账号、模型或数据库。没有显式设置 `DSH_HOME` 时，DSH 使用 `~/.dsh`；本机当前可识别的 Profile 位于 `~/.dsh/profiles/web`。

安装脚本会优先使用工作区内 `.backend-team/runtime` 的 Node、npm 和 DSH，并将临时配置放在工作区内，避免修改全局 Node、Python、uv、Shell 配置或系统服务。默认使用工作区内的临时 DSH 配置；只有在命令中明确传入 `--dsh-home ~/.dsh` 时，才会写入真实用户的 DSH 配置。

如果 DSH 尚未启动，就不存在“当前 Profile”；启动命令会决定它。插件无法凭空创建登录会话，LLM 认证由 DSH 自己管理。已有有效配置可以复用；全新的工作区配置需要在官方 Web 界面的 API key 配置页填写自己的 DeepSeek 凭据。不要把密钥发到聊天、写入项目文件或验收报告。页面可打开并不表示模型调用已经通过验收。

在项目工作区执行安装（默认写入工作区临时 Profile）：

```bash
./.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node scripts/backend-team-profile.mjs install --bundle .backend-team/runtime/bundles/dsh-backend-team-bundle-0.1.0.tgz
```

如果要安装到已存在的用户 `web` Profile，明确指定 DSH 配置目录：

```bash
./.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node scripts/backend-team-profile.mjs install --profile web --dsh-home ~/.dsh --bundle .backend-team/runtime/bundles/dsh-backend-team-bundle-0.1.0.tgz
```

脚本会复用该 Profile 已有的 pnpm 存储目录，避免把用户 Profile 和工作区 Profile 混用；新的工作区 Profile 则使用工作区内的存储目录。

安装后，从同一个工作区启动 Web：

```bash
./.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node scripts/backend-team-start.mjs --profile web --dsh-home ~/.dsh
```

启动命令默认只监听 `127.0.0.1`；结束运行时在该终端按 `Ctrl-C`。不传 `--dsh-home` 时，启动的是工作区内的临时 Profile。
