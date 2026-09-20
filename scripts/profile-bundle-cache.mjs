import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A local tarball URL must change when its content changes: pnpm caches file URLs. */
export async function stageProfileBundle(archivePath, workspaceRoot) {
  const bytes = await readFile(archivePath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const directory = join(workspaceRoot, '.backend-team', 'runtime', 'profile-bundles')
  await mkdir(directory, { recursive: true })
  const staged = join(directory, `backend-team-${digest}.tgz`)
  try {
    await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (!(await readFile(staged)).equals(bytes)) throw new Error('staged Profile Bundle content does not match its digest')
  }
  return realpath(staged)
}
