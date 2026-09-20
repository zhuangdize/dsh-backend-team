import { expect, it } from 'vitest'
import { pendingWorkflowQuestions, formatWorkflowAnswers } from '../src/workflow-questions.js'
it('reads legacy pending questions but excludes confirmed questions', () => {
  const result = { artifactPreview: { files: [{ path: 'specs/task/clarification.md', content: '## 已确认\n1. **Q0**：旧问题\n\n## 仍需确认的问题\n\n1. **Q1（最高优先）**：字段清单？\n2. **Q2**：权限范围？\n\n回复方式建议：回答即可。' }] } }
  expect(pendingWorkflowQuestions(result).map(q => q.id)).toEqual(['Q1','Q2'])
  expect(pendingWorkflowQuestions(result)[0]?.question).toBe('字段清单？')
})
it('does not accept incomplete or duplicate user answers', () => {
  const questions = [{ id: 'Q1', question: '范围？' }, { id: 'Q2', question: '权限？' }]
  expect(() => formatWorkflowAnswers(questions, { answers: [{ id: 'Q1', selected: [], custom: 'a' }] })).toThrow()
  expect(() => formatWorkflowAnswers(questions, { answers: [{ id: 'Q1', selected: [], custom: 'a' },{ id: 'Q1', selected: [], custom: 'b' }] })).toThrow()
})
