#!/usr/bin/env node

const [major, minor, patch] = process.versions.node.split('.').map(Number)
if (major !== 24) {
  const current = process.versions.node
  throw new Error(`该项目必须使用 Node 24.x（当前为 ${current}）。请使用 .backend-team/runtime/nvm/versions/node/v24.19.0/bin/node 或先将 Node 切换到 24.x。`)
}
if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`无法解析 Node 版本：${process.versions.node}`)
process.stdout.write(`Node ${process.versions.node} 就绪\n`)
