import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { privateDirectory, readPrivateFile } from './private-storage.js'
import { randomBytes } from 'node:crypto'

export interface CredentialStore {
  put(key: string, secret: Uint8Array | string): Promise<string>
  get(reference: string): Promise<Uint8Array | undefined>
  delete(reference: string): Promise<void>
}

/** Testable credential boundary. Production can wrap Keychain without changing database services. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, Uint8Array>()
  async put(key: string, secret: Uint8Array | string): Promise<string> {
    if (!key || key.includes('/') || key.includes('\\')) throw new Error('credential key is invalid')
    const reference = `credential-${randomBytes(16).toString('hex')}`
    this.values.set(reference, typeof secret === 'string' ? Buffer.from(secret) : new Uint8Array(secret))
    return reference
  }
  async get(reference: string): Promise<Uint8Array | undefined> { const value = this.values.get(reference); return value === undefined ? undefined : value.slice() }
  async delete(reference: string): Promise<void> { this.values.delete(reference) }
}

export function generateDatabasePassword(): string { return randomBytes(32).toString('base64url') }

/** Owner-only local files, not encrypted storage. Never include this directory in exports. */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly directory: string) {}
  async put(key: string, secret: Uint8Array | string): Promise<string> {
    if (!key || /[/\\\u0000-\u001f]/u.test(key)) throw new Error('credential key is invalid')
    const bytes = Buffer.from(secret)
    if (bytes.length === 0 || bytes.length > 65536) throw new Error('credential size is invalid')
    await privateDirectory(this.directory)
    const reference = `credential-${randomBytes(16).toString('hex')}`
    const path = join(this.directory, reference)
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() }
    catch (error: unknown) { await unlink(path).catch(() => undefined); throw error }
    finally { await handle.close() }
    return reference
  }
  async get(reference: string): Promise<Uint8Array | undefined> {
    await privateDirectory(this.directory)
    return readPrivateFile(this.path(reference))
  }
  async delete(reference: string): Promise<void> {
    await privateDirectory(this.directory)
    const path = this.path(reference)
    if (await readPrivateFile(path) !== undefined) await unlink(path)
  }
  private path(reference: string): string {
    if (!/^credential-[a-f0-9]{32}$/u.test(reference)) throw new Error('invalid credential reference')
    return join(this.directory, reference)
  }
}
