import { expect, it, vi } from 'vitest'
import { selectTeamReview } from '../src/task-review-card.js'
import { createReviewSessionStore } from '../src/review-session.js'
import { selectTeamQuestions } from '../src/team-question-card.js'
function wait(key = 'one') { return { kind: 'question', key, sessionId: 'session', payload: { questions: [{ id: 'backend-team-review:' + key, question: '确认需求' }] }, respond: vi.fn(async () => ({ accepted: true })) } }
it('leaves ordinary questions to the native host and selects only team questions', () => {
  expect(selectTeamReview({ interactions: [{ kind: 'question', payload: { questions: [{ id: 'Q1' }] } }] })).toBeNull()
  expect(selectTeamQuestions({ interactions: [{ kind: 'question', payload: { questions: [{ id: 'Q1' }] } }] })).toBeNull()
  expect(selectTeamReview({ interactions: [wait()] })?.key).toBe('one')
})
it('requires inspected documents and never treats comments as approval', async () => {
  const store = createReviewSessionStore(); const carrier = wait(); store.attach(carrier)
  await expect(store.submit('session', 'approve')).rejects.toThrow('查看')
  store.inspected('session', 'one', 'hash'); store.comment('session', '增加负责人')
  await expect(store.submit('session', 'approve')).rejects.toThrow('修改意见')
  await Promise.all([store.submit('session', 'feedback'), store.submit('session', 'feedback')])
  expect(carrier.respond).toHaveBeenCalledTimes(1)
  expect(carrier.respond).toHaveBeenCalledWith({ ok: true, value: { sessionId: 'session', answer: { answers: [{ id: 'backend-team-review:one', selected: [], custom: '增加负责人' }] } } })
  expect(store.get('session')?.status).toBe('submitted')
})
it('keeps drafts across panel remounts but resets them on a new wait', () => {
  const store = createReviewSessionStore(); store.attach(wait()); store.comment('session', 'draft'); store.attach(wait())
  expect(store.get('session')?.comment).toBe('draft')
  store.attach(wait('two')); expect(store.get('session')?.comment).toBe('')
  store.inspected('session', 'one', 'old'); expect(store.get('session')?.inspectedHash).toBeUndefined()
})
it('restores controls when the native receipt rejects a stale response', async () => {
  const store = createReviewSessionStore(); const carrier = wait(); carrier.respond.mockResolvedValue({ accepted: false }); store.attach(carrier); store.inspected('session', 'one', 'hash')
  await store.submit('session', 'approve')
  expect(store.get('session')?.status).toBe('pending'); expect(store.get('session')?.error).toContain('失效')
})
it('restores the same wait after remount but requires preview again after refresh', async () => {
  const store = createReviewSessionStore(); const carrier = wait()
  store.attach(carrier); store.comment('session', '保留意见'); store.inspected('session', 'one', 'hash')
  store.detach(carrier); expect(store.get('session')?.status).toBe('expired')
  store.attach(carrier); expect(store.get('session')?.status).toBe('pending')
  expect(store.get('session')?.comment).toBe('保留意见')
  store.clearInspection('session', 'one')
  await expect(store.submit('session', 'feedback')).rejects.toThrow('查看')
  expect(carrier.respond).not.toHaveBeenCalled()
})

it('routes requirement-change confirmation to the approved team question component', () => {
  const carrier = { ...wait(), payload: { questions: [{ id: 'requirement-change:123', header: '需求变更', question: '修改当前任务？', detail: '撤回旧审批并重新确认' }] } }
  expect(selectTeamQuestions({ interactions: [carrier] })).toBe(carrier)
  expect(selectTeamQuestions({ interactions: [{ ...carrier, payload: { questions: [{ ...carrier.payload.questions[0], id: 'unrelated' }] } }] })).toBeNull()
})
