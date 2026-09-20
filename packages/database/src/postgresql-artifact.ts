import { constants } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface PostgresqlSourceManifest { readonly schemaVersion: 1; readonly component: 'postgresql-source'; readonly version: '18.6'; readonly source: string; readonly sha256: string; readonly license: 'PostgreSQL'; readonly releaseDate: string }
export interface PostgresqlRuntimeArtifact { readonly architecture: 'darwin-arm64' | 'darwin-x64'; readonly version: '18.6'; readonly url: string; readonly bytes: number; readonly sha256: string; readonly attestation?: string }
export interface PostgresqlRuntimeManifest { readonly schemaVersion: 1; readonly component: 'postgresql'; readonly version: '18.6'; readonly status: 'pending-native-build' | 'verified'; readonly sourceManifest: string; readonly artifacts: readonly PostgresqlRuntimeArtifact[] }

export const sourceManifest: PostgresqlSourceManifest = Object.freeze({ schemaVersion: 1, component: 'postgresql-source', version: '18.6', source: 'https://ftp.postgresql.org/pub/source/v18.6/postgresql-18.6.tar.bz2', sha256: '555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f', license: 'PostgreSQL', releaseDate: '2026-08-13' })

export interface ArtifactInspectionError { readonly code: 'MISSING_BINARY' | 'EXTERNAL_DYLIB' | 'UNSAFE_PATH' | 'INVALID_RUNTIME'; readonly path?: string; readonly message: string }
export interface ArtifactInspectionResult { readonly valid: boolean; readonly errors: readonly ArtifactInspectionError[] }
export interface ArtifactCommandRunner { run(executable: string, args: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> }

const REQUIRED_BINARIES = ['postgres', 'initdb', 'pg_ctl', 'pg_isready', 'psql', 'createdb', 'dropdb', 'pg_dump', 'pg_restore'] as const

/** Checks a staged PostgreSQL artifact without trusting PATH or host installations. */
export class PostgresqlArtifactVerifier {
  constructor(private readonly runner?: ArtifactCommandRunner) {}

  async inspect(artifactRoot: string): Promise<ArtifactInspectionResult> {
    const errors: ArtifactInspectionError[] = []
    let root: string
    try { root = await realpath(resolve(artifactRoot)) } catch { return { valid: false, errors: [{ code: 'INVALID_RUNTIME', message: 'artifact root is not a real directory' }] } }
    for (const binary of REQUIRED_BINARIES) {
      const path = join(root, 'bin', binary)
      try {
        const details = await lstat(path)
        if (details.isSymbolicLink() || !details.isFile() || (details.mode & constants.S_IXUSR) === 0) errors.push({ code: 'MISSING_BINARY', path, message: `${binary} is not a private executable` })
        else if (await realpath(path) !== path) errors.push({ code: 'UNSAFE_PATH', path, message: `${binary} resolves outside the artifact root` })
      } catch { errors.push({ code: 'MISSING_BINARY', path, message: `${binary} is missing` }) }
    }
    if (this.runner !== undefined) {
      for (const binary of REQUIRED_BINARIES) {
        const executable = join(root, 'bin', binary)
        const version = await this.runner.run(executable, ['--version'], root)
        if (version.exitCode !== 0 || !version.stdout.includes('18.6')) errors.push({ code: 'INVALID_RUNTIME', path: executable, message: `${binary} version is not 18.6` })
        const dylib = await this.runner.run('/usr/bin/otool', ['-L', executable], root)
        if (dylib.exitCode !== 0) {
          errors.push({ code: 'INVALID_RUNTIME', path: executable, message: `could not inspect Mach-O dependencies for ${binary}` })
          continue
        }
        for (const line of dylib.stdout.split('\n').slice(1).map((value) => value.trim()).filter(Boolean)) {
          const dependency = line.split(' ')[0] ?? ''
          if (!(await isAllowedDependency(dependency, executable, root))) errors.push({ code: 'EXTERNAL_DYLIB', path: dependency, message: `Mach-O dependency is outside the allowed system/artifact closure: ${dependency}` })
        }
      }
    }
    return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) })
  }
}

async function isAllowedDependency(dependency: string, executable: string, root: string): Promise<boolean> {
  if (dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) return true
  if (dependency.startsWith(root)) return await isPrivateFile(dependency, root)
  if (!dependency.startsWith('@loader_path/')) return false
  const resolved = resolve(dirname(executable), dependency.slice('@loader_path/'.length))
  return await isPrivateFile(resolved, root)
}

async function isPrivateFile(path: string, root: string): Promise<boolean> {
  try {
    const canonical = await realpath(path)
    const relativePath = relative(root, canonical)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return false
    return (await lstat(canonical)).isFile()
  } catch {
    return false
  }
}

export function assertVerifiedRuntimeManifest(manifest: PostgresqlRuntimeManifest, architecture: PostgresqlRuntimeArtifact['architecture']): PostgresqlRuntimeArtifact {
  if (manifest.status !== 'verified') throw new Error('PostgreSQL native runtime manifest is pending native build attestation')
  const artifact = manifest.artifacts.find((item) => item.architecture === architecture)
  if (artifact === undefined || artifact.version !== '18.6' || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error(`PostgreSQL 18.6 artifact is not verified for ${architecture}`)
  return artifact
}

export function assertArtifactPath(root: string, path: string): void {
  const relativePath = relative(resolve(root), resolve(path))
  if (relativePath === '..' || relativePath.startsWith('../') || relativePath.includes('\\')) throw new Error('PostgreSQL artifact path escapes workspace')
}
