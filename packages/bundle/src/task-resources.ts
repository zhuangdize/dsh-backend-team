import { gunzipSync } from 'node:zlib'
import { captureFileSnapshot } from '@dsh-backend-team/development/file-snapshot'

export const RESOURCE_DOCUMENTS = ['spec.md','clarification.md','plan.md','architecture.md','data-model.md','contracts/openapi.yaml','test-plan.md','research.md','decisions.md','tasks.md'] as const
/** A registry allowlist, never a browser supplied arbitrary file path. */
export async function readTaskResources(root: string, feature: string, outputs: readonly string[], reportPath?: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(feature)) throw new Error('invalid feature')
  const paths = [...RESOURCE_DOCUMENTS.map(file => `specs/${feature}/${file}`), ...outputs.filter(path => /^(src|test|tests)\//u.test(path)), ...(reportPath && /^\.backend-team\/final-verification-[A-Za-z0-9_-]+\/report\.json$/u.test(reportPath) ? [reportPath] : [])]
  const files: Array<{ path: string; content?: string; sha256?: string; category: string; error?: string }> = []
  let total = 0
  for (const path of [...new Set(paths)].slice(0,100)) {
    if (path.split('/').some(part => !part || part === '.' || part === '..') || /(?:^|\/)(?:\.env|credentials|secrets)(?:\.|\/|$)/iu.test(path)) continue
    const category = path.startsWith('specs/') ? '方案文档' : path.startsWith('.backend-team/') ? '验收报告' : '开发产物'
    try {
      const snapshot = await captureFileSnapshot(root, path, { maxBytes: 256 * 1024 })
      if (snapshot.state === 'missing') continue
      total += snapshot.bytes ?? 0
      if (total > 2 * 1024 * 1024) { files.push({ path, category, error: '本次预览已达到大小上限，请在工作区打开此文件。' }); continue }
      const content = new TextDecoder('utf-8', { fatal: true }).decode(gunzipSync(snapshot.compressedBytes))
      if (content.includes('\0')) throw new Error('binary')
      files.push({ path, content, ...(snapshot.sha256 === undefined ? {} : { sha256: snapshot.sha256 }), category })
    } catch { files.push({ path, category, error: '此文件暂不能安全预览，请在工作区查看。' }) }
  }
  return files
}
