import { captureFileSnapshot, compareFileSnapshot, type FileSnapshot, type FileSnapshotOptions } from './file-snapshot.js'

export interface ConcurrentChangeGuardOptions extends FileSnapshotOptions {
  readonly workspaceRoot: string
}

/** Prevents an agent from applying a stale plan to a user-controlled file. */
export class ConcurrentChangeGuard {
  private readonly options: ConcurrentChangeGuardOptions

  constructor(options: ConcurrentChangeGuardOptions) {
    this.options = options
  }

  async capture(path: string): Promise<FileSnapshot> {
    return captureFileSnapshot(this.options.workspaceRoot, path, this.options)
  }

  async assertUnchanged(snapshot: FileSnapshot): Promise<void> {
    try {
      const result = await compareFileSnapshot(this.options.workspaceRoot, snapshot, this.options)
      if (!result.unchanged) throw new Error('snapshot differs')
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`concurrent change detected for ${snapshot.path}: ${reason}`, { cause: error })
    }
  }
}
