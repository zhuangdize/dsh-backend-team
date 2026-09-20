import type { BackendTeamApplicationTool } from '@dsh-backend-team/contracts'

export interface DevelopmentWorkflowPort {
  start(objective: string): Promise<unknown>
  refine(input: unknown): Promise<unknown>
  approve(gate: 'requirements' | 'design'): Promise<unknown>
  status(): Promise<unknown> | unknown
  resume(input?: unknown): Promise<unknown>
}

/** User-facing development actions; expert dispatch remains an internal port. */
export class DevelopmentActionCatalog {
  private readonly actions: readonly BackendTeamApplicationTool[]

  constructor(private readonly workflow: DevelopmentWorkflowPort) {
    this.actions = Object.freeze([
      action('backend_team_start', '开始一次后端开发任务并进入需求澄清。', async (input) => workflow.start(readObjective(input))),
      action('backend_team_refine', '提交补充信息并继续需求澄清。', async (input) => workflow.refine(input)),
      action('backend_team_approve', '批准需求或架构设计门禁。', async (input) => workflow.approve(readGate(input))),
      action('backend_team_status', '查看当前阶段、切片和验证状态。', async (input) => { assertObjectOrUndefined(input, 'status'); return workflow.status() }),
      action('backend_team_resume', '从最后一个已验证切片恢复中断的开发任务。', async (input) => workflow.resume(input)),
    ])
  }

  list(): readonly BackendTeamApplicationTool[] { return this.actions }
  get(name: string): BackendTeamApplicationTool | undefined { return this.actions.find((item) => item.name === name) }
}

function action(name: string, description: string, execute: (input: unknown) => Promise<unknown>): BackendTeamApplicationTool { return Object.freeze({ name, description, execute }) }

function readObjective(input: unknown): string {
  if (typeof input === 'string' && input.trim().length > 0) return input
  if (input && typeof input === 'object' && !Array.isArray(input) && typeof (input as { objective?: unknown }).objective === 'string' && (input as { objective: string }).objective.trim().length > 0) return (input as { objective: string }).objective
  throw new Error('start requires a non-empty objective')
}

function readGate(input: unknown): 'requirements' | 'design' {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ((input as { gate?: unknown }).gate !== 'requirements' && (input as { gate?: unknown }).gate !== 'design')) throw new Error('approve requires gate requirements or design')
  return (input as { gate: 'requirements' | 'design' }).gate
}

function assertObjectOrUndefined(input: unknown, name: string): void {
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) throw new Error(`${name} input must be an object`)
}
