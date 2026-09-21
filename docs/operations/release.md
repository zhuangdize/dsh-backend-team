# 发布检查

当前交付范围（2026-09-08 用户确认）：优先满足本机 Apple Silicon Mac 使用，Intel Mac 云端验收延期，不再作为当前本机交付的阻塞项。下述双架构要求保留用于将来面向两种 Mac 架构的正式发布；延期不表示 Intel 验收已通过。

## PostgreSQL 原生构建材料

`postgresql-runtime.yml` 使用 `macos-15`（arm64）和 `macos-15-intel`（x64），并在构建前核对实际运行架构。两项任务分别安装锁定依赖、构建工作区及 PostgreSQL，然后运行 `verify-postgresql-execution-port.mjs`：检查二进制依赖、启动本地数据库、建表及读写、停止，再用新的 cluster/credential store 实例恢复并读取原记录。任一步失败都不会生成成功的上传包。

每个架构的 Actions artifact 保留 30 天，包含原生压缩包、`smoke.json`、源代码 manifest、`SHA256SUMS` 和 `attestation.json`。签名证明绑定压缩包及两份 JSON 的摘要；签名服务不可用时任务失败，不跳过该步骤。GitHub 对私有仓库的签名证明能力有套餐要求，见 [actions/attest 官方说明](https://github.com/actions/attest)。

下载两个架构的材料后，必须核对来自同一待发布 revision、校验摘要，并使用 `gh attestation verify <archive> --repo <owner/repo> --bundle attestation.json` 验证归属。Actions 临时下载地址不能直接作为长期安装地址；待发布系统提供稳定的 HTTPS 下载地址后，再审核并填写 runtime manifest。工作流不会自动把 `pending-native-build` 改成 `verified`。

## 发布门槛

正式 release candidate 必须在干净 Git revision 上完成锁文件、全量测试、typecheck、lint 和 build，并提供已验证的 PostgreSQL 18.6 `darwin-arm64` 与 `darwin-x64` 原生 artifact provenance、SBOM、许可证材料、tarball 及匹配 checksum。官方 Harness Agent runtime fixture 也必须是完整 `verified` 状态，不能用 partial fixture 或模拟字段代替。

发布脚本要求显式传入证据文件；证据文件必须在 `gates` 中把以下 gate 标记为 `passed`，并为每项提供非空 `evidenceRef`：`production-coordinator`、`browser-codex-chrome`、`real-model-api`、`dbgate-gui`。脚本不会替这些 gate 自动填充通过状态，也不会把 fixture 当作真实验收证据。真实模型验收只能通过受保护的 credential facility 注入凭据；凭据不得写入 manifest、证据文件、命令行日志或输出。

当前校验只检查证据声明的结构，不读取或验证 `evidenceRef` 对应材料，也不验证
attestation 的签名。因此脚本通过不能独立证明生产验收或供应链可信性；发布系统仍需
核对证据与待发布 revision/artifact 的对应关系。2026-09-05 的 DbGate 基础 GUI
验收已完成，精确依赖替换后仍有 21 项 npm findings（0 critical、3 high、18 moderate），不得把
这次基础验收填写成完整生产 GUI/security gate 通过。

先准备真实的 `release-evidence.json`，再使用工作区 Node 运行：

GitHub 的手动发布检查同样要求 `evidence_path` 输入，指向所检出 revision 中已审核
的证据文件；工作流通过环境变量传入路径，不把输入直接拼进脚本。

`.github/workflows/release-bundle.yml` 现在按同一归档执行完整的候选发布顺序：先在干净
checkout 中构建未签名 Bundle，再用 GitHub Actions artifact attestations 对该归档签名，
将签名摘要和最终 Release 下载地址回写到 `.materials.json`，随后运行
`verify-release.mjs`、`audit-release-materials.mjs`，最后把归档、checksum、SBOM、材料清单、
attestation 和审计报告一起发布到 GitHub Release。手动运行必须同时提供 `evidence_path`
、`release_tag` 和已审核的 `agent_fixture_path`；任一 gate、摘要绑定、签名或稳定 HTTPS 地址失败，工作流会在发布前停止。工作流不会隐式接受仓库内的 partial fixture。

```sh
.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node scripts/build-release.mjs --channel release-candidate --evidence artifacts/release-evidence.json --agent-fixture artifacts/agent-runtime-verified.json --distribution artifacts/release-distribution.json
.backend-team/runtime/nvm/versions/node/v24.19.0/bin/node scripts/verify-release.mjs --tarball dist/dsh-backend-team-bundle-<version>.tgz --evidence artifacts/release-evidence.json --agent-fixture artifacts/agent-runtime-verified.json
```

构建会在 tarball 旁生成同名的 `.sha256`、`.cdx.json`（CycloneDX 1.5
SBOM）和 `.materials.json`。材料清单绑定 Bundle、lockfile、许可证说明、运行时
manifest、Agent fixture 与证据文件的摘要；可用
`node scripts/audit-release-materials.mjs --tarball <tarball> --output <report>`
只读核对当前材料。该审计不会创建签名或下载地址，`release-candidate` 仍要求发布
系统提供真实签名、稳定 HTTPS 地址和其余外部门禁。

当发布系统已经拿到签名服务返回的材料时，`build-release.mjs` 支持通过
`--distribution <json>` 注入，不需要手工编辑 sidecar。JSON 必须包含
`signature.status=verified`、非空 `provider` 和 `evidenceRef`、与 tarball 完全一致的
`artifactSha256`，以及无凭据的稳定 HTTPS `stableDownloadUrl`；脚本会在写入前校验摘要绑定，
默认未提供该文件时仍生成 `not-attested` 材料并保持阻断。

`verify-release.mjs` 拒绝省略 `--tarball`、把目录当 tarball、缺失 `.sha256` 或 checksum 与实际 tarball 不匹配的输入。签名、SBOM、许可证、双架构原生构建、真实协调器/Chrome/DeepSeek/DbGate 验收仍需由发布系统和对应验收环境提供；缺少这些外部材料时 release 必须保持 blocked。当前状态见 [release evidence](../compatibility/release-evidence.md)。

模型 API 证据使用 `real-model-api`，必须额外填写非空 `provider`、`model`，以及 `api`（`openai-responses` 或 `openai-chat-completions`）。该检查适用于实际配置的供应商，包含 Qwen 和 DeepSeek；Codex App Server 的 Agent 执行不能代替模型 API 验收。旧 `real-deepseek-model` 声明不会自动转换为通过，须审核原始材料并补齐模型身份和协议后迁移。这里的字段检查仍不代替原始证据审核。
