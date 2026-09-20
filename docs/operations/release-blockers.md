# 发布阻塞处置方案

更新日期：2026-09-20。

这里的 `blocked` 不是同一种失败。当前工作区已经通过本地代码、类型、构建、Bundle、Qwen 局部调用和 arm64/x64 本机 PostgreSQL smoke；剩余状态分别属于真实生产验收证据和正式发布供应链证据。不能用本机结果直接替换这两类证据。

## 当前阻塞与根因

| 项目 | 当前根因 | 本地能否直接解除 | 解除动作 |
| --- | --- | --- | --- |
| T16 PostgreSQL provenance | `runtime-manifests/postgresql-18.6-darwin.json` 仍是 `pending-native-build`；本机归档没有外部 attestation 和稳定下载地址 | 不能 | 在 GitHub Actions 的 arm64/x64 runner 上构建；验证生命周期；使用 GitHub attestation；将两个归档和证明发布到稳定 HTTPS release URL；再生成 `status=verified` manifest |
| T21 发布材料 | Bundle 材料本地 checksum/SBOM 已通过，但没有签名 distribution、稳定 HTTPS URL 和 verified PostgreSQL manifest | 只能完成本地部分 | 先完成 T16，再把同一归档 SHA、SBOM、许可证、runtime manifest、release evidence 交给 release-candidate 门禁；签名材料必须由发布环境注入，不能手填 |
| T20 生产 Bundle | 默认 Bundle 刻意是只读诊断模式；缺少宿主提供的 `agents/workspaceRoot/recoveryToken/policyEngine` 时不会进入生产激活 | 代码和隔离验证已完成，正式组合不能凭本机 probe 代替 | 在受保护 Profile 中启用显式 production activation，使用真实 Qwen 凭据跑协调器、专家和 worker；保存同一 Profile/Bundle/模型组合的 provenance evidence |
| T19 Chrome 全流程 | 现有证据来自多个隔离切片，矩阵明确拒绝把局部通过合并成完整流程 | 只能补真实宿主场景 | 用同一个升级后的 Profile、Bundle、工作区和 Qwen 配置，按矩阵执行需求→审批→Agent 活动→DbGate/迁移→恢复→交付；每个场景保存截图、状态和证据引用 |
| T22 干净 Profile | arm64 本机生命周期已通过，但没有签名 release candidate 的完整安装、升级、回滚、卸载证据 | 不能在未生成 release candidate 前完成 | T16/T21 通过后，用同一个签名包在干净 arm64 Profile（以及将来需要时的 x64 Profile）重跑生命周期，核对保留文件摘要和卸载结果 |

## 正确执行顺序

1. 配置仓库 Git remote，并允许 GitHub Actions 使用 macOS arm64/x64 runner、OIDC attestation 和 release 写入权限。
2. 手动触发 `.github/workflows/postgresql-runtime.yml`。两个架构都必须通过架构核对、PostgreSQL 生命周期和 attestation；任何一个失败都停止。
3. 下载同一次 workflow run 的两个归档、`SHA256SUMS`、`smoke.json`、`attestation.json`，使用 `gh attestation verify` 核对归属和摘要。Actions 临时 artifact URL 不能直接写入 manifest。
4. 将两个归档和证明发布到稳定 HTTPS release URL，生成包含两个架构、字节数、SHA-256、下载 URL 和证明引用的 verified runtime manifest。manifest 只有在这些字段都能从发布页面复核时才能从 `pending-native-build` 改为 `verified`。
5. 在同一 revision 上准备完整 `release-evidence.json`，其中 `production-coordinator`、`browser-codex-chrome`、`real-model-api`、`dbgate-gui` 必须引用真实材料；隔离 fixture 不能代替这些 gate。
6. 使用 `build-release.mjs --channel release-candidate --evidence ... --distribution ...` 生成 Bundle，并运行 `verify-release.mjs` 与 `audit-release-materials.mjs --tarball ...`。任一签名、URL、runtime provenance 或证据摘要不一致都应失败。
7. 用生成的 signed release candidate 在干净 Profile 重跑 T22；通过后才可以把 T19/T20/T21/T22 标记为完成。

## 当前能立即执行的部分

- 根目录 Bundle 的 `.sha256`、CycloneDX SBOM 和 materials sidecar 已补齐，`archive-checksum-sbom` 已通过。
- `npm run typecheck`、`npm run lint`、`npm run build`、Agent runtime、DSH production ports 和 Web client probe 已在工作区 Node 24.19.0 下通过。
- 3080 本地宿主已恢复，可用于手动 Chrome 验收。

## 当前无法由本机代办的部分

本工作区没有 Git remote、GitHub CLI 登录、签名服务凭据或稳定 HTTPS 发布地址。因此不能从这里伪造 attestation、把本机产物写成正式 provenance，或代替用户发布 release。缺少这些外部输入时，发布门禁保持失败是预期行为，不是隐藏的代码错误。
