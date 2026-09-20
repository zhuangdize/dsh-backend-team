import type { BackendTeamReactLike } from './client-overlay.js'
import type { ClientContext } from './client.js'
import type { ReviewWait } from './review-session.js'
import { createTeamSurfaceRenderer } from './a2ui/renderer.js'
import { teamSurface, type TeamComponent } from './a2ui/catalog.js'
import { createShadcnComponents } from './ui/primitives.js'
export function selectTeamQuestions(props: unknown): ReviewWait | null {
  return (props as { interactions?: ReviewWait[] }).interactions?.find(wait => wait.kind === 'question' && wait.payload.questions.length > 0 && wait.payload.questions.every(question => (question.header === '需求确认' || question.header === '需求变更' && question.id.startsWith('requirement-change:')) && !question.multiSelect)) ?? null
}
export function installTeamQuestions(context: ClientContext, react: BackendTeamReactLike) {
  const h = react.createElement
  const Surface = createTeamSurfaceRenderer(react)
  const ui = createShadcnComponents(react)
  const drafts = new Map<string, Array<{ selected: string; custom: string }>>()
  function Questions({ wait, input }: { wait: ReviewWait; input: unknown }) {
    const questions = wait.payload.questions
    const [answers, setAnswers] = react.useState(() => drafts.get(wait.key) ?? questions.map(() => ({ selected: '', custom: '' })))
    const [at, setAt] = react.useState(0)
    const [busy, setBusy] = react.useState(false)
    const [error, setError] = react.useState('')
    const [deferred, setDeferred] = react.useState(false)
    const [guard] = react.useState({ pending: false })
    const question = questions[at]!
    const answer = answers[at]!
    const change = (patch: Partial<typeof answer>) => setAnswers(previous => { const next = previous.map((value, index) => index === at ? { ...value, ...patch } : value); drafts.set(wait.key, next); return next })
    const submit = async () => {
      if (guard.pending) return
      if (answers.some(answer => !answer.selected && !answer.custom.trim())) { setError('请完成本组所有问题。'); return }
      guard.pending = true; setBusy(true); setError('')
      try {
        const receipt = await wait.respond({ ok: true, value: { sessionId: wait.sessionId, answer: { answers: questions.map((question, index) => ({ id: question.id, selected: answers[index]!.selected ? [answers[index]!.selected] : [], ...(answers[index]!.custom.trim() ? { custom: answers[index]!.custom.trim() } : {}) })) } } })
        if (!receipt.accepted) throw new Error('问题已更新，请查看最新问题。')
        drafts.delete(wait.key)
      } catch (cause) { guard.pending = false; setBusy(false); setError(cause instanceof Error ? cause.message : '提交失败') }
    }
    const nodes: TeamComponent[] = [
      { id: 'root', component: 'Column', children: ['question', ...(question.detail ? ['detail'] : []), ...(question.options?.length ? ['choices'] : []), 'comment', 'hint', 'actions'] },
      { id: 'question', component: 'Text', text: question.question },
      { id: 'comment', component: 'TextField', label: question.options?.length ? '补充说明（选填）' : '你的回答', value: { path: '/comment' } },
      { id: 'hint', component: 'Text', text: '回答不会自动批准方案，团队整理后会再次请你确认。', variant: 'caption' },
      { id: 'actions', component: 'Row', children: ['previous', 'defer', 'next'] },
      { id: 'defer', component: 'Button', text: '稍后回答', variant: 'ghost', action: { event: { name: 'defer' } } },
      { id: 'previous', component: 'Button', text: '上一题', action: { event: { name: 'previous' } } },
      { id: 'next', component: 'Button', text: busy ? '提交中…' : at === questions.length - 1 ? '提交回答' : '下一题', variant: 'default', action: { event: { name: at === questions.length - 1 ? 'submit-answers' : 'next' } } },
    ]
    if (question.detail) nodes.push({ id: 'detail', component: 'Text', text: question.detail, variant: 'caption' })
    if (question.options?.length) nodes.push({ id: 'choices', component: 'ChoicePicker', label: '请选择', options: question.options.map(option => ({ label: option.label, value: option.label })), value: { path: '/selection' } })
    if (deferred) return h('div', { className: 'bt-ui bt-composer', style: { padding: '8px 16px' } }, h('div', { className: 'bt-card' }, h('span', null, `${questions.length} 个问题待你确认 `), h(ui.Button, { onClick: () => setDeferred(false) }, '继续回答')), input)
    return h('div', { className: 'bt-ui bt-composer', style: { padding: '8px 16px' } }, h('section', { className: 'bt-card bt-question', 'aria-label': '逐题确认', style: { maxWidth: '640px', margin: '0 auto 12px' } }, h('div', { className: 'bt-question-top' }, h('strong', null, question.header ?? '需求确认'), h(ui.Badge, { tone: 'blue' }, `${at + 1} / ${questions.length}`)), at > 0 ? h('div', { className: 'bt-previous-answer' }, h('span', null, '上一题：' + (answers[at - 1]?.selected || answers[at - 1]?.custom)), h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setAt(value => value - 1) }, '修改')) : null, h(Surface, { surface: teamSurface('team-questions', nodes), selection: answer.selected, comment: answer.custom, onSelection: (selected: string) => change({ selected }), onComment: (custom: string) => change({ custom }), disabled: [...(at === 0 ? ['previous'] : []), ...(busy ? ['previous', 'next', 'submit-answers', 'selection', 'comment'] : []), ...(!answer.selected && !answer.custom.trim() ? ['next', 'submit-answers'] : [])], onAction: (action: string) => { if (action === 'defer') setDeferred(true); else if (action === 'previous') setAt(value => Math.max(0, value - 1)); else if (action === 'next') setAt(value => Math.min(questions.length - 1, value + 1)); else void submit() } }), error ? h('p', { role: 'alert' }, error) : null), input)
  }
  const dispose = context.slots.inject('conversation.composer', () => context.slots.register({ name: 'conversation.composer', priority: -99, select: selectTeamQuestions }, props => {
    const { matched: wait } = props as { matched: ReviewWait; renderSlot?: (name: string, props: unknown) => unknown }
    return h(Questions, { key: wait.key, wait, input: null })
  }))
  return () => { dispose(); drafts.clear() }
}
