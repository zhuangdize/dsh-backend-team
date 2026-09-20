import { z } from 'zod'

export const WorkflowQuestionSchema = z.object({ id: z.string().min(1).max(80), question: z.string().min(1).max(2000), options: z.array(z.object({ label: z.string().min(1).max(200), description: z.string().max(500).optional() }).strict()).min(1).max(6).optional() }).strict()
export type WorkflowQuestion = z.infer<typeof WorkflowQuestionSchema>
export interface UserQuestionRequest { agent: unknown; signal: AbortSignal; questions: Array<WorkflowQuestion & { header?: string; detail?: string; multiSelect?: boolean }> }
export interface UserQuestionAnswer { answers: Array<{ id: string; selected: string[]; custom?: string }> }

/** Only the explicitly pending section participates; resolved Q IDs are not asked again. */
export function pendingWorkflowQuestions(result: unknown): WorkflowQuestion[] {
  const parsed = z.object({ artifactPreview: z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })) }) }).safeParse(result)
  const document = parsed.success ? parsed.data.artifactPreview.files.find(file => file.path.endsWith('/clarification.md'))?.content : undefined
  if (!document) return []
  const structured = document.match(/<!-- backend-team:questions\s*\n([\s\S]*?)\n-->/u)
  if (structured) return z.array(WorkflowQuestionSchema).max(8).parse(JSON.parse(structured[1]!))
  const section = document.match(/^##\s+(?:仍需确认的问题|待用户确认的问题|待确认问题|Remaining Questions|Open Questions)\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/mu)?.[1]
  if (!section) return []
  return [...section.matchAll(/^\s*\d+\.\s*\*{0,2}(Q\d+)[^：:\n]*[：:]\s*([\s\S]*?)(?=\n\s*\d+\.|\n\s*\n|$(?![\s\S]))/gmu)].map(match => ({ id: match[1]!, question: match[2]!.replaceAll('**','').trim(), options: [{ label: '按方案中的建议处理' }, { label: '暂不决定，继续讨论' }] })).slice(0,8)
}

export function formatWorkflowAnswers(questions: WorkflowQuestion[], answer: UserQuestionAnswer): string {
  if (answer.answers.length !== questions.length || new Set(answer.answers.map(item => item.id)).size !== questions.length) throw new Error('请完成本组所有问题。')
  return questions.map(question => {
    const item = answer.answers.find(item => item.id === question.id)
    if (!item || (!item.custom?.trim() && item.selected.length !== 1) || item.selected.some(label => !question.options?.some(option => option.label === label))) throw new Error('问题回答不完整或选项已变化。')
    return `${question.id}: ${question.question}\n用户回答：${[item.selected.join('、'), item.custom?.trim()].filter(Boolean).join('\n补充说明：')}`
  }).join('\n\n')
}
