import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { captureFileSnapshot } from '@dsh-backend-team/development/file-snapshot'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { z } from 'zod'
const File = z.object({ path: z.string(), content: z.string().max(262144) }).strict()
const Snapshot = z.object({ hash: z.string(), files: z.array(File).max(10) }).strict()
const History = z.object({ current: Snapshot, previous: Snapshot.optional() }).strict()
const queues = new Map<string, Promise<unknown>>()
/** Keep only two bounded document versions; generated code and credentials are excluded. */
export async function recordReviewHistory(root: string, taskId: string, resources: Array<{ path: string; content?: string; category: string }>) {
  if (!/^[a-zA-Z0-9-]{1,100}$/u.test(taskId)) throw new Error('invalid task id')
  const files = resources.filter(file => file.category === '方案文档' && file.content !== undefined).map(file => ({ path: file.path, content: file.content! }))
  if (!files.length || files.length > 10 || Buffer.byteLength(JSON.stringify(files)) > 1024 * 1024) return { available: false, files: [] }
  const key = root + ':' + taskId
  const run = async () => {
    let directory = await realpath(root)
    for (const segment of ['.backend-team', 'review-history']) {
      directory = join(directory, segment)
      await mkdir(directory, { recursive: true })
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe review history directory')
    }
    const path = join(directory, taskId + '.json')
    let previous: z.infer<typeof History> | undefined
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 3 * 1024 * 1024) throw new Error('unsafe review history file')
      const snapshot = await captureFileSnapshot(root, '.backend-team/review-history/' + taskId + '.json', { maxBytes: 3 * 1024 * 1024 })
      previous = History.parse(JSON.parse(gunzipSync(snapshot.compressedBytes).toString('utf8')))
    } catch (cause) { if ((cause as { code?: string }).code !== 'ENOENT') throw cause }
    const current = { hash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }
    const history = previous?.current.hash === current.hash ? previous : { current, ...(previous ? { previous: previous.current } : {}) }
    if (previous?.current.hash !== current.hash) {
      const temporary = join(directory, randomUUID() + '.tmp')
      try { await writeFile(temporary, JSON.stringify(history), { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
      finally { await unlink(temporary).catch(() => {}) }
    }
    const baseline = history.previous
    return { available: !!baseline, files: baseline ? current.files.map(file => {
      const old = baseline.files.find(item => item.path === file.path)
      return { path: file.path, changed: old?.content !== file.content, before: old?.content ?? '', after: file.content }
    }).filter(file => file.changed) : [] }
  }
  const operation = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
  queues.set(key, operation)
  try { return await operation } finally { if (queues.get(key) === operation) queues.delete(key) }
}
