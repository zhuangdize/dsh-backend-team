import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { toPreview } from './drizzle-migration-adapter.js'
import type { MigrationPreview } from './migration-adapter.js'

export interface DrizzleKitGeneration {
  readonly preview: MigrationPreview
  readonly directory: string
  readonly schemaPath: string
  readonly migrationPath: string
}

/** Uses the pinned CLI in an isolated runtime directory; never pushes schema. */
export class DrizzleKitGenerator {
  constructor(private readonly options: { workspaceRoot: string; toolingRoot: string; nodeExecutable: string }) {}

  async generate(baselineUrl: string, designUrl: string): Promise<DrizzleKitGeneration> {
    for (const value of [baselineUrl, designUrl]) {
      const url = new URL(value)
      if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('migration generation requires local PostgreSQL')
    }
    const root = await realpath(this.options.workspaceRoot)
    const tooling = await realpath(this.options.toolingRoot)
    if (!tooling.startsWith(join(root, '.backend-team/runtime') + '/')) throw new Error('Drizzle tooling must be inside the workspace runtime')
    const cli = await realpath(join(tooling, 'node_modules/drizzle-kit/bin.cjs'))
    if (!cli.startsWith(tooling + '/')) throw new Error('Drizzle CLI escapes its runtime')
    const installed = JSON.parse(await readFile(join(tooling, 'node_modules/drizzle-kit/package.json'), 'utf8')) as { version?: unknown }
    if (installed.version !== '0.31.10') throw new Error('Drizzle Kit 0.31.10 is required')
    const directory = await mkdtemp(join(tooling, 'generation-'))
    const baseline = join(directory, 'baseline')
    const design = join(directory, 'design')
    const configure = async (name: string, output: string, schema?: string): Promise<string> => {
      const path = join(directory, `${name}.config.ts`)
      await writeFile(path, `export default { dialect: 'postgresql', out: ${JSON.stringify(relative(directory, output))}, schemaFilter: ['public'], ${schema === undefined ? '' : `schema: ${JSON.stringify(relative(directory, schema))},`} dbCredentials: { url: process.env.DSH_DRIZZLE_DB_URL } };\n`, { mode: 0o600 })
      return path
    }
    await this.run(cli, 'pull', await configure('baseline', baseline), directory, baselineUrl)
    const original = new Set((await readdir(baseline)).filter(file => file.endsWith('.sql')))
    await this.run(cli, 'pull', await configure('design', design), directory, designUrl)
    const schemaPath = join(design, 'schema.ts')
    await this.run(cli, 'generate', await configure('generate', baseline, schemaPath), directory, undefined)
    const added = (await readdir(baseline)).filter(file => file.endsWith('.sql') && !original.has(file))
    if (added.length !== 1) throw new Error('Drizzle did not generate one migration; there may be no changes or an unresolved rename decision')
    const migrationPath = join(baseline, added[0]!)
    const sql = await readFile(migrationPath, 'utf8')
    if (!sql.trim()) throw new Error('Drizzle generated an empty migration')
    return { preview: Object.freeze(toPreview({ migrationId: added[0]!.slice(0, -4), sql })), directory, schemaPath, migrationPath }
  }

  private run(cli: string, command: string, config: string, cwd: string, databaseUrl: string | undefined): Promise<void> {
    return new Promise((resolve, reject) => execFile(this.options.nodeExecutable, [cli, command, `--config=${config}`], {
      cwd, shell: false, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: dirname(this.options.nodeExecutable), HOME: cwd, TMPDIR: cwd, ...(databaseUrl === undefined ? {} : { DSH_DRIZZLE_DB_URL: databaseUrl }) },
    }, error => { if (error === null) resolve(); else reject(new Error(`Drizzle ${command} failed or requires interactive input`)) }))
  }
}
