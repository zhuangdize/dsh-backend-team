import { expect, it } from 'vitest'
import { AgentPresentationSchema, TeamSurfaceSchema, teamSurface } from '../src/a2ui/catalog.js'
it('accepts bounded agent-authored display content in the versioned custom catalog', () => {
  expect(AgentPresentationSchema.safeParse(teamSurface('test', [{ id: 'root', component: 'Text', text: '方案待确认' }])).success).toBe(true)
})
it('rejects executable content, unknown components, callbacks and agent approval buttons', () => {
  const surface = teamSurface('test', [{ id: 'root', component: 'Text', text: 'hello' }])
  expect(TeamSurfaceSchema.safeParse([{ ...surface[0] }, { version: 'v0.9.1', updateComponents: { surfaceId: 'test', components: [{ id: 'root', component: 'Script', code: 'alert(1)' }] } }]).success).toBe(false)
  expect(TeamSurfaceSchema.safeParse([surface[0], { ...surface[1], updateComponents: { surfaceId: 'test', components: [{ id: 'root', component: 'Text', text: 'x', onClick: 'fetch()' }] } }]).success).toBe(false)
  expect(AgentPresentationSchema.safeParse(teamSurface('test', [{ id: 'root', component: 'Button', text: '批准', action: { event: { name: 'approve' } } }])).success).toBe(false)
})
it('rejects cycles, mismatched surfaces, duplicate ids and missing references', () => {
  expect(() => teamSurface('test', [{ id: 'root', component: 'Column', children: ['root'] }])).toThrow()
  expect(() => teamSurface('test', [{ id: 'root', component: 'Column', children: ['absent'] }])).toThrow()
  expect(() => teamSurface('test', [{ id: 'root', component: 'Text', text: 'a' }, { id: 'root', component: 'Text', text: 'b' }])).toThrow()
  const valid = teamSurface('test', [{ id: 'root', component: 'Text', text: 'a' }]); valid[1].updateComponents.surfaceId = 'other'; expect(TeamSurfaceSchema.safeParse(valid).success).toBe(false)
})
