import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

export interface OrmSchemaSyncPreview {
  readonly path: string
  readonly beforeSha256?: string
  readonly afterSha256: string
  readonly content: string
}

export interface PreparedOrmSchemaSync {
  readonly preview: OrmSchemaSyncPreview
  apply(): Promise<void>
  restore(): Promise<void>
}

/** Prepares a hash-bound ORM source update without writing before approval. */
export class OrmSchemaSynchronizer {
  constructor(private readonly workspaceRoot: string) {}

  async prepare(generatedSchemaPath: string, targetPath: string): Promise<PreparedOrmSchemaSync> {
    const root = await realpath(this.workspaceRoot)
    const generated = await realpath(generatedSchemaPath)
    if (!inside(root, generated) || !generated.endsWith('/schema.ts')) throw new Error('generated ORM schema must stay inside the workspace')
    const target = resolve(root, targetPath)
    if (!inside(root, target) || target === root || target.endsWith('/')) throw new Error('ORM schema target must stay inside the workspace')
    const content = await readFile(generated, 'utf8')
    if (content.length === 0 || content.length > 4 * 1024 * 1024) throw new Error('generated ORM schema is empty or too large')
    const before = await readExisting(target)
    const preview: OrmSchemaSyncPreview = Object.freeze({ path: relative(root, target), ...(before === undefined ? {} : { beforeSha256: digest(before.content) }), afterSha256: digest(content), content })
    let applied = false
    return Object.freeze({
      preview,
      apply: async () => {
        const current = await readExisting(target)
        if (!sameContent(current, before)) throw new Error(`ORM schema changed before approval: ${preview.path}`)
        await writeAtomic(target, content, current?.mode)
        applied = true
      },
      restore: async () => {
        if (!applied) return
        if (before === undefined) { await rm(target, { force: true }); applied = false; return }
        await writeAtomic(target, before.content, before.mode)
        applied = false
      },
    })
  }
}

async function readExisting(path: string): Promise<{ readonly content: string; readonly mode: number } | undefined> {
  try {
    const details = await lstat(path)
    if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1 || (details.mode & 0o022) !== 0) throw new Error(`ORM schema target is unsafe: ${path}`)
    return { content: await readFile(path, 'utf8'), mode: details.mode & 0o777 }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writeAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const parent = await realpath(dirname(path))
  if (parent !== dirname(path)) throw new Error('ORM schema target directory is not canonical')
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, { flag: 'wx', mode })
  try {
    await chmod(temporary, mode)
    const file = await open(temporary, 'r')
    try { await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    await chmod(path, mode)
    const directory = await open(parent, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

function inside(root: string, path: string): boolean { return path === root || path.startsWith(root + '/') }
function sameContent(left: { readonly content: string } | undefined, right: { readonly content: string } | undefined): boolean { return left?.content === right?.content }
function digest(content: string): string { return createHash('sha256').update(content).digest('hex') }
