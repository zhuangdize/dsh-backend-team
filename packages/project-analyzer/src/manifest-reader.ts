import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PolicyAction, PolicyContext, PolicyEngine } from '@dsh-backend-team/contracts'
import { parse as parseToml } from '@iarna/toml'
import { parseDocument as parseYamlDocument } from 'yaml'
import { SecretFilter } from './secret-filter.js'

const DEFAULT_MAX_MANIFEST_BYTES = 1024 * 1024

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type DocumentFormat = 'json' | 'jsonc' | 'toml' | 'yaml'

export interface PackageManifest {
  readonly name?: string
  readonly workspaces?: JsonValue
  readonly engines?: JsonValue
  readonly devEngines?: JsonValue
  readonly volta?: JsonValue
  readonly packageManager?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly scripts?: Readonly<Record<string, string>>
  readonly exports?: JsonValue
}

export interface DataDocument {
  readonly format: DocumentFormat
  readonly data: JsonValue
}

export interface ManifestReadError {
  readonly code: 'invalid-json' | 'invalid-jsonc' | 'invalid-toml' | 'invalid-yaml' | 'not-file' | 'not-found' | 'policy-denied' | 'policy-required' | 'sensitive-path' | 'too-large' | 'unsafe-path' | 'unsupported-document' | 'unsupported-manifest'
  readonly message: string
  readonly path?: string
}

export type ManifestReadResult = { readonly ok: true; readonly manifest: PackageManifest } | { readonly ok: false; readonly error: ManifestReadError }
export type DocumentReadResult = { readonly ok: true; readonly document: DataDocument } | { readonly ok: false; readonly error: ManifestReadError }

export interface PolicyReadOptions {
  readonly policyEngine: PolicyEngine
  readonly policyContext: PolicyContext
}

export interface ManifestReaderOptions extends Partial<PolicyReadOptions> {
  readonly maxBytes?: number
}

interface PreparedFile {
  readonly path: string
  readonly relativePath: string
}

type PreparedFileResult = { readonly ok: true; readonly file: PreparedFile } | { readonly ok: false; readonly error: ManifestReadError }

interface DescriptorBoundPolicyEngine extends PolicyEngine {
  executeApprovedRead<T>(action: Extract<PolicyAction, { kind: 'read' }>, context: PolicyContext, operation: (handle: FileHandle) => Promise<T>): Promise<T>
}

function isWorkspaceRelativePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && !/^[A-Za-z]:/.test(path)
    && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function toJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, seen))
  if (!isRecord(value) || seen.has(value)) throw new Error('document data cannot be represented safely')
  seen.add(value)
  try {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry, seen)]))
  } finally {
    seen.delete(value)
  }
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === 'string')) return undefined
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry as string]))
}

function error(code: ManifestReadError['code'], message: string, path?: string): { readonly ok: false; readonly error: ManifestReadError } {
  return { ok: false, error: path ? { code, message, path } : { code, message } }
}

function hasDescriptorBoundRead(engine: PolicyEngine): engine is DescriptorBoundPolicyEngine {
  return typeof (engine as Partial<DescriptorBoundPolicyEngine>).executeApprovedRead === 'function'
}

async function readBoundedHandleText(handle: FileHandle, maxBytes: number, relativePath: string): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: ManifestReadError }> {
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) return error('not-file', 'Document path must identify a regular file.', relativePath)
    if (metadata.size > maxBytes) return error('too-large', 'Document exceeds the configured size limit.', relativePath)
    const content = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
      if (bytesRead === 0) return error('not-found', 'Document file was not available for reading.', relativePath)
      offset += bytesRead
    }
    return { ok: true, text: content.toString('utf8') }
  } catch {
    return error('not-found', 'Document file was not available for reading.', relativePath)
  }
}

function documentFormat(relativePath: string): DocumentFormat | undefined {
  if (relativePath.endsWith('.json')) return 'json'
  if (relativePath.endsWith('.jsonc')) return 'jsonc'
  if (relativePath.endsWith('.yaml') || relativePath.endsWith('.yml')) return 'yaml'
  if (relativePath.endsWith('.toml')) return 'toml'
  return undefined
}

function stripJsonc(text: string): string {
  let withoutComments = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    const next = text[index + 1]
    if (inString) {
      withoutComments += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      withoutComments += character
      continue
    }
    if (character === '/' && next === '/') {
      index += 1
      while (index + 1 < text.length && text[index + 1] !== '\n' && text[index + 1] !== '\r') index += 1
      continue
    }
    if (character === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2)
      if (close === -1) throw new Error('unterminated JSONC comment')
      index = close + 1
      continue
    }
    withoutComments += character
  }

  let normalized = ''
  inString = false
  escaped = false
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index]!
    if (inString) {
      normalized += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      normalized += character
      continue
    }
    if (character === ',') {
      let next = index + 1
      while (next < withoutComments.length && /\s/u.test(withoutComments[next]!)) next += 1
      if (withoutComments[next] === '}' || withoutComments[next] === ']') continue
    }
    normalized += character
  }
  return normalized
}

function parseData(text: string, format: DocumentFormat, relativePath: string): DocumentReadResult {
  let parsed: unknown
  try {
    switch (format) {
      case 'json':
        parsed = JSON.parse(text)
        break
      case 'jsonc':
        parsed = JSON.parse(stripJsonc(text))
        break
      case 'yaml': {
        const document = parseYamlDocument(text, { prettyErrors: false, uniqueKeys: true })
        if (document.errors.length > 0) throw new Error('invalid YAML')
        parsed = document.toJS({ maxAliasCount: 0 })
        break
      }
      case 'toml':
        parsed = parseToml(text)
        break
    }
  } catch {
    return error(`invalid-${format}`, 'Document could not be parsed as inert data.', relativePath)
  }
  try {
    return { ok: true, document: { format, data: toJsonValue(parsed) } }
  } catch {
    return error(`invalid-${format}`, 'Document contains unsupported data.', relativePath)
  }
}

/** Bounded data reader that never imports, requires, or evaluates target-project content. */
export class ManifestReader {
  private readonly root: string
  private readonly maxBytes: number
  private readonly configuredPolicy: PolicyReadOptions | undefined

  constructor(workspaceRoot: string, options: ManifestReaderOptions = {}) {
    try {
      this.root = realpathSync(workspaceRoot)
      if (!lstatSync(this.root).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new Error('workspace root is unavailable or not a directory')
    }
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_MANIFEST_BYTES
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > DEFAULT_MAX_MANIFEST_BYTES) {
      throw new Error(`maxBytes must be an integer between 1 and ${DEFAULT_MAX_MANIFEST_BYTES}`)
    }
    if ((options.policyEngine === undefined) !== (options.policyContext === undefined)) {
      throw new Error('policyEngine and policyContext must be provided together')
    }
    if (options.policyEngine !== undefined && options.policyContext !== undefined) {
      this.configuredPolicy = { policyEngine: options.policyEngine, policyContext: options.policyContext }
    } else {
      this.configuredPolicy = undefined
    }
  }

  readPackage(relativePath: string): ManifestReadResult {
    if (this.configuredPolicy !== undefined) throw new Error('policy-enabled manifest readers require readPackageAuthorized')
    return this.readPackagePrepared(relativePath)
  }

  async readPackageAuthorized(relativePath: string, options?: PolicyReadOptions): Promise<ManifestReadResult> {
    const prepared = this.preparePackage(relativePath)
    if (!prepared.ok) return prepared
    return this.readAuthorized(prepared.file, options, async (handle) => {
      const text = await readBoundedHandleText(handle, this.maxBytes, prepared.file.relativePath)
      return text.ok ? this.parsePackageText(text.text, prepared.file.relativePath) : text
    })
  }

  readDocument(relativePath: string): DocumentReadResult {
    if (this.configuredPolicy !== undefined) throw new Error('policy-enabled manifest readers require readDocumentAuthorized')
    return this.readDocumentPrepared(relativePath)
  }

  async readDocumentAuthorized(relativePath: string, options?: PolicyReadOptions): Promise<DocumentReadResult> {
    const format = this.prepareDocumentFormat(relativePath)
    if (!format.ok) return format
    const prepared = this.prepareFile(relativePath)
    if (!prepared.ok) return prepared
    return this.readAuthorized(prepared.file, options, async (handle) => {
      const text = await readBoundedHandleText(handle, this.maxBytes, prepared.file.relativePath)
      return text.ok ? parseData(text.text, format.format, prepared.file.relativePath) : text
    })
  }

  private readPackagePrepared(relativePath: string): ManifestReadResult {
    const prepared = this.preparePackage(relativePath)
    return prepared.ok ? this.parsePackage(prepared.file) : prepared
  }

  private readDocumentPrepared(relativePath: string): DocumentReadResult {
    const format = this.prepareDocumentFormat(relativePath)
    if (!format.ok) return format
    const prepared = this.prepareFile(relativePath)
    return prepared.ok ? this.parseDocument(prepared.file, format.format) : prepared
  }

  private preparePackage(relativePath: string): PreparedFileResult {
    if (!isWorkspaceRelativePath(relativePath)) return error('unsafe-path', 'Manifest path must be workspace-relative.')
    if (SecretFilter.isSensitivePath(relativePath)) return error('sensitive-path', 'Sensitive files are never read.', relativePath)
    if (relativePath.split('/').at(-1) !== 'package.json') return error('unsupported-manifest', 'Only package.json manifests are supported.', relativePath)
    return this.prepareFile(relativePath)
  }

  private prepareDocumentFormat(relativePath: string): { readonly ok: true; readonly format: DocumentFormat } | { readonly ok: false; readonly error: ManifestReadError } {
    if (!isWorkspaceRelativePath(relativePath)) return error('unsafe-path', 'Document path must be workspace-relative.')
    if (SecretFilter.isSensitivePath(relativePath)) return error('sensitive-path', 'Sensitive files are never read.', relativePath)
    const format = documentFormat(relativePath)
    return format === undefined
      ? error('unsupported-document', 'Only JSON, JSONC, YAML, and TOML documents are supported.', relativePath)
      : { ok: true, format }
  }

  private prepareFile(relativePath: string): PreparedFileResult {
    let candidate = this.root
    for (const segment of relativePath.split('/')) {
      candidate = resolve(candidate, segment)
      try {
        if (lstatSync(candidate).isSymbolicLink()) return error('unsafe-path', 'Document path may not traverse a symlink.', relativePath)
      } catch {
        return error('not-found', 'Document file was not found.', relativePath)
      }
    }
    try {
      const metadata = lstatSync(candidate)
      if (!metadata.isFile()) return error('not-file', 'Document path must identify a regular file.', relativePath)
      if (metadata.size > this.maxBytes) return error('too-large', 'Document exceeds the configured size limit.', relativePath)
    } catch {
      return error('not-found', 'Document file was not found.', relativePath)
    }
    return { ok: true, file: { path: candidate, relativePath } }
  }

  private async readAuthorized<T extends ManifestReadResult | DocumentReadResult>(file: PreparedFile, options: PolicyReadOptions | undefined, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
    if (this.configuredPolicy !== undefined && options !== undefined && (options.policyEngine !== this.configuredPolicy.policyEngine || options.policyContext !== this.configuredPolicy.policyContext)) {
      return error('policy-denied', 'The configured policy binding cannot be overridden.', file.relativePath) as T
    }
    const policy = this.configuredPolicy ?? options
    if (policy === undefined) return error('policy-required', 'Policy-bound reads require a PolicyEngine and PolicyContext.', file.relativePath) as T
    if (!hasDescriptorBoundRead(policy.policyEngine)) return error('policy-denied', 'Policy cannot bind this read to a protected descriptor.', file.relativePath) as T
    try {
      if (realpathSync(policy.policyContext.workspace.root) !== this.root) throw new Error('workspace mismatch')
      const context: PolicyContext = { ...policy.policyContext, workspace: { ...policy.policyContext.workspace, root: this.root } }
      return await policy.policyEngine.executeApprovedRead({ kind: 'read', targetPath: file.path }, context, operation)
    } catch {
      return error('policy-denied', 'Policy did not allow this document read.', file.relativePath) as T
    }
  }

  private parsePackage(file: PreparedFile): ManifestReadResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file.path, 'utf8'))
    } catch {
      return error('invalid-json', 'Manifest is not valid JSON.', file.relativePath)
    }
    return this.parsePackageValue(parsed, file.relativePath)
  }

  private parsePackageText(text: string, relativePath: string): ManifestReadResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return error('invalid-json', 'Manifest is not valid JSON.', relativePath)
    }
    return this.parsePackageValue(parsed, relativePath)
  }

  private parsePackageValue(parsed: unknown, relativePath: string): ManifestReadResult {
    if (!isRecord(parsed)) return error('invalid-json', 'Manifest must be a JSON object.', relativePath)

    const manifest: { [key: string]: JsonValue | Readonly<Record<string, string>> } = {}
    if (typeof parsed.name === 'string') manifest.name = parsed.name
    if (isJsonValue(parsed.workspaces)) manifest.workspaces = parsed.workspaces
    if (isJsonValue(parsed.engines)) manifest.engines = parsed.engines
    if (isJsonValue(parsed.devEngines)) manifest.devEngines = parsed.devEngines
    if (isJsonValue(parsed.volta)) manifest.volta = parsed.volta
    if (typeof parsed.packageManager === 'string') manifest.packageManager = parsed.packageManager
    for (const key of ['dependencies', 'devDependencies', 'scripts'] as const) {
      const value = stringRecord(parsed[key])
      if (value) manifest[key] = value
    }
    if (isJsonValue(parsed.exports)) manifest.exports = parsed.exports
    return { ok: true, manifest: manifest as PackageManifest }
  }

  private parseDocument(file: PreparedFile, format: DocumentFormat): DocumentReadResult {
    let text: string
    try {
      text = readFileSync(file.path, 'utf8')
    } catch {
      return error('not-found', 'Document file was not found.', file.relativePath)
    }
    return parseData(text, format, file.relativePath)
  }
}
