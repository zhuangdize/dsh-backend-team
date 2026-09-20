import { stat } from 'node:fs/promises'
import type { ClusterProcessRecord, ClusterStatus } from './postgresql-cluster.js'
import type { SnapshotManifest } from './database-snapshot.js'
import type { LocalDatabaseEndpoint } from './postgresql-config.js'
export interface RecoveryAuditInput { readonly status: ClusterStatus; readonly endpoint?: LocalDatabaseEndpoint; readonly expectedExecutable: string; readonly expectedDataDirectory: string; readonly listeners: readonly string[]; readonly latestSnapshot?: SnapshotManifest; readonly migrationJournalPresent: boolean }
export interface RecoveryAudit { readonly state: 'healthy' | 'interrupted' | 'stale' | 'needs-snapshot'; readonly reasons: readonly string[]; readonly latestSnapshot?: SnapshotManifest }
export class DatabaseRecovery {
  async audit(input: RecoveryAuditInput): Promise<RecoveryAudit> {
    const reasons: string[] = []; const process = input.status.process
    if (input.status.state === 'interrupted') reasons.push('cluster status is interrupted')
    if (process !== undefined) { if (!sameProcessIdentity(process, input.expectedExecutable, input.expectedDataDirectory)) reasons.push('process identity mismatch'); if (input.listeners.some((listener) => !isLoopback(listener))) reasons.push('non-loopback listener'); if (!(await processPathExists(process))) reasons.push('process record is stale') }
    if (!input.migrationJournalPresent) reasons.push('migration journal unavailable')
    if (input.latestSnapshot === undefined) reasons.push('no verified snapshot available')
    const state = reasons.some((reason) => reason.includes('stale')) ? 'stale' : reasons.some((reason) => reason.includes('interrupted')) ? 'interrupted' : reasons.length === 0 ? 'healthy' : reasons.some((reason) => reason.includes('snapshot')) ? 'needs-snapshot' : 'interrupted'
    return { state, reasons, ...(input.latestSnapshot === undefined ? {} : { latestSnapshot: input.latestSnapshot }) }
  }
}
function sameProcessIdentity(process: ClusterProcessRecord, executable: string, dataDirectory: string): boolean { return process.executable === executable && process.dataDirectory === dataDirectory && Number.isInteger(process.pid) && process.pid > 0 }
async function processPathExists(process: ClusterProcessRecord): Promise<boolean> { try { await stat(process.executable); return true } catch { return false } }
function isLoopback(listener: string): boolean { const value = listener.toLowerCase().replaceAll(' ', ''); return value.startsWith('127.0.0.1:') || value.startsWith('[::1]:') || value.startsWith('::1:') || value.startsWith('unix:') }
