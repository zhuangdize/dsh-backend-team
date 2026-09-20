import { TeamSurfaceSchema, type TeamSurface, type TeamActionSchema } from './catalog.js'
import type { z } from 'zod'
import type { BackendTeamReactLike } from '../client-overlay.js'
import { createShadcnComponents } from '../ui/primitives.js'
export function createTeamSurfaceRenderer(react: BackendTeamReactLike) {
  const h = react.createElement
  const ui = createShadcnComponents(react)
  return function Surface({ surface, comment = '', onComment, selection = '', onSelection, onAction, disabled = [] }: { surface: TeamSurface; comment?: string; onComment?: (value: string) => void; selection?: string; onSelection?: (value: string) => void; onAction: (action: z.infer<typeof TeamActionSchema>) => void; disabled?: string[] }) {
    const parsed = TeamSurfaceSchema.safeParse(surface)
    if (!parsed.success) return h('p', { role: 'status' }, '此内容暂时无法展示，请在对话中查看说明。')
    const nodes = new Map(parsed.data[1].updateComponents.components.map(node => [node.id, node]))
    const render = (id: string): unknown => {
      const node = nodes.get(id)!
      if (node.component === 'Column' || node.component === 'Row') return h('div', { key: id, className: node.component === 'Row' ? 'bt-surface-row' : 'bt-surface-column' }, ...node.children.map(render))
      if (node.component === 'Text') return h(node.variant === 'heading' ? 'strong' : 'span', { key: id, className: node.variant === 'caption' ? 'bt-muted' : undefined }, node.text)
      if (node.component === 'Badge') return h(ui.Badge, { key: id }, node.text)
      if (node.component === 'ChoicePicker') return h('fieldset', { key: id, disabled: disabled.includes('selection'), className: 'bt-choices' }, h('legend', null, node.label), ...node.options.map(option => h('label', { key: option.value, className: 'bt-choice', 'data-selected': selection === option.value }, h('input', { type: 'radio', name: parsed.data[0].createSurface.surfaceId + '-' + id, value: option.value, checked: selection === option.value, onChange: () => onSelection?.(option.value) }), option.label)))
      if (node.component === 'TextField') return h('label', { key: id, className: 'bt-field' }, node.label, h(ui.Textarea, { 'aria-label': node.label, value: comment, maxLength: 8000, disabled: disabled.includes('comment'), onChange: (event: { target: { value: string } }) => onComment?.(event.target.value), placeholder: '需要调整的地方，请在这里说明。' }), h('span', { className: 'bt-char-count', 'aria-hidden': true }, comment.length + ' / 8000'))
      return h(ui.Button, { key: id, variant: node.variant ?? 'outline', disabled: disabled.includes(node.action.event.name), onClick: () => onAction(node.action.event.name) }, node.text)
    }
    return h('div', { className: 'bt-ui', 'data-a2ui-catalog': parsed.data[0].createSurface.catalogId }, render('root'))
  }
}
