export interface ProfileRow { readonly id: string; readonly name: string; readonly version: string; readonly packagePath: string; readonly sha256: string }
export interface ProfileStore { rows(): Promise<readonly ProfileRow[]>; installPackage(packagePath: string): Promise<void>; replacePackage(id: string, packagePath: string): Promise<void>; removePackage(id: string): Promise<void>; verifyBoot(): Promise<void> }
export type ProfileState = 'absent' | 'same-version' | 'upgrade' | 'conflict'
export interface ProfileInspection { readonly state: ProfileState; readonly rows: readonly ProfileRow[] }
export class BackendTeamProfileLifecycle {
  constructor(private readonly store: ProfileStore, private readonly packageName = '@dsh-backend-team/bundle') {}
  async inspect(version: string, sha256?: string): Promise<ProfileInspection> {
    const rows = (await this.store.rows()).filter((row) => row.name === this.packageName)
    if (rows.length === 0) return { state: 'absent', rows }
    if (rows.length !== 1 || rows[0]?.id !== 'backend-team') return { state: 'conflict', rows }
    const row = rows[0]!; return { state: row.version === version && (sha256 === undefined || row.sha256 === sha256) ? 'same-version' : 'upgrade', rows }
  }
  async install(packagePath: string, version: string, sha256: string): Promise<ProfileRow> {
    const inspection = await this.inspect(version, sha256); if (inspection.state === 'conflict') throw new Error('Profile contains conflicting Backend Team rows'); if (inspection.state === 'same-version') { await this.store.verifyBoot(); return inspection.rows[0]! }
    if (inspection.state === 'absent') await this.store.installPackage(packagePath); else await this.store.replacePackage('backend-team', packagePath)
    await this.store.verifyBoot(); return { id: 'backend-team', name: this.packageName, version, packagePath, sha256 }
  }
  async uninstall(): Promise<void> { const inspection = await this.inspect(''); if (inspection.state === 'conflict') throw new Error('Profile contains conflicting Backend Team rows'); if (inspection.rows.length === 1) { await this.store.removePackage('backend-team'); await this.store.verifyBoot() } }
}
