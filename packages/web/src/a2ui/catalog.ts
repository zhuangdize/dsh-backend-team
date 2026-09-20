import { z } from 'zod'
/** A deliberately restricted custom catalog, carried in A2UI v0.9.1 envelopes. */
export const TEAM_CATALOG = 'urn:dsh:backend-team:catalog:1'
const Id = z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/u)
const Text = z.string().max(4000)
export const TeamActionSchema = z.enum(['open-review', 'approve', 'submit-feedback', 'defer', 'previous', 'next', 'submit-answers'])
export const TeamComponentSchema = z.discriminatedUnion('component', [
  z.object({ id: Id, component: z.literal('Text'), text: Text, variant: z.enum(['body', 'heading', 'caption']).optional() }).strict(),
  z.object({ id: Id, component: z.literal('Badge'), text: Text }).strict(),
  z.object({ id: Id, component: z.literal('Column'), children: z.array(Id).max(32) }).strict(),
  z.object({ id: Id, component: z.literal('Row'), children: z.array(Id).max(8) }).strict(),
  z.object({ id: Id, component: z.literal('Button'), text: Text, variant: z.enum(['default', 'outline', 'ghost']).optional(), action: z.object({ event: z.object({ name: TeamActionSchema }).strict() }).strict() }).strict(),
  z.object({ id: Id, component: z.literal('TextField'), label: Text, value: z.object({ path: z.literal('/comment') }).strict() }).strict(),
  z.object({ id: Id, component: z.literal('ChoicePicker'), label: Text, options: z.array(z.object({ label: Text, value: Text }).strict()).max(6), value: z.object({ path: z.literal('/selection') }).strict() }).strict(),
])
export type TeamComponent = z.infer<typeof TeamComponentSchema>
const Create = z.object({ version: z.literal('v0.9.1'), createSurface: z.object({ surfaceId: Id, catalogId: z.literal(TEAM_CATALOG) }).strict() }).strict()
const Update = z.object({ version: z.literal('v0.9.1'), updateComponents: z.object({ surfaceId: Id, components: z.array(TeamComponentSchema).min(1).max(64) }).strict() }).strict()
export const TeamSurfaceSchema = z.tuple([Create, Update]).superRefine((messages, ctx) => {
  if (messages[0].createSurface.surfaceId !== messages[1].updateComponents.surfaceId) ctx.addIssue({ code: 'custom', message: 'surface mismatch' })
  const components = messages[1].updateComponents.components
  const map = new Map(components.map(component => [component.id, component]))
  if (map.size !== components.length || !map.has('root')) ctx.addIssue({ code: 'custom', message: 'duplicate component or missing root' })
  const visited = new Set<string>()
  const visit = (id: string, ancestors: Set<string>, depth: number) => {
    const component = map.get(id)
    if (!component || ancestors.has(id) || visited.has(id) || depth > 8) { ctx.addIssue({ code: 'custom', message: 'invalid component graph' }); return }
    visited.add(id)
    if ('children' in component) for (const child of component.children) visit(child, new Set([...ancestors, id]), depth + 1)
  }
  visit('root', new Set(), 0)
})
export type TeamSurface = z.infer<typeof TeamSurfaceSchema>
/** Agent content cannot introduce, rename or impersonate an approval control. */
export const AgentPresentationSchema = TeamSurfaceSchema.refine(surface => surface[1].updateComponents.components.every(node => ['Text', 'Badge', 'Column', 'Row'].includes(node.component)) && JSON.stringify(surface).length <= 8000, 'agent presentation must be bounded read-only content')
export function readAgentPresentation(detail: string | undefined): TeamSurface | undefined {
  const marker = detail?.match(/<!-- backend-team:a2ui\n([\s\S]*?)\n-->/u)
  if (!marker) return
  try { const result = AgentPresentationSchema.safeParse(JSON.parse(marker[1]!)); return result.success ? result.data : undefined } catch { return }
}
export function teamSurface(surfaceId: string, components: TeamComponent[]): TeamSurface {
  return TeamSurfaceSchema.parse([{ version: 'v0.9.1', createSurface: { surfaceId, catalogId: TEAM_CATALOG } }, { version: 'v0.9.1', updateComponents: { surfaceId, components } }])
}
