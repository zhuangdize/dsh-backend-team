import { describe, expect, it } from 'vitest'
import { createApplicationWorkflowAdapter } from '../src/index.js'

describe('createApplicationWorkflowAdapter', () => {
  it('waits for human approval before scheduling the next phase and never continues after rejection', async () => {
    const calls: string[] = []
    let approve!: () => void
    const pending = new Promise<void>(resolve => { approve = resolve })
    const workflow = createApplicationWorkflowAdapter({
      specification: { ...specification(calls), approveRequirements: () => pending },
      status: () => ({}), afterGeneration: async phase => { calls.push(`next:${phase}`) },
    })
    const running = workflow.approve('requirements')
    expect(calls).toEqual([])
    approve()
    await running
    expect(calls).toEqual(['design', 'next:design'])
    calls.length = 0
    const rejected = createApplicationWorkflowAdapter({
      specification: { ...specification(calls), approveDesign: async () => { throw new Error('rejected') } },
      status: () => ({}), afterGeneration: async phase => { calls.push(`next:${phase}`) },
    })
    await expect(rejected.approve('design')).rejects.toThrow('rejected')
    expect(calls).toEqual([])
  })
  it('chains requirements approval into architecture and database design', async () => {
    const calls: string[] = []
    const workflow = createApplicationWorkflowAdapter({
      specification: specification(calls),
      status: async () => ({ phase: 'AWAIT_DESIGN_APPROVAL' }),
    })

    await expect(workflow.approve('requirements')).resolves.toEqual({ phase: 'AWAIT_DESIGN_APPROVAL' })
    expect(calls).toEqual(['approve-requirements', 'design'])
  })

  it('chains design approval into task planning and normalizes user inputs', async () => {
    const calls: string[] = []
    const workflow = createApplicationWorkflowAdapter({
      specification: specification(calls),
      status: () => ({ phase: 'BUILD' }),
      resume: async (input) => { calls.push(`resume:${String(input)}`); return { phase: 'BUILD' } },
    })

    await expect(workflow.start('订单接口')).resolves.toEqual({ phase: 'BUILD' })
    await expect(workflow.refine({ text: '增加分页规则' })).resolves.toEqual({ phase: 'BUILD' })
    await expect(workflow.approve('design')).resolves.toEqual({ phase: 'BUILD' })
    await expect(workflow.resume({ runId: 'run-1' })).resolves.toEqual({ phase: 'BUILD' })
    expect(calls).toEqual(['start:订单接口', 'refine:增加分页规则', 'approve-design', 'generate-tasks', 'resume:[object Object]'])
  })

  it('fails closed when recovery is not supplied', async () => {
    const workflow = createApplicationWorkflowAdapter({ specification: specification([]), status: () => ({ phase: 'BUILD' }) })
    await expect(workflow.resume()).rejects.toThrow(/resume.*unavailable/i)
  })
})

function specification(calls: string[]) {
  return {
    start: async (objective: string) => { calls.push(`start:${objective}`) },
    refine: async (clarification: string) => { calls.push(`refine:${clarification}`) },
    approveRequirements: async () => { calls.push('approve-requirements') },
    design: async () => { calls.push('design') },
    approveDesign: async () => { calls.push('approve-design') },
    generateTasks: async () => { calls.push('generate-tasks') },
  }
}
