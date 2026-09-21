# 发布阻塞处置方案

更新日期：2026-09-21。

这里的 `blocked` 不是同一种失败。当前工作区已经通过本地代码、类型、构建、Bundle、Qwen 局部调用和 arm64/x64 本机 PostgreSQL smoke；剩余状态分别属于真实生产验收证据和正式发布供应链证据。不能用本机结果直接替换这两类证据。

## 当前阻塞与根因

| 项目 | 当前根因 | 本地能否直接解除 | 解除动作 |
| --- | --- | --- | --- |
| T16 PostgreSQL provenance | 双架构 runtime 已由 GitHub Actions 构建、attest 并发布；当前 manifest 已为 `verified` | 公开发布已完成；消费者安装仍需独立验收 | 复核 [v0.1.0-rc.1 Release](https://github.com/zhuangdize/dsh-backend-team/releases/tag/v0.1.0-rc.1) 的归档、`SHA256SUMS`、attestation 和 manifest；再在干净 Profile 做安装验收 |
| T21 发布材料 | PostgreSQL runtime provenance 和稳定 HTTPS URL 已完成；Bundle 仍缺完整 release-evidence、签名 distribution 和签名 release-candidate | runtime 部分已解除，Bundle 部分不能靠本机材料代替 | 在同一 revision 上准备完整真实生产 evidence，生成带签名 distribution 的 Bundle release-candidate，再运行 release audit 和 T22 |
| T20 生产 Bundle | 默认 Bundle 刻意是只读诊断模式；缺少宿主提供的 `agents/workspaceRoot/recoveryToken/policyEngine` 时不会进入生产激活 | 代码和隔离验证已完成，正式组合不能凭本机 probe 代替 | 在受保护 Profile 中启用显式 production activation，使用真实 Qwen 凭据跑协调器、专家和 worker；保存同一 Profile/Bundle/模型组合的 provenance evidence |
| T19 Chrome 全流程 | 现有证据来自多个隔离切片，矩阵明确拒绝把局部通过合并成完整流程 | 只能补真实宿主场景 | 用同一个升级后的 Profile、Bundle、工作区和 Qwen 配置，按矩阵执行需求→审批→Agent 活动→DbGate/迁移→恢复→交付；每个场景保存截图、状态和证据引用 |
| T22 干净 Profile | arm64 本机生命周期已通过，但没有签名 release candidate 的完整安装、升级、回滚、卸载证据 | 不能在未生成 release candidate 前完成 | T16/T21 通过后，用同一个签名包在干净 arm64 Profile（以及将来需要时的 x64 Profile）重跑生命周期，核对保留文件摘要和卸载结果 |

## 正确执行顺序

1. ~~配置仓库 Git remote，并允许 GitHub Actions 使用 macOS arm64/x64 runner、OIDC attestation 和 release 写入权限。~~ 已完成：公开仓库已配置 remote，工作流已声明双架构、OIDC attestation 和 artifact 权限。
2. ~~手动触发 `.github/workflows/postgresql-runtime.yml`。两个架构都必须通过架构核对、PostgreSQL 生命周期和 attestation；任何一个失败都停止。~~ 已完成：Run `35558685646` 两个 job 均通过，arm64 attestation `48835525`，x64 attestation `48835943`。
3. ~~下载同一次 workflow run 的两个归档、`SHA256SUMS`、`smoke.json`、`attestation.json`，使用 `gh attestation verify` 核对归属和摘要。Actions 临时 artifact URL 不能直接写入 manifest。~~ 已由 Run `35565633720` 的发布 job 自动完成同一 run artifact 绑定；公开 attestation 页面上的 archive subject 摘要与 Release 归档 SHA-256 一致。当前环境没有已登录的 GitHub CLI，因此未额外执行本机 `gh attestation verify` 命令。
4. ~~将两个归档和证明发布到稳定 HTTPS release URL，生成包含两个架构、字节数、SHA-256、下载 URL 和证明引用的 verified runtime manifest。manifest 只有在这些字段都能从发布页面复核时才能从 `pending-native-build` 改为 `verified`。~~ 已完成：[v0.1.0-rc.1 Release](https://github.com/zhuangdize/dsh-backend-team/releases/tag/v0.1.0-rc.1) 已公开，`runtime-manifests/postgresql-18.6-darwin.json` 已回写为 `status=verified`。
5. 在同一 revision 上准备完整 `release-evidence.json`，其中 `production-coordinator`、`browser-codex-chrome`、`real-model-api`、`dbgate-gui` 必须引用真实材料；隔离 fixture 不能代替这些 gate。
6. 使用 `build-release.mjs --channel release-candidate --evidence ... --distribution ...` 生成 Bundle，并运行 `verify-release.mjs` 与 `audit-release-materials.mjs --tarball ...`。任一签名、URL、runtime provenance 或证据摘要不一致都应失败。
7. 用生成的 signed release candidate 在干净 Profile 重跑 T22；通过后才可以把 T19/T20/T21/T22 标记为完成。

## 当前能立即执行的部分

- 根目录 Bundle 的 `.sha256`、CycloneDX SBOM 和 materials sidecar 已补齐，`archive-checksum-sbom` 已通过。
- `.github/workflows/release-bundle.yml` 已补齐候选发布编排：同一归档先构建、再 attestation、再绑定签名材料并执行 verify/audit，最后发布稳定 Release 资产；干净 checkout 的 `dist/` 创建也已修复。工作流显式要求已审核的 verified Agent fixture，不会误用仓库内的 partial fixture。
- `npm run typecheck`、`npm run lint`、`npm run build`、Agent runtime、DSH production ports 和 Web client probe 已在工作区 Node 24.19.0 下通过。
- 3080 本地宿主已恢复，可用于手动 Chrome 验收。

## 当前无法由本机代办的部分

当前 runtime 发布已经完成，稳定地址和 verified manifest 可从 [v0.1.0-rc.1 Release](https://github.com/zhuangdize/dsh-backend-team/releases/tag/v0.1.0-rc.1) 复核。本机没有已登录的 GitHub CLI，因此没有重复执行 CLI attestation 命令；这不影响发布 job 生成的签名 attestation 和公开 subject 对照。剩余阻塞转为 Bundle release-candidate 的真实生产 evidence、签名 distribution，以及签名包的干净 Profile 验收；这些不能用本地 fixture 代替。
