import { FileText, CircleCheck } from './ui/icons.js'
import { createShadcnComponents } from './ui/primitives.js'
import type { BackendTeamReactLike } from './client-overlay.js'
import type { ClientContext } from './client.js'
import { createReviewSessionStore, type ReviewWait, type ReviewSessionStore } from './review-session.js'
import { createTeamSurfaceRenderer } from './a2ui/renderer.js'
import { teamSurface, readAgentPresentation } from './a2ui/catalog.js'
export function selectTeamReview(props: unknown): ReviewWait | null {
  const interactions = (props as { interactions?: ReviewWait[] }).interactions
  return interactions?.find(wait => wait.kind === 'question' && wait.payload.questions.length === 1 && wait.payload.questions[0]?.id.startsWith('backend-team-review:')) ?? null
}
export function installTeamReview(context: ClientContext, react: BackendTeamReactLike, openResources: () => void, store: ReviewSessionStore = createReviewSessionStore()) {
  const h = react.createElement
  const Surface = createTeamSurfaceRenderer(react)
  const ui = createShadcnComponents(react)
  function Card({ wait, input }: { wait: ReviewWait; input: unknown }) {
    const [, update] = react.useState(0)
    react.useEffect(() => store.subscribe(() => update(value => value + 1)), [])
    react.useEffect(() => { store.attach(wait); return () => store.detach(wait) }, [wait.key])
    const entry = store.get(wait.sessionId)
    const question = wait.payload.questions[0]!
    const presentation = readAgentPresentation(question.detail)
    return h('div', { className: 'bt-ui bt-composer' }, h('div', { className: 'bt-card bt-review-entry' }, h(entry?.status === 'submitted' ? CircleCheck : FileText, { 'aria-hidden': true }), h('div', { className: 'bt-entry-copy' }, h('strong', null, entry?.status === 'submitted' ? entry.outcome === 'feedback' ? '修改意见已提交' : '确认已提交' : question.header ?? '方案待确认'), h('p', { className: 'bt-muted' }, entry?.status === 'submitted' ? '处理结果以团队后续状态为准。' : '查看完整方案后确认，也可以提交修改意见。'), presentation ? h(Surface, { surface: presentation, onAction: () => {} }) : null), h(ui.Button, { variant: entry?.status === 'submitted' ? 'outline' : 'default', onClick: openResources }, entry?.status === 'submitted' ? '查看文档' : '查看并确认')), input)
  }
  return context.slots.inject('conversation.composer', () => context.slots.register({ name: 'conversation.composer', priority: -100, select: selectTeamReview }, props => {
    const { matched: wait } = props as { matched: ReviewWait; renderSlot?: (name: string, props: unknown) => unknown }
    return h(Card, { key: wait.key, wait, input: null })
  }))
}
export function createReviewFooter(react: BackendTeamReactLike, store: ReviewSessionStore, close: () => void) {
  const h = react.createElement
  const Surface = createTeamSurfaceRenderer(react)
  return function Footer({ sessionId }: { sessionId: string }) {
    const [, update] = react.useState(0)
    react.useEffect(() => store.subscribe(() => update(value => value + 1)), [])
    const entry = store.get(sessionId)
    if (!entry) return null
    if (entry.status === 'expired') return h('footer', { className: 'bt-review-footer bt-muted' }, '此确认已结束，请在聊天中请求查看最新方案。')
    if (entry.status === 'submitted') return h('footer', { className: 'bt-review-footer', role: 'status' }, h('div', { className: 'bt-receipt' }, h(CircleCheck, { 'aria-hidden': true }), h('strong', null, entry.outcome === 'feedback' ? '修改意见已提交' : '确认已提交')), entry.outcome === 'feedback' ? h('p', null, entry.comment) : null, h('p', { className: 'bt-muted' }, '正在核对后端处理结果，以团队后续状态为准。'))
    const busy = entry.status === 'sending'
    const surface = teamSurface('review-decision', [
      { id: 'root', component: 'Column', children: ['heading', 'comment', 'hint', 'actions'] },
      { id: 'heading', component: 'Text', text: entry.wait.payload.questions[0]?.header ?? '方案确认', variant: 'heading' },
      { id: 'comment', component: 'TextField', label: '补充意见（选填）', value: { path: '/comment' } },
      { id: 'hint', component: 'Text', text: '提交意见后，团队修订方案并再次请你确认。', variant: 'caption' },
      { id: 'actions', component: 'Row', children: ['defer', 'feedback', 'approve'] },
      { id: 'defer', component: 'Button', text: '稍后处理', variant: 'outline', action: { event: { name: 'defer' } } },
      { id: 'feedback', component: 'Button', text: '提交修改意见', action: { event: { name: 'submit-feedback' } } },
      { id: 'approve', component: 'Button', text: busy ? '提交中…' : '确认通过', variant: 'default', action: { event: { name: 'approve' } } },
    ])
    return h('footer', { className: 'bt-review-footer', 'aria-label': '方案审批' }, h(Surface, { surface, comment: entry.comment, onComment: (value: string) => store.comment(sessionId, value), disabled: [...(busy ? ['comment', 'approve', 'submit-feedback'] : []), ...(!entry.inspectedHash ? ['approve', 'submit-feedback'] : []), ...(entry.comment.trim() ? ['approve'] : ['submit-feedback'])], onAction: (action: string) => { if (action === 'defer') close(); else void store.submit(sessionId, action === 'approve' ? 'approve' : 'feedback').catch(() => {}) } }), entry.error ? h('p', { role: 'alert' }, entry.error) : null, h('p', { className: 'bt-muted', style: { marginBottom: 0 } }, '关闭后保留草稿 · 确认仅对当前版本生效'))
  }
}
