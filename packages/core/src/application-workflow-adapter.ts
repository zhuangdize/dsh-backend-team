import type { ApplicationWorkflowPort } from './application-action-catalog.js'

export interface SpecificationWorkflowPort {
  start(objective: string): Promise<unknown>
  refine(clarification: string): Promise<unknown>
  refineDesign?(clarification: string): Promise<unknown>
  approveRequirements(): Promise<unknown>
  design(): Promise<unknown>
  approveDesign(): Promise<unknown>
  generateTasks(): Promise<unknown>
}

export interface ApplicationWorkflowAdapterOptions {
  readonly specification: SpecificationWorkflowPort
  readonly status: () => Promise<unknown> | unknown
  readonly resume?: (input?: unknown) => Promise<unknown>
  /** Optional lifecycle guard checked before a post-approval phase starts. */
  readonly assertActive?: () => void
  readonly afterGeneration?: (phase: 'design' | 'plan') => Promise<void>
}

/**
 * Turns the phase-specific coordinator into the user-facing workflow port.
 * Approval is deliberately followed by the next generation step, preserving
 * the gates while keeping the UI flow to the two confirmations described by
 * the product: requirements, then architecture/database design.
 */
export function createApplicationWorkflowAdapter(options: ApplicationWorkflowAdapterOptions): ApplicationWorkflowPort {
  assertOptions(options)
  return Object.freeze({
    start: async (objective: string) => {
      assertText(objective, 'objective')
      await options.specification.start(objective)
      return options.status()
    },
    refine: async (input: unknown) => {
      const clarification = readClarification(input)
      if (typeof input === 'object' && input !== null && 'stage' in input && input.stage === 'design') {
        if (options.specification.refineDesign === undefined) throw new Error('design refinement is unavailable')
        await options.specification.refineDesign(clarification)
      } else await options.specification.refine(clarification)
      return options.status()
    },
    approve: async (gate: 'requirements' | 'design') => {
      if (gate === 'requirements') {
        await options.specification.approveRequirements()
        options.assertActive?.()
        await options.specification.design()
        options.assertActive?.()
        await options.afterGeneration?.('design')
      } else if (gate === 'design') {
        await options.specification.approveDesign()
        options.assertActive?.()
        await options.specification.generateTasks()
        options.assertActive?.()
        await options.afterGeneration?.('plan')
      } else {
        throw new Error('workflow approval gate is invalid')
      }
      return options.status()
    },
    status: () => options.status(),
    resume: async (input?: unknown) => {
      if (options.resume === undefined) throw new Error('workflow resume is unavailable')
      return options.resume(input)
    },
  })
}

function assertOptions(options: ApplicationWorkflowAdapterOptions): void {
  if (typeof options !== 'object' || options === null) throw new TypeError('workflow adapter options are required')
  const specification = options.specification
  if (typeof specification !== 'object' || specification === null) throw new TypeError('workflow specification coordinator is required')
  for (const method of ['start', 'refine', 'approveRequirements', 'design', 'approveDesign', 'generateTasks'] as const) {
    if (typeof specification[method] !== 'function') throw new TypeError(`workflow specification method is missing: ${method}`)
  }
  if (typeof options.status !== 'function') throw new TypeError('workflow status function is required')
  if (options.resume !== undefined && typeof options.resume !== 'function') throw new TypeError('workflow resume function is invalid')
}

function readClarification(input: unknown): string {
  if (typeof input === 'string') return assertText(input, 'clarification')
  if (input !== null && typeof input === 'object' && !Array.isArray(input) && 'text' in input && typeof input.text === 'string') return assertText(input.text, 'clarification')
  throw new Error('refine requires non-empty clarification text')
}

function assertText(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
