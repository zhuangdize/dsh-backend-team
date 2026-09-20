import type { BackendTeamApplicationTool } from '@dsh-backend-team/contracts'
import type { DatabaseCatalog } from './database-catalog.js'
import type { PostgresqlCluster } from './postgresql-cluster.js'
import type { DbGateLauncher } from './dbgate-launcher.js'

export interface DatabaseApplicationCompositionOptions { readonly cluster: PostgresqlCluster; readonly catalog: DatabaseCatalog; readonly dbgate?: DbGateLauncher }
/** Application boundary for database lifecycle; raw SQL, credentials, and processes are intentionally not exposed. */
export class DatabaseApplicationComposition {
  private readonly actions: readonly BackendTeamApplicationTool[]
  private disposal: Promise<void> | undefined
  constructor(private readonly options: DatabaseApplicationCompositionOptions) {
    this.actions = Object.freeze([
      action('backend_database_status', '查看本地 PostgreSQL 状态。', async () => options.cluster.status()),
      action('backend_database_start', '启动工作区本地 PostgreSQL。', async () => options.cluster.start()),
      action('backend_database_stop', '停止工作区本地 PostgreSQL。', async () => { await options.cluster.stop(); return options.cluster.status() }),
      action('backend_database_prepare', '创建当前工作区的开发和测试数据库。', async () => options.catalog.ensureProjectDatabases()),
      ...(options.dbgate === undefined ? [] : [action('backend_database_gui_status', '查看本地数据库 GUI 状态。', async () => options.dbgate!.status())]),
    ])
  }
  list(): readonly BackendTeamApplicationTool[] { return this.actions }
  get(name: string): BackendTeamApplicationTool | undefined { return this.actions.find((item) => item.name === name) }
  /** Stop the GUI before PostgreSQL and make host/Profile teardown idempotent. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposal = (async () => {
      const failures: unknown[] = []
      if (this.options.dbgate !== undefined) {
        try { await this.options.dbgate.stop() } catch (error: unknown) { failures.push(error) }
      }
      try { await this.options.cluster.stop() } catch (error: unknown) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'database composition disposal failed')
    })()
    return this.disposal
  }
}
function action(name: string, description: string, execute: (input: unknown) => Promise<unknown>): BackendTeamApplicationTool { return Object.freeze({ name, description, execute }) }
