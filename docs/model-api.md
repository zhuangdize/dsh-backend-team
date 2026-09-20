# 当前模型 API 接入

2026-09-07：当前项目的 DSH web Profile 已从 Codex App Server 切换为官方 `@deepseek-ai/dsh-llm-pi-ai` 适配器。无需新增插件或模型桥接代码。DSH/BackendTeam 继续负责 Agent 循环、工具执行、权限和团队调度。

当前配置：

- 提供方：`qwen-4399`（页面显示 4399 Qwen API）
- 模型：`qwen3.8-flash`
- 协议：`openai-responses`
- Base URL：`https://openai.5054399.com/aliyun/compatible-mode/v1`
- 实际请求地址：Base URL 加 `/responses`
- 凭据引用：`QWEN_4399_API_KEY`
- 输入类型：文字、图片

配置位于工作区 `.backend-team/runtime/dsh-home/settings.yaml`。新会话默认选择此模型。已有会话保留原模型选择，需要手动改选或新建会话。

在 DSH 页面进入 **Settings → Models → 4399 Qwen API → Edit**，填写该服务的 API Key 并点击 **Apply**。密钥由 DSH 凭据服务保存，不应写入项目代码或聊天消息。不要填入其他服务的密钥。

2026-09-09 更新：最大输出由 4096 调整为 **131072 token**；上下文窗口仍为 262144。依据为 [Qwen3.8-Flash 官方参数](https://www.alibabacloud.com/help/zh/model-studio/qwen3-8-flash)（9月8日更新），并以当前第三方接口做了真实请求检查。尚未声明推理档位。

Codex Chrome 新建的配置验收会话 `session-75016918-e745-4557-b099-b8f193cf136b` 中，持久化 `request/header` 的 `config.maxTokens=131072`、`adapterDefaults.maxTokens=true`，Qwen 返回“额度配置连接正常。”，正常 stop；没有参数超限错误。此检查证明新配置进入真实请求并被服务接受，不证明能持续生成满 131072 token，也不代表服务无限制。没有为验证而生成长篇无用输出。设置修改前保留同目录 `settings.yaml.before-output-limit-*` 备份，未读取或输出密钥。

Codex 配置仍保留但 `codexAppServer.enabled` 已设为 `false`。旧实现源码暂时保留，当前路由不会调用它。切换前的设置和 Profile patch 已在原目录保存带时间戳的备份。

验收状态（2026-09-07 更新）：用户已保存密钥。Codex Chrome 使用真实 Qwen 完成了文本回答、读取随机标记文件、通过 read_image 识别合成图片、创建两个代码文件、执行并修复测试（最终 5 项通过）、流式输出、停止生成和取消后恢复对话。代码测试也由宿主独立重跑通过。

图片验证覆盖的是 DSH 工具返回的图片，不代表视频或所有附件上传方式均已验收。该轮使用普通 DSH Agent，完整 BackendTeam 生产流程仍需独立验收。证据：`.backend-team/artifacts/qwen-chrome-acceptance.json`。

官方适配器说明：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md

图片粘贴补充验收（2026-09-07）：在 Chrome 中聚焦输入框，粘贴剪贴板图片后出现附件预览；发送后 Qwen 直接识别出新图片的绿色圆形和橙色正方形，未调用工具。证据：`.backend-team/artifacts/qwen-image-paste-acceptance.json`。目前安装的 DSH rc.6 没有独立的图片文件选择按钮；可以在输入框粘贴图片，源码也提供拖入处理，但此次未实测拖入。
