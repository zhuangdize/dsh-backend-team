# 在 DSH 中使用 Codex 模型

当前状态（2026-09-07）：按用户要求，工作区已停用本接入并切换为直接模型 API。参见 [当前模型 API 接入](model-api.md)。以下内容保留为旧接入的说明。

此接入已用 DSH 0.1.0-rc.6、Codex CLI 0.148.0 和 Node.js 24 验证。无需 DeepSeek 密钥；需要本机 Codex 已登录且账户可使用所选模型。模型列表来自 App Server，账户额度和可用模型以 Codex 返回结果为准。

安装最新 BackendTeam Bundle 后，在项目根目录使用 Node.js 24 执行：

```sh
node scripts/configure-codex-model.mjs enable --command /absolute/path/to/codex
node scripts/configure-codex-model.mjs status
```

将路径替换为本机 Codex 可执行文件的绝对路径。脚本默认只修改当前项目的 `.backend-team/runtime/dsh-home/profiles/web/cordis.patch.yml`，保留其他插件配置。可通过 `--dsh-home`、`--profile` 指定其他 Profile。首次使用需通过该 Codex 可执行文件完成 `login`。

重启使用该 Profile 的 DSH 服务后，在会话输入框的模型选择器中选择 **Codex App Server (ChatGPT login)** 下的模型，即可发送消息。当前没有设置页面开关；启停通过 Profile 配置完成。

关闭接入后同样需要重启 DSH：

```sh
node scripts/configure-codex-model.mjs disable
```

对应的 Profile 配置如下；已有 `backend-team` 条目时合并其 `config`，不要重复添加：

```yaml
- id: backend-team
  config:
    codexAppServer:
      enabled: true
      command: /absolute/path/to/codex
      timeoutMs: 120000
```

DSH 继续管理工具执行、文件权限和审批。桥接进程通过 stdio 调用 App Server，每次推理创建临时会话，关闭 Codex 本地环境、原生技能及 MCP 工具，只把 DSH 声明的工具请求交回 DSH。不会导出或手动复制登录令牌。停用状态不会启动 Codex 子进程。

当前限制：回答在一次推理结束后显示；暂不支持图片、temperature 和 stop 参数。App Server 没有本次请求的硬性输出 token 上限，适配器只能在收到用量后检查超限，不能据此保证上游费用上限。此协议包含实验接口；升级 Codex 后需重新验收工具隔离和消息协议。

真实验收包括 Chrome 中选择模型并收到“Codex 接入成功。”，以及真实模型请求工具、由宿主执行读取、模型接收结果的两步往返。本接入不代表 BackendTeam 的其他生产发布阻塞项已经完成，也不替代 DeepSeek 专属兼容性验收。
