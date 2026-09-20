import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm, writeFile, link } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface CycloneDxComponentInput { name: string; version: string; purl: string; hash?: string; hashAlgorithm?: 'SHA-256' | 'SHA-512'; licenses: string[]; scope?: 'required' | 'optional' }
export interface CycloneDxDependency { ref: string; dependsOn: string[] }
export interface CycloneDxBom {
  bomFormat: 'CycloneDX'
  specVersion: '1.5'
  serialNumber: string
  version: 1
  components: Array<Record<string, unknown>>
  dependencies?: CycloneDxDependency[]
}

export function buildCycloneDxBom(input: { serial: string; components: CycloneDxComponentInput[]; dependencies?: CycloneDxDependency[] }): CycloneDxBom {
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: input.serial, version: 1,
    components: input.components.map((component) => ({ 'bom-ref': component.purl, type: 'library', name: component.name, version: component.version, purl: component.purl, ...(component.scope === undefined ? {} : { scope: component.scope }), ...(component.hash === undefined ? {} : { hashes: [{ alg: component.hashAlgorithm ?? 'SHA-256', content: component.hash }] }), licenses: component.licenses.map((id) => ({ license: { id } })) })),
    ...(input.dependencies === undefined || input.dependencies.length === 0 ? {} : { dependencies: input.dependencies.map((dependency) => ({ ref: dependency.ref, dependsOn: [...new Set(dependency.dependsOn)].sort() })) }),
  }
}

export function buildCycloneDxBomFromPackageLock(lockfile: unknown, serial: string): CycloneDxBom {
  const packages = lockfile && typeof lockfile === 'object' && (lockfile as { packages?: unknown }).packages
  const components: CycloneDxComponentInput[] = []
  const packageEntries: Array<{ path: string; name: string; purl: string; dependencies: string[] }> = []
  if (packages && typeof packages === 'object') {
    for (const [path, raw] of Object.entries(packages as Record<string, unknown>)) {
      if (!path.startsWith('node_modules/') || !raw || typeof raw !== 'object') continue
      const value = raw as { name?: unknown; version?: unknown; resolved?: unknown; integrity?: unknown; license?: unknown; dependencies?: unknown }
      if (typeof value.version !== 'string') continue
      const name = typeof value.name === 'string' ? value.name : path.slice('node_modules/'.length)
      const purl = `pkg:npm/${name.replace(/^@/, '%40').replace('/', '%2F')}@${value.version}`
      const licenses = typeof value.license === 'string' ? [value.license] : []
      const integrity = typeof value.integrity === 'string' ? value.integrity : undefined
      const hash = integrity?.startsWith('sha512-') === true ? Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex') : undefined
      components.push({ name, version: value.version, purl, licenses, ...(hash === undefined ? {} : { hash, hashAlgorithm: 'SHA-512' as const }) })
      const dependencies = value.dependencies && typeof value.dependencies === 'object' ? Object.keys(value.dependencies as Record<string, unknown>) : []
      packageEntries.push({ path, name, purl, dependencies })
    }
  }
  const byName = new Map<string, string>()
  for (const entry of [...packageEntries].sort((left, right) => left.path.localeCompare(right.path))) if (!byName.has(entry.name)) byName.set(entry.name, entry.purl)
  const dependencies = packageEntries
    .map((entry) => ({ ref: entry.purl, dependsOn: entry.dependencies.map((name) => byName.get(name)).filter((purl): purl is string => purl !== undefined) }))
    .filter((dependency) => dependency.dependsOn.length > 0)
  return buildCycloneDxBom({ serial, components, dependencies })
}

export async function writeCycloneDxBom(workspaceRoot: string, runId: string, bom: CycloneDxBom): Promise<string> {
  if (!runId || runId.includes('/') || runId.includes('\\') || runId === '.' || runId === '..') throw new Error('invalid run id')
  const root = resolve(workspaceRoot)
  const destination = resolve(root, '.backend-team', 'runs', runId, 'governance', 'bom.json')
  const escaped = relative(root, destination)
  if (isAbsolute(escaped) || escaped === '..' || escaped.startsWith(`..${sep}`)) throw new Error('SBOM destination escaped workspace')
  await ensureDirectoryWithoutSymlink(root, ['.backend-team', 'runs', runId, 'governance'])
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify(bom, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const parent = resolve(destination, '..')
    if (await realpath(parent) !== parent) throw new Error('SBOM parent directory changed during write')
    await link(temporary, destination)
    const directory = await open(parent, constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    await rm(temporary, { force: true })
  }
  return destination
}

async function ensureDirectoryWithoutSymlink(root: string, parts: string[]): Promise<void> {
  let current = root
  for (const part of parts) {
    current = resolve(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`SBOM directory is not a real directory: ${current}`)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o700 })
    }
  }
}
